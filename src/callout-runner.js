// callout-runner — the thing that actually pulls the trigger.
//
// The engine in `callout.js` decides and sends. Until this existed, nothing
// called it: every guard was correct and no callout could ever happen. A
// feature that cannot fire is not shipped, it is only written.
//
// WHY A CADENCE AND NOT A PACKET HANDLER. "Strike while the iron is hot" reads
// like it belongs on reception, but hanging a transmit decision off every
// inbound packet means evaluating a send hundreds of times a minute and
// depending on guard order to stop it. A sweep is cheaper, is rate-limited by
// construction, and the heat is already encoded in `heard_within_h` — a node
// heard on LoRa in the last two hours IS the hot iron, whether we notice it at
// reception or two minutes later.
//
// It is a WORKER in Peter's sense: it runs itself on a cadence. Nothing hooks
// into it. See docs/modules/hooks.md.

import db, { getConfig } from './db.js';
import { calloutConfig, evaluate, callout } from './callout.js';
import { dashMode, transmitterForMode, modeName } from './dash-mode.js';
import { haversine } from './utils.js';

// boot_settle_ms — the node list is still filling from the gw on boot, and a
// callout chosen from a half-built list picks the wrong node. Basis: observed
// time for the list to stop growing after a restart.
//
// Declared and overridable — Peter, 2026-08-04: "all timings need to be vars.
// some if not all will be selected to be configurables / knobs."
const TIMING_DEFAULTS = { boot_settle_ms: 120_000 };
const timing = () => ({ ...TIMING_DEFAULTS, ...(getConfig('callout_timing', {}) || {}) });


function homeLatLon() {
  const r = db.prepare(`
    SELECT (SELECT CAST(value AS REAL) FROM config WHERE key='home.lat') lat,
           (SELECT CAST(value AS REAL) FROM config WHERE key='home.lon') lon`).get();
  return (r && Number.isFinite(r.lat) && r.lat !== 0) ? r : null;
}

/** One sweep: find the best eligible target and call out to it, or do nothing.
 *
 *  AT MOST ONE PER SWEEP. Combined with the daily ceiling and the per-target
 *  cooldown, that is what keeps this from ever becoming a burst — §8's "never
 *  two callouts in flight" is enforced in the engine, and this never even
 *  offers it a second.
 */
export async function sweepCallouts({ dryRun = false } = {}) {
  const c = calloutConfig();
  if (!c.enabled) return { skipped: 'disabled' };

  const home = homeLatLon();
  if (!home) return { skipped: 'no home position' };

  // Only nodes we have heard ON AIR recently are worth considering; the engine
  // re-checks this, but filtering here keeps the sweep to a handful of rows
  // rather than the whole node table.
  const hot = db.prepare(`
    SELECT DISTINCT r.from_num AS num
      FROM relay_observation r
     WHERE r.transport = 'TRANSPORT_LORA'
       AND r.ts > strftime('%s','now') - ? * 3600`).all(c.heard_within_h);
  if (!hot.length) return { skipped: 'nothing heard on LoRa recently' };

  const candidates = [];
  for (const { num } of hot) {
    const n = db.prepare(
      'SELECT num, long_name, short_name, lat, lon FROM nodes WHERE num = ?').get(num);
    if (!n?.lat || n.lat === 0) continue;
    const v = evaluate(n, { home });
    if (!v.ok) continue;
    candidates.push({ node: n, verdict: v, km: haversine(home.lat, home.lon, n.lat, n.lon) });
  }
  if (!candidates.length) return { skipped: 'no candidate passed the guards', considered: hot.length };

  // FURTHEST FIRST. A callout is the most expensive probe we have — it spends
  // social capital, not just airtime — so it goes to the target that would tell
  // us the most, which is the one nearest the edge of what we can reach.
  candidates.sort((a, b) => b.km - a.km);
  const pick = candidates[0];

  // The radio is DASH MODE's decision, not this module's. Peter's standing rule:
  // dash mode owns every per-mode behaviour including which radio transmits.
  const mode = modeName(dashMode.value);
  const gatewayNodeId = transmitterForMode(mode, {});

  const res = await callout(pick.node, { home, gatewayNodeId, dryRun });
  return { considered: hot.length, eligible: candidates.length,
           target: pick.node.short_name || pick.node.num, km: Math.round(pick.km), res };
}

/** Cadence.
 *
 *  Deliberately slower than the mission loop. A callout asks a HUMAN for their
 *  attention, and the polite interval for that is measured in tens of minutes,
 *  not the 180 s a traceroute gets. The daily ceiling would stop a faster sweep
 *  anyway; this makes the intent explicit rather than leaving the ceiling to do
 *  the work.
 */
export function startCalloutRunner() {
  const mins = Math.min(720, Math.max(5, Number(getConfig('callout.every_min', 20)) || 20));
  const tick = () => {
    sweepCallouts().catch(e => console.error(`[callout] sweep failed: ${e.message}`));
  };
  setTimeout(tick, timing().boot_settle_ms);
  setInterval(tick, mins * 60_000);
}
