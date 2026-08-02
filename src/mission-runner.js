// THE ACTUATOR. Everything else in the observatory reports; this one acts.
//
// Peter, 2026-08-02: "It seems you think this entire module is simply a
// reporting module, is passive and not actively trying to push our boundaries."
// He was right. Four inference panels had been built and nothing dispatched.
//
// And: "the traceroute should be used by us, when a discovery is in progress"
// and "if a traceroute was last done 4 days ago, then our entire page is dead
// and old data. traceroute is our primary tool."
//
// He is right about that too. Every panel on the board derives from
// traceroute_history, whose last real activity was 27 July — traceroute.enabled
// was set false and the rate fell from ~1,000/day to 1. The board was reporting
// a five-day-old mesh as if it were current.
//
// ─── WHY THIS REPLACES A REACTIVE PROBER ────────────────────────────────────
//
// passive-tracer traces whatever it has just HEARD. That is why 5,046 attempts
// went to 335 targets that have never answered — we keep hearing them, so it
// keeps asking — while 213 positioned nodes were never tried once. A reactive
// prober can only ever confirm the shape of what already arrives at the
// antenna. It cannot pursue a target it has never heard, which is precisely
// what "how far can we get" requires.
//
// ─── A TRACEROUTE IS A SURVEY, NOT A PING ───────────────────────────────────
//
// Measured 2026-08-02: of the 79 relays our traffic depends on, 69 have NEVER
// been heard directly — the route is the sole evidence they exist. 23 appear
// only on return legs. 21 have no position. 2 are not in the nodes table at
// all. Plus per-hop SNR in both directions, on segments we can never measure
// ourselves.
//
// One reply can name a relay, place it, draw two links and move the record. So
// the activity feed reports what a route REVEALED, not whether it succeeded.
//
// ─── IT IS A LOOP, NOT A QUEUE DRAIN ────────────────────────────────────────
//
// A discovery feeds straight back in: a relay we have just learned about from a
// route becomes a mission itself, without waiting for the next 15-minute
// recompute. That feedback is the difference between working a list and pushing
// outward.
//
// BOUNDARY: this does not import observatory.js. That would be a fourth
// importer and the test permits three. observatory-ws.js — already allowed —
// feeds the shortlist in via setQueue() and broadcasts activity out. This is a
// dumb executor: handed a list, it works it.
import { EventEmitter } from 'events';
import { traceroute, tracerouteEnabled } from './traceroute.js';
import { transmitterForMode, isTransmitterForMode, dashMode, modeName } from './dash-mode.js';
import { rotator } from './rotator.js';
import { getRotatorAddress } from './device-config.js';
import { getConfig } from './db.js';
import { resolveNodeLabel } from './node-label.js';

const DEFAULTS = {
  enabled: true,
  // Peter's "not so much as to become a nuisance" (§1) with a number attached.
  // ~480/day against the old ~1,000/day, and STEADY rather than bursty: the old
  // pattern was a thousand attempts in a day and then nothing for a week, which
  // is worse for the mesh and worse for the data.
  interval_sec: 180,
  // Backstop only — the rotator's own `done` event is what we wait for. This
  // covers a device that never answers, and is generous because a 180° sweep
  // on the v4 takes real time.
  aim_timeout_sec: 90,
  // Long enough for a multi-hop route to come back. The manager's own default
  // is 60 s and a 5-hop round trip does not always fit in it.
  timeout_sec: 90,
  // How much of the feed to keep. Enough to watch a session; small enough that
  // an idle process cannot grow.
  recent: 60,
};

function cfg() {
  return { ...DEFAULTS, ...(getConfig('mission_runner', {}) || {}) };
}

class MissionRunner extends EventEmitter {
  constructor() {
    super();
    this._queue    = [];
    this._current  = null;
    this._recent   = [];
    this._timer    = null;
    this._started  = false;
    // Everything we already knew before this session started working. A
    // discovery is only a discovery relative to what was known BEFORE the
    // route arrived, so these are seeded once and then grown as routes land.
    this._knownRelays = new Set();
    this._knownLinks  = new Set();
    this._discovered  = { relays: 0, links: 0, identified: 0, records: 0, replies: 0, attempts: 0 };
  }

  /** True while a mission holds the instrument. passive-tracer consults this
   *  and yields — the traceroute belongs to the discovery in progress. */
  get busy() { return this._current != null; }

