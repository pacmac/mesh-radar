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
import { doorAim } from './doors.js';
import { ownDeviceNums } from './node-filter.js';
import { defineHook, newProbeId } from './hooks.js';

// THE PROBE, NARRATED. Task `hooks-discovery-path`. Peter, 2026-08-03: "what I
// expect to see is a log for each probe, showing the steps that we are cycling
// through, instead of hiding what is being done in the code."
//
// Declared in the ORDER THEY RUN — registration order is execution order, and
// these are a sequence, not a set.
// How long a hold may be before the mission yields rather than waiting. A brief
// hold is the alarm finishing a move; a long one means it owns the beam and
// queueing behind it would starve the alarm, not help us.

const H = {
  idle: defineHook({
    name: 'discovery-idle', scope: 'per-mode', modes: ['disc'],
    purpose: 'reports why the discovery loop is not probing right now',
  }),
  select: defineHook({
    name: 'select-target', scope: 'per-node',
    purpose: 'takes the highest-ranked candidate and holds it for its attempt budget',
  }),
  aim: defineHook({
    name: 'aim-antenna', scope: 'per-node',
    purpose: 'points the beam at the target bearing, or defers if it cannot',
  }),
  dispatch: defineHook({
    name: 'dispatch-trace', scope: 'per-node',
    purpose: 'sends the traceroute and waits for a reply',
  }),
  outcome: defineHook({
    name: 'record-outcome', scope: 'per-node',
    purpose: 'records what came back, or that nothing did',
  }),
};
import { getRotatorAddress, getAllDeviceCfgs } from './device-config.js';
import db, { getConfig, ourChannelUtil } from './db.js';
import { resolveNodeLabel } from './node-label.js';

const DEFAULTS = {
  enabled: true,
  // Peter's "not so much as to become a nuisance" (§1) with a number attached.
  // ~480/day against the old ~1,000/day, and STEADY rather than bursty: the old
  // pattern was a thousand attempts in a day and then nothing for a week, which
  // is worse for the mesh and worse for the data.
  interval_sec: 180,
  max_attempts_per_day: 400,
  channel_util_pause: 50,
  // Backstop only — the rotator's own `done` event is what we wait for. This
  // covers a device that never answers, and is generous because a 180° sweep
  // on the v4 takes real time.
  aim_timeout_sec: 90,
  // How long point() may queue for a beam another user holds. See config-api.
  aim_patience_sec: 5,
  // Long enough for a multi-hop route to come back. The manager's own default
  // is 60 s and a 5-hop round trip does not always fit in it.
  timeout_sec: 90,
  // How much of the feed to keep. Enough to watch a session; small enough that
  // an idle process cannot grow.
  recent: 60,
};

/** Effective settings.
 *
 *  `interval_sec` and `enabled` come from the USER-FACING `discovery` key
 *  (docs/DISCOVERY_STRATEGY.md); the rest are module internals and stay here.
 *  A setting nobody should be turning is not a setting — aim_timeout_sec and
 *  timeout_sec are protocol timing, not policy.
 *
 *  Read per tick, so a change from the dashboard takes effect on the next
 *  mission with no restart. */
function cfg() {
  const d = getConfig('discovery', {}) || {};
  return {
    ...DEFAULTS,
    ...(getConfig('mission_runner', {}) || {}),
    // Pull every user-facing key this module consumes. An earlier version
    // listed only interval_sec and enabled, so hold_sec silently read as
    // undefined and the beam was never held — the setting existed, the UI
    // showed it, and it did nothing. Whitelisting by hand is what caused that;
    // the list is now explicit and complete for what this module reads.
    ...(d.interval_sec        != null ? { interval_sec: d.interval_sec } : {}),
    ...(d.enabled             != null ? { enabled: d.enabled } : {}),
    ...(d.hold_sec            != null ? { hold_sec: d.hold_sec } : {}),
    ...(d.mission_timeout_sec != null ? { timeout_sec: d.mission_timeout_sec } : {}),
    ...(d.aim_timeout_sec     != null ? { aim_timeout_sec: d.aim_timeout_sec } : {}),
    ...(d.aim_patience_sec    != null ? { aim_patience_sec: d.aim_patience_sec } : {}),
    ...(d.max_attempts_per_day != null ? { max_attempts_per_day: d.max_attempts_per_day } : {}),
    ...(d.channel_util_pause  != null ? { channel_util_pause: d.channel_util_pause } : {}),
    ...(d.attempts_per_target != null ? { attempts_per_target: d.attempts_per_target } : {}),
  };
}

