// ALARM PLUGIN — node_status sections. NOT CORE.
//
// Peter, 2026-07-29: "node-dash exists with or without the alarm. alarm is
// addative, it changes nothing about node communications, stats, messages …
// the alarm is a plugin … alarm related code is supposed to be self contained
// and not mixed in with core."
//
// This file exists because commit 1f8842b put all of the below INSIDE
// src/node-status.js, a core module that builds node_status for ANY node in the
// mesh. That gave core a hard `pac-host` import and 164 lines of alarm logic,
// which is exactly what reference/alarm-integration/INVENTORY.md forbids:
// "code must not be copied back into shared dashboard modules."
//
// The contract now runs one way only:
//   core  →  registerNodeSection(fn)     — knows nothing about what fn is for
//   here  →  reads pac-host, returns a section or null
// A null contributes nothing, so "the plugin is absent" and "the plugin has
// nothing to say about this node" are the same code path. Delete this file and
// its one import in index.js and node-dash is unchanged.
//
// Everything below was MOVED VERBATIM from node-status.js. The payload must be
// byte-identical, and the only way to be sure of that is to change nothing.
//
// See docs/PLUGIN_BOUNDARY_SPEC.md and docs/REACHABILITY_SPEC.md.

import { stmts } from './db.js';
import {
  fmtRssi, fmtSnr, fmtUptime, fmtAgo, fmtUntil, fmtCount,
} from './format.js';
import { field, compact, registerNodeSection } from './node-status.js';
import { unitForNum } from './pac-host.js';
import { resolveDeviceLabel } from './node-label.js';

// ─── Reachability ────────────────────────────────────────────────────────────
//
// The ONE section not sourced from our own SQLite. pac-host owns every fact
// here; we render them and add nothing (docs/REACHABILITY_SPEC.md). Present
// only when pac-host holds a unit for this num — absent for every other node,
// per the existing rule that a section appears only if it has data.
//
// JOINED HERE, NOT IN THE BROWSER. pac-host's roster reaches the browser on a
// different WS message (pac_host_status); merging the two client-side to decide
// what a tile says would be the browser deciding, and would create a second code
// path for one displayed value — exactly what the node_status RPC exists to
// prevent.
//
// EVERY FIELD STATES ITS KIND AND ITS AGE, OR STATES THAT IT HAS NEITHER. The
// counter-example is on this same page: the Hops tile renders a value verified
// on 14 Jul at live-data weight. Several fields below carry NO age because
// pac-host does not record when they were established — under the mechanical
// <field>At convention an absent sibling is detectable, so they render undated
// rather than borrowing another field's instant or being stamped with now().

// pac-host instants are epoch MILLISECONDS; fmtAgo/fmtUntil/fmtStamp take epoch
// SECONDS. The divide happens once, here, at the boundary. Missing it is silent
// and produces a plausible wrong answer — it has cost this repo a day before.
const msToSec = ms =>
  (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) ? Math.floor(ms / 1000) : null;

const WAKE_SOURCE_TEXT = {
  'always-listening': 'never sleeps — a command goes now',
  'device':           'schedule reported by the device',
  'measured':         'schedule derived from observed wakes',
  'unknown':          'never measured, never reported',
};

// The four states are NOT equally strong, and the page must not flatten them.
// A config claim is not evidence that anything reached the unit — the argument
// that got services to split this field (their commit 35b274a).
const AWAKE_SOURCE_TEXT = {
  'heard':         'heard inside its window',
  'device-stated': 'device says sleep is off — not proof we reached it',
  'inferred':      'inferred from silence',
  'unknown':       'never heard',
};

// pac-host names radios by !hex or BLE MAC; every other surface in this app
// says OMNI / YAGI. resolveDeviceLabel is that SSOT — user alias first, then
// short_name, then an honest fallback — and it takes either form, so the same
// radio cannot be called two different things on two parts of one page.

// acks is a SINGLE object summarising the most recent request of ANY verb —
// which is what "can we reach it" asks. NULL means NEVER COMMANDED, and renders
// as unknown, never as failure: Peter must be able to tell "not yet asked" from
// "asked and got nothing" at a glance.
function deliveryField(acks) {
  if (!acks) {
    return field('Delivery', 'never', 'not yet asked', null,
                 'no command has been sent to this unit');
  }
  const { verb, sends = 0, transmitted = 0, notSent = 0, unknownSent = 0,
          delivered = 0, settledAt } = acks;

  // FIVE numbers, never one boolean. `sends` counts POSTs mesh-gw ACCEPTED, not
  // transmissions: 15 of GARG's 131 sends in one day never left the radio and
  // every one was counted as a send (services, 2026-07-29). A single success
  // flag would have shown a green tick through the whole of 2026-07-28, while
  // every send was being refused.
  let text;
  if (delivered   > 0) text = 'delivered';
  else if (transmitted > 0) text = 'sent, no ack';
  else if (notSent     > 0) text = 'refused';
  else if (unknownSent > 0) text = 'sent, status unknown';
  else                      text = 'queued';

  const bits = [];
  if (verb) bits.push(verb);
  // Only stated when it disagrees — "1/1 left the radio" is noise, and the gap
  // is the whole point.
  if (sends > 0 && transmitted < sends) bits.push(`${transmitted}/${sends} left the radio`);
  const ago = fmtAgo(msToSec(settledAt));
  if (ago) bits.push(ago);

  return field('Delivery', text, text, null, bits.join(' · ') || null);
}