  /** The shortlist, highest priority first. Pushed in by observatory-ws after
   *  each recompute; the runner never fetches it. */
  setQueue(missions) {
    this._queue = Array.isArray(missions) ? missions.slice() : [];
    this._emit();
  }

  /** Seed what was already known, so the first route does not report the entire
   *  existing mesh as "newly discovered". */
  seed({ relays = [], links = [] } = {}) {
    for (const r of relays) this._knownRelays.add(String(r));
    for (const l of links)  this._knownLinks.add(String(l));
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._schedule();
  }

  stop() {
    this._started = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  state() {
    const c = cfg();
    return {
      enabled:   c.enabled !== false,
      gated:     !tracerouteEnabled(),
      interval:  c.interval_sec,
      running:   this._started,
      queued:    this._queue.length,
      current:   this._current,
      recent:    this._recent,
      discovered: { ...this._discovered },
    };
  }

  _emit() { this.emit('activity', this.state()); }

  _schedule() {
    if (!this._started) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._tick().catch(() => {}), cfg().interval_sec * 1000);
  }

  async _tick() {
    if (!this._started) return;
    const c = cfg();
    // Both switches must be on. `traceroute.enabled` is the master and is
    // checked HERE as well as inside dispatch() so a gated attempt never
    // consumes a queue slot or a cooldown — the same reasoning dispatch() gives
    // for checking before its own cooldown guard.
    // DISCOVERY IS ITS OWN MODE. Peter, 2026-08-02: "well this is a new mode
    // isnt it?" — it is, and the runner only works in it. Mode owns every
    // per-mode behaviour including which radio transmits (Peter's standing
    // rule), so the runner reads the mode rather than choosing a radio itself.
    const mode = modeName(dashMode.value);
    if (mode !== 'disc' || c.enabled === false || !tracerouteEnabled()
        || this.busy || !this._queue.length) {
      this._schedule();
      return;
    }

    const m = this._queue.shift();
    const to = Number(m.target);
    const device = transmitterForMode(mode);
    if (!to || !device) { this._schedule(); return; }

    this._current = {
      target: String(to),
      label:  m.label || resolveNodeLabel(to) || String(to),
      place:  m.place ?? null,
      km:     m.km ?? null,
      bearing: m.bearing ?? null,
      cls:    m.cls ?? null,
      reason: m.reason ?? null,
      device, mode,
      started: Math.floor(Date.now() / 1000),
      timeout: c.timeout_sec,
    };
    this._emit();

    // AIM BEFORE FIRING. The first version did not, and it showed: a 234 km
    // attempt went out on an omni at no particular azimuth, with rotator_az
    // null on the stored row. A directional antenna pointed at nothing is a
    // worse antenna than an omni, not a better one.
    //
    // Only when the mode's transmitter IS the rotator — which in DISC it is by
    // definition, but the config is editable and this must not assume.
    const aim = await this._aim(m.bearing, c);
    this._current.az = aim.az;
    this._current.aim = aim.note;
    if (aim.wait) {
      // The rotator is busy or held by the garage alarm. Put the mission BACK
      // and try again next tick — firing an unaimed shot at a 234 km target
      // would spend the airtime and prove nothing.
      this._queue.unshift(m);
      this._current = null;
      this._emit();
      this._schedule();
      return;
    }

    this._discovered.attempts++;
    this._emit();

    let outcome;
    try {
      const result = await traceroute.dispatch({
        to, device, timeoutMs: c.timeout_sec * 1000,
      });
      outcome = this._analyse(result);
      this._discovered.replies++;
    } catch (err) {
      // §4: A MISS IS DATA. Recorded and shown, never swallowed — silence has
      // four causes the wire cannot distinguish, and a feed that only showed
      // successes would misrepresent every one of them as absence of attempt.
      // The message is normalised for display: the manager's raw text repeats
      // the node id we already show in the Target column, and "timeout
      // !43570a20" reads as an error rather than as the finding it is — §4, a
      // miss is evidence, and the useful part is how long we waited.
      const raw = String(err.message || err);
      const error = /timeout/i.test(raw) ? `no reply after ${c.timeout_sec}s`
                  : /disabled/i.test(raw) ? 'automatic traceroute is off'
                  : /send failed/i.test(raw) ? 'the radio would not send'
                  : raw.slice(0, 60);
      outcome = { ok: false, error, found: [] };
    }

    const row = { ...this._current, ...outcome, finished: Math.floor(Date.now() / 1000) };
    this._current = null;
    this._recent.unshift(row);
    this._recent = this._recent.slice(0, c.recent);
    this._emit();
    this._schedule();
  }