class MissionRunner extends EventEmitter {
  constructor() {
    super();
    this._queue    = [];
    // THE MISSION IN HAND, and how many shots it has left. The runner sticks
    // with a target until its budget is spent instead of shifting past it —
    // see _tick().
    this._holding  = null;
    this._left     = 0;
    // Rolling 24h dispatch log, for the daily budget. Timestamps only — the
    // stored rows are the record; this just has to answer "how many in the last
    // day" without a query on every tick.
    // B75: the daily budget is NOT held in memory. It was — an array seeded
    // empty in this constructor — so every restart returned the budget to zero
    // and the cap bounded "attempts since the last deploy", not attempts per
    // day. Measured 2026-08-03: 1229 attempts against a cap of 400, because the
    // process was restarted five times that evening while shipping. See
    // sentToday().
    this._brake    = null;   // why we are not transmitting, or null
    this._dispatching = false;
    this._current  = null;
    this._idleReason = null;   // last reported idle cause; see _sayIdle
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

  /** True while a mission is IN HAND — aiming, holding, dispatching, waiting.
   *  Used by the panel and to stop a second mission starting. */
  get busy() { return this._current != null; }

  /** True only while a discovery PACKET IS ACTUALLY IN THE AIR.
   *
   *  This is what passive-tracer yields to, and the distinction cost a day.
   *  Yielding on `busy` looked right — "the traceroute belongs to the discovery
   *  in progress" — but `busy` covers the whole cycle, and the runner holds one
   *  target for six attempts across ~18 minutes. Passive went from 17 traces an
   *  hour to 0.1, a 99% cut, and passive was the half that was answering: 3.8%
   *  against DISC's 0.0% over the same period.
   *
   *  A discovery is "in progress" for the seconds a reply is expected, not for
   *  the twenty minutes a target is queued. */
  get dispatching() { return this._dispatching; }

  /** The shortlist, highest priority first. Pushed in by observatory-ws after
   *  each recompute; the runner never fetches it. */
  setQueue(missions) {
    this._queue = Array.isArray(missions) ? missions.slice() : [];
    this._emit();
  }

  /** THE FEED SURVIVES A RESTART.
   *
   *  `_recent` is in-memory, and pm2 watches `src/` — so every edit emptied the
   *  table and the panel announced "no attempt has completed yet this session"
   *  while the runner was mid-stride. That reads as *nothing is happening*,
   *  which is precisely the impression this panel exists to prevent.
   *
   *  The attempts were never lost: they are rows in `traceroute_history`. This
   *  replays them so the feed opens populated. Rows seeded from storage carry
   *  `seeded: true` — they cannot say what they *revealed*, because the
   *  discovery counters are session state and re-deriving them would invent
   *  history. They show what happened and when, and nothing more. */
  seedRecent(rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    this._recent = rows.concat(this._recent).slice(0, cfg().recent);
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
      queued:    this._queue.length + (this._holding ? 1 : 0),
      brake:     this._brake,
      sent_today: this.sentToday(),
      daily_cap: Number(c.max_attempts_per_day) || 400,
      holding:   this._holding ? { target: this._holding.target, label: this._holding.label, left: this._left } : null,
      current:   this._current,
      recent:    this._recent,
      discovered: { ...this._discovered },
    };
  }