// nextWake:null has TWO meanings and wakeSource is what tells them apart.
// "always-listening" means send NOW; "unknown" means we have no idea. Treating
// them the same is a real bug — it is why the field exists.
function nextWindowField(u) {
  if (u.wakeSource === 'always-listening') {
    return field('Next window', 'always', 'always listening', null,
                 WAKE_SOURCE_TEXT['always-listening']);
  }
  const until = fmtUntil(msToSec(u.nextWake));
  if (until) {
    return field('Next window', u.nextWake, until, null, WAKE_SOURCE_TEXT[u.wakeSource] ?? null);
  }
  return field('Next window', 'unknown', 'unknown', null,
               WAKE_SOURCE_TEXT[u.wakeSource] ?? 'no schedule measured or reported');
}

// null and 0 mean DIFFERENT things and must not print the same string.
//   null — a category statement: an always-listening unit does not wake, so
//          there is no denominator and no percentage exists to compute. The old
//          110% came from counting telemetry transmissions against expected
//          wakes, comparing two different things. Render nothing at all.
//   0    — a real denominator that happens to be zero: nothing expected yet.
// Dividing by either is a defect, so neither path computes a percentage.
function wakeReliabilityField(u) {
  const exp  = u.wakesExpected;
  if (exp == null) return null;
  const seen  = u.wakesSeen ?? 0;
  const since = fmtAgo(msToSec(u.wakesSince));
  if (exp === 0) {
    return field('Wake reliability', seen, `${seen} seen`, null,
                 since ? `none expected yet · since ${since}` : 'none expected in this window yet');
  }
  return field('Wake reliability', seen, `${seen} of ${exp}`, null,
               since ? `since ${since}` : null);
}

// perRadio is passed in rather than re-queried: the header's Signal tile is
// computed from the SAME array, which is what makes header and section agree by
// construction instead of by convention.
function buildReachabilitySection(num, perRadio) {
  const u = unitForNum(num);
  if (!u) return null;

  const fields = compact([
    deliveryField(u.acks),
    nextWindowField(u),
    // No age: pac-host does not record when beat was established. Priority-one
    // on our ask to them, because nextWake is computed FROM beat — a stale beat
    // yields a confidently wrong countdown, which is worse than no answer.
    field('Beat', u.beat, fmtUptime(msToSec(u.beat)), null,
          u.beatSource ? `${u.beatSource}-reported` : null),
    field('Window', u.windowMs, fmtUptime(msToSec(u.windowMs)), null,
          // Published rather than omitted even when merely assumed: a blank is
          // indistinguishable from "we never asked", so an assumed value that
          // SAYS it is assumed is strictly more information than nothing.
          u.windowMsSource ?? u.windowSource ?? null),
    wakeReliabilityField(u),
    field('Awake', u.awake == null ? 'unknown' : u.awake,
          u.awake == null ? 'unknown' : (u.awake ? 'yes' : 'no'), null,
          AWAKE_SOURCE_TEXT[u.awakeSource] ?? null),
    field('TX radio', u.txRadio?.id ?? null,
          resolveDeviceLabel(u.txRadio?.addr || u.txRadio?.id) || null, null,
          u.txRadio?.state ? String(u.txRadio.state).toLowerCase() : null),
    // OUR signal_history, not pac-host's radios{}. services conceded per-radio
    // rssi/snr to us (xsession [data-ownership-3categories]): "we retain a
    // per-radio model internally because it drives RADIO SELECTION — that is a
    // mesh decision, not a display one. It is not published for rendering and it
    // is not a competing answer to yours." Rendering theirs added a third source
    // to a page that already had two too many, and it covers only the alarm
    // units. These are the same rows the header's Signal tile is computed from.
    ...perRadio.map(r => {
      const text = compact([fmtRssi(r.rssi), fmtSnr(r.snr)]).join(' · ');
      return field(`Heard by ${resolveDeviceLabel(r.rx_device)}`, text || null, text || null,
                   r.ts, `direct ${fmtAgo(r.ts)}`);
    }),
  ]);

  if (!fields.length) return null;
  return { id: 'reachability', kind: 'value_grid', title: 'Reachability', fields };
}

// Self-registration. `ctx` carries CORE data already computed by
// buildNodeStatus — perRadio comes from stmts.latestDirectPerRadio and is the
// SAME array the header's Signal tile is built from. Re-querying it here would
// turn the header↔section agreement (cc2e55f) back into a coincidence.
registerNodeSection((num, ctx) => buildReachabilitySection(num, ctx.perRadio));