  /** Point the beam at the target, and WAIT FOR THE ROTATOR TO SAY IT IS THERE.
   *
   *  No polling and no tolerance loop. Peter, 2026-08-02: "do not hammer the
   *  rotator, send it the command and wait for it to says it's ready — there's
   *  a handshake" and "the core firmware already has a point function, you dont
   *  need to duplicate it." Both corrections landed on the same mistake: the
   *  first version sent a move and then sampled `az` on a one-second timer,
   *  which read positions MID-TRAVEL and concluded the rotator was 134° off
   *  when it was simply still moving. Given the handshake it lands within a
   *  degree — commanded 200, settled 199.
   *
   *  Returns `{ az, note, wait }`. `wait` defers the mission and puts it back
   *  on the queue: the YAGI is shared with the garage alarm, and `busy/held`
   *  means the beam is not ours right now. Firing an unaimed shot at a 234 km
   *  target would spend the airtime and prove nothing.
   *
   *  A mission with no bearing does not aim and says so — it still goes out,
   *  because a route to an unplaced node is exactly how we learn where it is. */
  async _aim(bearing, c) {
    // Asked of dash-mode rather than compared by hand: the tx role is editable
    // config, and it already owns the "is this MAC the transmitter" question.
    const rotMac = getRotatorAddress();
    if (!rotMac || !isTransmitterForMode(modeName(dashMode.value), rotMac)) {
      return { az: null, note: 'omni — not the rotator', wait: false };
    }
    if (bearing == null) {
      return { az: rotator.status?.az ?? null, note: 'no bearing known', wait: false };
    }

    const r = await rotator.point(bearing, { timeoutMs: c.aim_timeout_sec * 1000 });
    if (r.busy)    return { az: r.az, note: 'beam held by another user', wait: true };
    if (r.timeout) return { az: r.az, note: 'rotator did not answer', wait: true };
    if (!r.ok)     return { az: r.az, note: `move failed: ${r.err || 'unknown'}`, wait: true };
    return { az: Math.round(r.az), note: `aimed ${Math.round(r.az)}°`, wait: false };
  }

  /** WHAT THE ROUTE REVEALED. Computed against what was known BEFORE it landed
   *  — the order matters, because folding the route in first makes every
   *  discovery look like something we already had.
   *
   *  `found` is a list of human-readable strings, written here rather than in
   *  the browser: an explanation is a display value (BROWSER_CONTRACT). */
  _analyse(result) {
    const BROADCAST = 4294967295;
    const out  = (result.route      || []).filter(h => h !== BROADCAST);
    const back = (result.route_back || []).filter(h => h !== BROADCAST);
    const found = [];

    const newRelays = [];
    for (const h of [...out, ...back]) {
      const k = String(h);
      if (this._knownRelays.has(k)) continue;
      this._knownRelays.add(k);
      newRelays.push(resolveNodeLabel(h) || k);
      this._discovered.relays++;
    }
    if (newRelays.length) {
      found.push(`${newRelays.length} new relay${newRelays.length === 1 ? '' : 's'}: ${newRelays.join(', ')}`);
    }

    // THE WAY HOME IS NOT THE WAY OUT, and that asymmetry is a finding in its
    // own right: 23 of the 79 relays we depend on have only ever appeared on a
    // return leg. Nothing chose them; they carried us anyway.
    const returnOnly = back.filter(h => !out.includes(h));
    if (returnOnly.length) {
      found.push(`${returnOnly.length} hop${returnOnly.length === 1 ? '' : 's'} on the way home that the outbound route did not use`);
    }

    let newLinks = 0;
    const chainOut  = [...out];
    for (let i = 0; i < chainOut.length - 1; i++) {
      const a = chainOut[i], b = chainOut[i + 1];
      const id = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (this._knownLinks.has(id)) continue;
      this._knownLinks.add(id);
      newLinks++; this._discovered.links++;
    }
    if (newLinks) found.push(`${newLinks} new link${newLinks === 1 ? '' : 's'} on the map`);

    const snr = (result.snr_towards || []).length ? 'both directions' : null;
    if (snr) found.push(`per-hop SNR ${snr}`);

    return {
      ok: true,
      hops: out.length,
      hops_back: back.length,
      snr_towards: result.snr_towards || [],
      snr_back: result.snr_back || [],
      found,
    };
  }
}

export const missionRunner = new MissionRunner();