  /** Attempts charged against today's airtime budget, from the STORE so it
   *  survives a restart (B75).
   *
   *  `tx_device IS NOT NULL` excludes overheard/passive traceroutes: those cost
   *  us no airtime, and braking ourselves for another station's transmissions
   *  would be wrong however small the count.
   *
   *  A row is written at RESULT time (setTraceroute on success, _recordFailure
   *  on timeout/send failure), so a dispatched attempt is invisible to the query
   *  for up to timeout_sec — `_current` covers that gap. */
  sentToday() {
    let n = 0;
    try {
      n = db.prepare(`SELECT COUNT(*) n FROM traceroute_history
                       WHERE ts > strftime('%s','now') - 86400
                         AND tx_device IS NOT NULL`).get()?.n || 0;
    } catch { n = 0; }
    return n + (this._current ? 1 : 0);
  }

  _emit() { this.emit('activity', this.state()); }

  /** RESCHEDULING HAPPENS HERE AND NOWHERE ELSE, IN A FINALLY.
   *
   *  The first version called _schedule() on each of the five return paths
   *  inside _tick() and wrapped the timer in `.catch(() => {})`. So any throw
   *  anywhere in a tick was swallowed AND skipped every one of those calls: the
   *  runner died permanently after one bad tick, silently, with a full queue.
   *  It managed exactly one mission — Peter, 2026-08-02: "it has made one
   *  attempt and failed, but we have a whole list of targets dont we?"
   *
   *  A loop whose continuation depends on remembering to reschedule on every
   *  branch is a loop that will stop. This one cannot: the finally runs whatever
   *  the tick does, and a failure is logged rather than discarded. */
  _schedule(delayMs = null) {
    if (!this._started) return;
    if (this._timer) clearTimeout(this._timer);
    const wait = delayMs ?? cfg().interval_sec * 1000;
    this._timer = setTimeout(async () => {
      // CADENCE IS MEASURED FROM THE START OF A TICK, NOT ITS END. A mission
      // can take three minutes of its own — up to 90 s aiming the beam and 90 s
      // waiting for a reply that never comes — and rescheduling from the end
      // would silently halve the rate that was configured. The floor keeps a
      // long mission from immediately triggering the next one.
      const startedAt = Date.now();
      try {
        await this._tick();
      } catch (e) {
        console.error(`[mission] tick failed: ${e && e.stack ? e.stack : e}`);
      } finally {
        const elapsed = Date.now() - startedAt;
        this._schedule(Math.max(5_000, cfg().interval_sec * 1000 - elapsed));
      }
    }, wait);
  }

  /** Report an idle reason ONCE, and again only when it changes.
   *
   *  The tick runs every interval_sec (180 s by default). Emitting every time
   *  would bury the log in repetition and make the one line that matters
   *  invisible — the same "notification you learn to ignore" failure as a bar of
   *  permanently-green badges. A latch turns state into transitions.
   *
   *  Recovery is reported too: going from a reason to running again is exactly
   *  as interesting as the reverse, and a fault that never announces its end
   *  leaves the reader unsure whether it is still live. */
  _sayIdle(reason, severity = 'info') {
    if (reason === this._idleReason) return;
    if (reason) {
      H.idle.emit({ summary: `not probing — ${reason}`, severity, detail: { reason } });
    } else if (this._idleReason) {
      H.idle.emit({ summary: `probing resumed (was: ${this._idleReason})`, detail: { was: this._idleReason } });
    }
    this._idleReason = reason;
  }

  async _tick() {
    if (!this._started) return;
    const c = cfg();
    // Both switches must be on. `traceroute.enabled` is the master and is
    // checked HERE as well as inside dispatch() so a gated attempt never
    // consumes a queue slot or a cooldown — the same reasoning dispatch() gives
    // for checking before its own cooldown guard.
    // AIRTIME GOVERNANCE, checked before anything is chosen so a braked tick
    // costs nothing. Both reasons are SURFACED (this._brake) rather than
    // silently skipping — an invisible pause is indistinguishable from a dead
    // loop, which this project has already learned the hard way.
    const spentToday = this.sentToday();
    if (spentToday >= (Number(c.max_attempts_per_day) || 400)) {
      this._brake = `daily budget spent (${spentToday}/${c.max_attempts_per_day})`;
      this._sayIdle(this._brake, 'notice');
      this._emit();
      return;
    }
    // From OUR radios' telemetry, via the mode SSOT for which nums are ours —
    // not from the rotator, which reports no such thing.
    const util = ourChannelUtil(ownDeviceNums());
    const utilCap = Number(c.channel_util_pause) || 100;
    if (util != null && util > utilCap) {
      this._brake = `channel ${Math.round(util)}% busy, over ${utilCap}%`;
      this._sayIdle(this._brake, 'notice');
      this._emit();
      return;
    }
    this._brake = null;

    // DISCOVERY IS ITS OWN MODE. Peter, 2026-08-02: "well this is a new mode
    // isnt it?" — it is, and the runner only works in it. Mode owns every
    // per-mode behaviour including which radio transmits (Peter's standing
    // rule), so the runner reads the mode rather than choosing a radio itself.
    const mode = modeName(dashMode.value);
    // FIVE REASONS, ONE WORDLESS RETURN — until now. This is the same shape as
    // the gate that hid passive tracing for 9.5 hours: the loop stops and
    // nothing anywhere says which of five things stopped it. Each is now named.
    // Emitted ON CHANGE ONLY (see _sayIdle) because this tick runs every 180 s
    // and a per-tick log would be noise, not evidence.
    const idleReason =
        mode !== 'disc'                              ? `mode is ${mode}, discovery only runs in DISC`
      : c.enabled === false                          ? 'discovery runner is switched off'
      : !tracerouteEnabled()                         ? 'automatic traceroute is off (traceroute.enabled)'
      : this.busy                                    ? null   // normal: a probe is in hand
      : (!this._queue.length && !this._holding)      ? 'no candidates — the shortlist is empty'
      : null;
    if (idleReason || mode !== 'disc' || c.enabled === false || !tracerouteEnabled()
        || this.busy || (!this._queue.length && !this._holding)) {
      if (idleReason) this._sayIdle(idleReason, 'notice');
      return;   // the finally in _schedule() brings us back
    }
    this._sayIdle(null);   // running again — clears the latch so a recurrence re-reports

    // STICK WITH A TARGET UNTIL ITS BUDGET IS SPENT.
    //
    // This used to be a bare `_queue.shift()`, and that silently defeated the
    // whole point of `attempts_per_target`. The shortlist is only refreshed on
    // the 15-minute recompute, and by then the target just attempted is inside
    // its 30-minute cooldown and excluded — so a fresh set of ~15 different
    // candidates replaced it and the budget could never be spent. Measured
    // 2026-08-02: 22 targets, 22 attempts, exactly one each, which is the
    // behaviour the setting was introduced to replace.
    //
    // The statistics are the entire argument. At the frontier's own ~4% base
    // rate a single attempt settles nothing; six consecutive shots at one
    // candidate is ~22%, against ~4% each for six candidates tried once.
    //
    // The cooldown still governs RE-SELECTION much later. It just no longer
    // governs the burst, which is what it was accidentally doing.
    const freshTarget = !this._holding;
    if (!this._holding) {
      this._holding = this._queue.shift();
      this._left    = Math.max(1, Number(cfg().attempts_per_target) || 6);
      // ONE PROBE ID PER TARGET RUN, not per attempt: the six shots at one
      // candidate are one investigation and read as one trace.
      this._probeId = newProbeId();
    }
    const m  = this._holding;
    if (!m) return;                    // queue drained between the guard and here
    const to = Number(m.target);
    const device = transmitterForMode(mode);
    if (!to || !device) return;

    this._current = {
      target: String(to),
      label:  m.label || resolveNodeLabel(to) || String(to),
      place:  m.place ?? null,
      km:     m.km ?? null,
      bearing: m.bearing ?? null,
      step_km: m.step_km ?? null,
      cls:    m.cls ?? null,
      reason: m.reason ?? null,
      device, mode,
      started: Math.floor(Date.now() / 1000),
      timeout: c.timeout_sec,
    };
    this._emit();

    // The ranker's `reason` string is computed in reach.mission and, until now,
    // thrown away after sorting. It is the answer to "why this one" and belongs
    // in the trace.
    if (freshTarget) {
      H.select.emit({
        probe_id: this._probeId,
        summary: `chose ${this._current.label} at ${m.km ?? '?'} km — ${m.reason || m.cls || 'no reason given'}`,
        detail: { target: String(to), km: m.km, cls: m.cls, bearing: m.bearing, step_km: m.step_km,
                  budget: this._left, queued: this._queue.length },
      });
    }

    // AIM BEFORE FIRING. The first version did not, and it showed: a 234 km
    // attempt went out on an omni at no particular azimuth, with rotator_az
    // null on the stored row. A directional antenna pointed at nothing is a
    // worse antenna than an omni, not a better one.
    //
    // Only when the mode's transmitter IS the rotator — which in DISC it is by
    // definition, but the config is editable and this must not assume.
    const aim = await this._aim(m.bearing, c, m.target);
    this._current.az = aim.az;
    this._current.aim = aim.note;
    H.aim.emit({
      probe_id: this._probeId,
      severity: aim.wait ? 'notice' : 'info',
      // THE SUMMARY MUST SAY WHAT HAPPENED, NOT WHAT WAS WANTED. This printed
      // `m.bearing` — the TARGET's bearing — whatever the aim actually did. Once
      // aiming moved to the door, the trace read "aimed at 35°" for a mission
      // that deliberately did not move the beam at all, while the truth sat
      // unread in detail.note. A log that reports intent instead of action is
      // the failure this whole event log exists to prevent.
      summary: aim.wait
        ? `could not aim — ${aim.note}`
        : aim.az == null
          ? aim.note
          : `${aim.note}, beam reports ${Math.round(aim.az)}°`,
      detail: { wanted: m.bearing, az: aim.az, note: aim.note, deferred: !!aim.wait },
    });
    if (aim.wait) {
      // A DEFERRAL MUST LEAVE A TRACE. Without this the runner sat with a full
      // queue and zero attempts and there was nothing anywhere saying why —
      // the mission never reaches `recent`, so the panel and the log were both
      // silent. An invisible skip is indistinguishable from a dead loop.
      console.log(`[mission] deferred ${this._current.label}: ${aim.note}`);
      // The rotator is busy or held by the garage alarm. Put the mission BACK
      // and try again next tick — firing an unaimed shot at a 234 km target
      // would spend the airtime and prove nothing.
      // Deferred, not spent: the beam was unavailable, so this does not count
      // against the budget and the target stays in hand.
      this._current = null;
      this._emit();
      return;
    }

    // WHERE IS THE BEAM *NOW*, not where did it land. The hold makes this
    // almost always agree, but almost is not a guarantee with a shared antenna,
    // and a shot fired off-beam tests nothing about the target.
    // Prefer the azimuth the rotator REPORTED ON LANDING (aim.az, from the done
    // event) over a status re-read. The status frame is asynchronous and can lag
    // a move; the done event is the device's own statement of where it stopped.
    const beamNow = aim.az != null ? aim.az : rotator.status?.az;
    const beamOff = (beamNow != null && m.bearing != null)
      ? Math.abs(angleDiff(beamNow, m.bearing)) : 0;
    const offBeam = beamOff > beamwidthOf(getRotatorAddress()) && aim.az != null;
    if (offBeam) {
      // B58: do NOT charge this against the budget — it proved nothing about
      // the target, so spending one of its six shots on it would be a lie.
      console.log(`[mission] beam drifted to ${Math.round(beamNow)}° (wanted ${m.bearing}°) — deferring ${this._current.label}`);
      this._current = null;
      this._emit();
      return;
    }

    this._discovered.attempts++;
    // No local tally to push to — the traceroute_history row IS the record, and
    // _current covers the gap before it is written.
    this._emit();

    H.dispatch.emit({
      probe_id: this._probeId,
      summary: `traceroute → ${this._current.label} via ${device}, waiting up to ${c.timeout_sec}s`,
      detail: { to: String(to), device, timeout_sec: c.timeout_sec, az: this._current.az },
    });

    let outcome;
    this._dispatching = true;
    try {
      const result = await traceroute.dispatch({
        to, device, timeoutMs: c.timeout_sec * 1000,
      });
      outcome = this._analyse(result);
      this._discovered.replies++;
      // A REPLY ENDS THE RUN. The budget exists to find out whether a path is
      // there; once it has answered there is nothing further to learn from
      // hitting it again, and the airtime is better spent on the next target.
      this._holding = null;
      this._left    = 0;
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
    } finally {
      this._dispatching = false;
    }

    // Spend one shot. When the budget runs out the target is released and the
    // next tick takes a new one.
    if (this._holding) {
      this._left--;
      if (this._left <= 0) this._holding = null;
    }

    // BOTH OUTCOMES SPEAK. A miss is data (§4), and a silent failure is the
    // exact shape of every bug found on 2026-08-02/03.
    H.outcome.emit({
      probe_id: this._probeId,
      severity: outcome.ok ? 'info' : 'notice',
      summary: outcome.ok
        ? `${this._current.label} answered — ${(outcome.found || []).length} relay${(outcome.found || []).length === 1 ? '' : 's'} revealed`
        : `${this._current.label}: ${outcome.error}`,
      detail: { target: String(to), ok: !!outcome.ok, error: outcome.error ?? null,
                found: outcome.found ?? [], attempts_left: this._left },
    });

    const row = { ...this._current, ...outcome, finished: Math.floor(Date.now() / 1000),
                  attempt_of: this._left > 0 ? `${(Number(cfg().attempts_per_target) || 6) - this._left} of ${Number(cfg().attempts_per_target) || 6}` : null };
    this._current = null;
    this._recent.unshift(row);
    this._recent = this._recent.slice(0, c.recent);
    this._emit();
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
  async _aim(bearing, c, targetNum = null) {
    // WE DO NOT AIM AT THE TARGET. Peter, 2026-08-03: "whatever happens I dont
    // think we should be targeting remote nodes directly. that is pointless
    // (pun intended)."
    //
    // He is right, and the beam proves it: aiming at the target's own bearing
    // puts the actual first hop OUTSIDE the 35 degree lobe ~87% of the time,
    // in every distance band. The mesh transmits to a DOOR, so the door is the
    // only thing worth pointing at.
    //
    // Measured on the live shortlist the moment this shipped: four targets at
    // bearings 34, 226, 227 and 35 degrees — every one of them routes through
    // the same door at 274 degrees. Aiming at the target was not merely
    // imprecise, it was pointing the opposite way.
    const door = targetNum == null ? null : doorAim(targetNum);

    // AND IF THE DOOR IS CLOSE, THE BEAM IS THEATRE. The dominant door is
    // 5.3 km away; a 9 dBi yagi buys nothing at 5.3 km that the omni does not
    // already have. Rotating anyway would spend up to aim_timeout_sec pointing
    // at something we could already hear. Peter: "or, if all doors are
    // comfortably in sight of OMNI using OMNI?"
    if (door && !door.needsBeam) {
      return { az: null, wait: false,
               note: `not aiming — door ${door.name} is ${door.km} km away, well inside omni reach` };
    }
    if (door) bearing = door.az;
    // Asked of dash-mode rather than compared by hand: the tx role is editable
    // config, and it already owns the "is this MAC the transmitter" question.
    const rotMac = getRotatorAddress();
    if (!rotMac || !isTransmitterForMode(modeName(dashMode.value), rotMac)) {
      return { az: null, note: 'omni — not the rotator', wait: false };
    }
    if (bearing == null) {
      return { az: rotator.status?.az ?? null, note: 'no bearing known', wait: false };
    }

    // THE V4 DOES NOT ALWAYS REACH ITS TARGET, AND SAYS SO:
    //   started {"evt":"started","cmd":"seek2az","target":30}
    //   done    {"evt":"done","cmd":"seek2az","az":7,"ok":false}
    // It accepted the command, moved, stopped 23 degrees short and reported the
    // failure honestly. (The v5 on .195 is closed-loop on an encoder to 0.5
    // degrees and would not do this — it is currently unreachable.)
    //
    // Treating ok:false as fatal meant every mission deferred forever and the
    // queue never drained. But a 23 degree miss on a 35 degree beam still puts
    // the target inside the main lobe: transmitting slightly off-boresight is
    // enormously better than not transmitting at all. So a near miss is
    // ACCEPTED and NAMED, and the azimuth actually achieved is what gets
    // recorded on the attempt — never the one we asked for.
    // THE NEGOTIATION IS ROTATOR.POINT'S, NOT OURS. It asks, waits out a short
    // hold if one is reported, aims, and holds the beam — one call. This was
    // three separate steps here (point, sleep-and-retry, hold), which every
    // other caller would have had to copy. Peter, 2026-08-03: "one SSOT with
    // rotator handshake and intelligent decisions and modes."
    const beam = beamwidthOf(rotMac);
    const aimArgs = {
      timeoutMs: c.aim_timeout_sec * 1000,
      hold: (Number(c.hold_sec) || 0) * 1000,
      patienceMs: (Number(c.aim_patience_sec) || 0) * 1000,
    };
    let r = await rotator.point(bearing, aimArgs);

    // One re-issue if it stopped well short. The v4 often lands closer on a
    // second, shorter move; a third would just be stubbornness.
    if (!r.busy && !r.timeout && r.ok === false
        && r.az != null && Math.abs(angleDiff(r.az, bearing)) > beam / 2) {
      r = await rotator.point(bearing, aimArgs);
    }

    // Still held after point() did its waiting — so this is a long hold, the
    // alarm owns the beam, and the mission yields. retryInMs is reported because
    // "busy" alone is what made this look like a dead rotator in the log.
    if (r.busy)    return { az: r.az, note: `beam held by another user${r.retryInMs ? ` — free in ~${r.retryInMs} ms` : ''}`, wait: true };
    if (r.timeout) return { az: r.az, note: 'rotator did not answer', wait: true };
    if (r.az == null) return { az: null, note: 'rotator reported no azimuth', wait: true };

    const off = Math.round(Math.abs(angleDiff(r.az, bearing)));
    const az  = Math.round(r.az);
    if (off > beam) {
      // Outside the main lobe entirely — this would be a shot in a different
      // direction, and the airtime would prove nothing about the target.
      return { az, note: `stopped ${off}° off ${Math.round(bearing)}°`, wait: true };
    }
    if (off > beam / 2) return { az, note: `aimed ${az}° — ${off}° off, inside the ${beam}° beam`, wait: false };
    return { az, note: `aimed ${az}°`, wait: false };
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

/** The rotator's beamwidth, from its stored profile. Defaults to 35 — the value
 *  the radar has used all along — rather than to something narrow, because a
 *  too-narrow assumption rejects usable aims. */
function beamwidthOf(mac) {
  const b = getAllDeviceCfgs()?.[mac]?.beam_deg;
  return (typeof b === 'number' && b > 0 && b < 360) ? b : 35;
}

/** Signed smallest angle between two bearings. 359 and 1 are 2 apart, not 358 —
 *  the wrap is the whole reason this exists. */
function angleDiff(a, b) {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

export const missionRunner = new MissionRunner();
