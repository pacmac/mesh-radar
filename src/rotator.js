import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { getConfig, setConfig } from './db.js';
import { defineHook } from './hooks.js';

const RECONNECT_DELAY_MS = 5000;

// Two rotator firmwares co-exist and are switchable at runtime:
//   v4 — PWM DC motor + QMC compass (busy/target, seek2az)
//   v5 — NEMA8 stepper + AS5600 encoder, api:5 (moving/targetAz, move2az)
// The core contract (WS :81 envelope, {action,args}, absolute seek,
// started/done, az, northOffset) is shared — see docs/ROTATOR_API_V5.md.
//
// Device addresses come from env (real LAN addresses live in
// ecosystem.config.cjs, never in source) and fall back to localhost, matching
// bridge.js. The rotator_targets config key overrides this list at runtime.
const DEFAULT_TARGETS = [
  { name: 'v4', url: process.env.ROTATOR_WS_URL    || 'ws://localhost:81' },
  { name: 'v5', url: process.env.ROTATOR_V5_WS_URL || 'ws://localhost:81' },
];
const DEFAULT_ACTIVE = 'v4'; // default = current production; no behaviour change on deploy

// Firmware capability descriptor keyed by detected variant. Consumed by the
// browser (later Domain-2 task) to render the correct settings panel.
const CAPS = {
  v4: { motor: 'pwm',     sensor: 'compass', presets: false, track: false, moveCmd: 'seek2az' },
  v5: { motor: 'stepper', sensor: 'encoder', presets: true,  track: true,  moveCmd: 'move2az' },
};

function loadTargets() {
  const t = getConfig('rotator_targets', null);
  if (Array.isArray(t) && t.length && t.every(e => e && e.name && e.url)) return t;
  return DEFAULT_TARGETS;
}

// How long after a reported hold lapses before we ask again. The device reports
// whole milliseconds remaining; asking at exactly that instant races the
// firmware clearing its own lock, and losing that race costs another full
// round trip. Small, fixed, and not a user knob.
const HOLD_LAPSE_MARGIN_MS = 250;

// EVERY BEAM COMMAND ANNOUNCES ITSELF, AT THE ONE PLACE THEY ALL PASS THROUGH.
//
// Peter, 2026-08-03: "shouldn't our commanding of the pointer also be a hook,
// instead of buried in the core code... in terms of a uniform structure."
//
// Four callers move this antenna — mission-runner, scanner, active-tracker and
// the browser via rotator-api — and until now only ONE of them said so. The
// user-initiated path (rotator-api) was completely silent: you could swing the
// beam from the browser and nothing anywhere recorded it.
//
// Putting the hook in each caller is what produced that: three of four forgot.
// So it lives HERE, in `move()`, which every command funnels through — the same
// principle as `mesh-send.js` being the single recorded transmit path. A future
// caller cannot move the beam silently because it does not get the choice.
const BEAM = defineHook({
  name: 'beam-command', scope: 'actuator',
  purpose: 'records every command that moves the antenna, and which subsystem asked for it',
});

// A SWEEP MUST NOT DROWN THE DECISION TRACE. `scanner` steps the beam
// continuously, and one row per step would bury the handful of lines that
// explain what discovery is doing. Announce only a MATERIAL change of aim, or a
// change of who is asking — the same latch rule the idle reporter uses.
// TIMINGS ARE DECLARED AND CONFIGURABLE, never inline literals.
//
// Peter, 2026-08-04: "stop setting arbitrary timings and stop hard coding
// timings ... what is the basis for your 5 second calculation, why not use
// 2 days instead of 5 seconds ... STOP DOING THAT" and "timings CANNOT be hard
// coded FULL STOP."
//
// Each carries its basis, and each is overridable from `rotator_timing` config:
//
//   cfg_reply_ms  how long to wait for the rotator to answer a config write.
//                 Basis: a WS round trip on the LAN — sub-second in practice;
//                 this is the give-up point, not an expected duration.
//   ping_ms       websocket keepalive interval. Basis: must be shorter than the
//                 far end's idle timeout, which is what closes a silent socket.
const ROTATOR_TIMING_DEFAULTS = { cfg_reply_ms: 3000, ping_ms: 5000 };

/** The longest hold ANY caller may ask this rotator for, in ms.
 *
 *  120 s, unchanged from the value that was already enforced on the config form
 *  as `DISCOVERY_LIMITS.hold_sec[1]`. It is the operator's answer to "how long
 *  may we hold a beam that other applications share", so it is not mine to
 *  re-pick — config-api.js imports it FROM HERE rather than restating it, which
 *  is the only way the form and the pointer cannot disagree.
 *
 *  It lives in this module and not in config-api because `config-api ->
 *  ws-relay -> rotator` is an import cycle; and because it is rotator policy,
 *  not discovery policy. See point(). */
export const HOLD_CEILING_MS = 120 * 1000;
const rotTiming = () => ({ ...ROTATOR_TIMING_DEFAULTS, ...(getConfig('rotator_timing', {}) || {}) });
const cfgReplyMs = () => Number(rotTiming().cfg_reply_ms) || ROTATOR_TIMING_DEFAULTS.cfg_reply_ms;
const pingMs     = () => Number(rotTiming().ping_ms)      || ROTATOR_TIMING_DEFAULTS.ping_ms;

const BEAM_MIN_DEG = 5;
const BEAM_QUIET_MS = 30_000;
let _lastBeam = { az: null, by: null, at: 0 };

class RotatorClient extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._connected = false;
    this._status = {};
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._variant = null;                                     // 'v4' | 'v5' — from status.api
    this._activeName = getConfig('rotator_active', DEFAULT_ACTIVE);
    this._schema = null;                                      // v5 device config schema (evt:schema)
    this._v5Init = false;                                     // sent the v5 subscription + schema request?
    this._cfgPending = new Map();                             // id -> { resolve, t } awaiting evt:reply
  }

  get connected()    { return this._connected; }
  get variant()      { return this._variant; }
  get activeTarget() { return this._activeName; }
  get targets()      { return loadTargets(); }
  get schema()       { return this._schema; }

  // Clear v5 device state (schema/subscription) and fail any pending config
  // sets — called on device switch and disconnect.
  _resetV5State(reason) {
    this._schema = null;
    this._v5Init = false;
    for (const [, p] of this._cfgPending) { clearTimeout(p.t); p.resolve({ ok: false, msg: reason, value: null }); }
    this._cfgPending.clear();
  }

  // Set one v5 config value and resolve with the device's own reply
  // ({ ok, msg, value }). The device validates (rejects out-of-range, not
  // clamped) — it is the single validator. 3 s timeout on no reply.
  setConfigValue(id, value) {
    return new Promise((resolve) => {
      if (!id || !this._connected) return resolve({ ok: false, msg: 'not connected', value: null });
      const prev = this._cfgPending.get(id);
      if (prev) { clearTimeout(prev.t); prev.resolve({ ok: false, msg: 'superseded', value: null }); }
      // DECLARED, not inline. Peter, 2026-08-04: "timings CANNOT be hard coded
      // FULL STOP." Named at the top of the module with its basis, and readable
      // from config, so it can be changed without an edit here.
      const t = setTimeout(() => { this._cfgPending.delete(id); resolve({ ok: false, msg: 'no reply', value: null }); }, cfgReplyMs());
      this._cfgPending.set(id, { resolve, t });
      this._send({ action: id, args: [String(value)] });
    });
  }

  // Normalized status: guarantees canonical moving/targetAz AND the legacy
  // busy/target aliases so existing consumers (scanner.js:103 busy,
  // ws-relay.js:487 target) work unchanged on BOTH firmwares.
  get status() { return this._normalize(this._status); }

  _normalize(s) {
    if (!s || typeof s !== 'object') return s;
    const variant = this._variant
      ?? (s.api === 5 ? 'v5' : (Object.keys(s).length ? 'v4' : null));
    const moving = s.moving ?? s.busy;
    const target = s.targetAz ?? s.target;
    return {
      ...s,
      moving, busy: moving,       // busy alias — scanner.js:103
      targetAz: target, target,   // target alias — ws-relay.js:487
      variant,
      caps: variant ? CAPS[variant] : null,
    };
  }

  _url() {
    const targets = loadTargets();
    const active = targets.find(t => t.name === this._activeName) ?? targets[0];
    this._activeName = active?.name ?? this._activeName;
    return active?.url ?? DEFAULT_TARGETS[0].url;
  }

  start() { this._connect(); }

  stop() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this._ws) this._ws.terminate();
    this._ws = null;
    this._connected = false;
  }

  // Switch the active rotator target and reconnect. Persists the selection.
  // Returns false for an unknown target name.
  setActiveTarget(name) {
    const targets = loadTargets();
    if (!targets.some(t => t.name === name)) return false;
    this._activeName = name;
    setConfig('rotator_active', name);
    console.log(`[rotator] switching active target -> ${name}`);
    this._variant = null;                                     // re-detect on the new device
    this._status = {};                                        // do not leak stale fields
    this._resetV5State('switched');                           // drop stale schema + fail pending sets
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._ws) { try { this._ws.terminate(); } catch { /* already down */ } this._ws = null; }
    this._connected = false;
    this._connect();
    return true;
  }

  // Absolute closed-loop seek. THE COMMAND COMES FROM CAPS — that table is the
  // single declaration of what each variant speaks, and until 2026-08-04 it was
  // declared there and read nowhere, while move() hardcoded its own ternary.
  // The two agreed, so nothing was broken; the hazard was the next edit, made in
  // the table that reads like the source of truth, having no effect.
  //
  // v4 -> seek2az (live-verified on .186; 1031 sent, 0 move2az).
  // v5 -> move2az. Confirmed by Peter 2026-08-04: "move2az on v5 is fine. all
  // these issues dont exist in v5". The move2az being retired is the V4's.
  //
  // From the v4's own @help() on 2026-08-02 BOTH commands exist on v4 — so this
  // is which one we chose, not which one the firmware has.
  move(az, { by = 'unattributed' } = {}) {
    const cmd = (CAPS[this._variant] ?? CAPS.v4).moveCmd;
    const target = Number(az);

    // Latched: a material change of aim, or a different subsystem taking the
    // beam. `by` defaults to 'unattributed' rather than being omitted, so an
    // un-updated caller shows up AS un-updated instead of vanishing.
    const now = Date.now();
    let drift = _lastBeam.az == null ? Infinity : Math.abs(target - _lastBeam.az);
    if (drift > 180) drift = 360 - drift;
    if (drift >= BEAM_MIN_DEG || by !== _lastBeam.by || (now - _lastBeam.at) > BEAM_QUIET_MS) {
      const from = _lastBeam.az == null ? null : Math.round(_lastBeam.az);
      BEAM.emit({
        summary: `beam → ${Math.round(target)}° (${by})`
          + (from == null ? '' : ` — was ${from}°`),
        detail: { az: target, from, by, variant: this._variant },
      });
      _lastBeam = { az: target, by, at: now };
    }
    this._send({ action: cmd, args: [target] });
  }

  /** Point the beam and RESOLVE WHEN THE ROTATOR SAYS IT IS THERE.
   *
   *  The firmware already does the pointing — closed-loop, shortest path,
   *  stall and runaway guards, drift hold. Peter, 2026-08-02: "the core
   *  firmware already has a point function, you dont need to duplicate it."
   *  So this adds no tolerance loop, no settle polling and no retry: it sends
   *  one command and listens for the device's own answer.
   *
   *  Resolves `{ ok, az }` on `done`, or `{ ok:false, busy:true }` when another
   *  user holds the lock — the YAGI is shared with the garage alarm, which
   *  points it and holds it, and that is a reason to wait rather than to fight
   *  for it.
   *
   *  The timeout is a backstop for a device that never answers, not a poll.
   *
   *  ONE OWNER FOR POINTING — A NEGOTIATION, NOT A COMMAND. Peter, 2026-08-03:
   *  "point is a negotiation with the pointer: are you free, if so move now and
   *  maybe hold; if not free, either wait for it to be free or tell the caller
   *  to try again in x ms", and "one SSOT with rotator handshake and intelligent
   *  decisions and modes."
   *
   *  So the whole handshake lives here rather than being re-implemented by each
   *  caller, and the caller states a POLICY rather than re-implementing one:
   *
   *    point(az)                       ask; if held, come straight back with
   *                                    retryInMs — the caller decides
   *    point(az, { hold })             aim, then hold the beam for `hold` ms
   *    point(az, { patienceMs: 5000 }) queue for a hold of up to 5 s, then retry
   *    point(az, { patienceMs: true }) queue however long it says it needs
   *    point(az, { patienceMs: 0 })    never queue (the default)
   *
   *  EXISTING CALLERS ARE UNTOUCHED. `point(az)` and `point(az, { timeoutMs })`
   *  behave exactly as they did — the default patience is 0, so an unaware
   *  caller still gets one ask and an immediate answer. The new fields are
   *  additions to the result, never changes to it.
   *
   *  `patienceMs`, not `wait`: this function already had a wait — `timeoutMs`,
   *  which waits for the device to ANSWER. Patience is the different thing,
   *  waiting for the beam to be FREE. Naming both "wait" is how a caller ends up
   *  setting one and meaning the other.
   *
   *  Every return answers the same three questions, whatever the policy was:
   *
   *    { ok, az,                       did it land, and where
   *      busy, holdMs, retryInMs,      if not: who has it, and until when
   *      waitedMs, timeout, err }      what this call spent, and how it ended
   *
   *  `retryInMs` is the whole point of carrying the busy frame. Before this the
   *  busy frame was discarded, so a caller learned it had been refused but not
   *  for how long — and the mission runner deferred a full 180 s tick over a
   *  hold the firmware reported as 423 ms.
   *
   *  PATIENCE IS A CEILING, NOT A PROMISE. The YAGI is shared with the
   *  garage alarm. A brief hold is the alarm finishing a move and is worth
   *  waiting out; a long one means it owns the beam, and queueing behind that
   *  starves the alarm rather than helping us. That is why the default is not to
   *  wait at all, and why callers state a bound rather than a boolean. */
  // patienceMs DEFAULTS TO true — honour whatever hold the rotator reports.
  //
  // Peter, 2026-08-04: "the rotator is also being used by a different app, every
  // 15 minutes it might point and hold the rotator for up to 15 seconds, but the
  // pointer will tell you that if you know how to ask." And: "that is an issue
  // with the node-dash pointer code and not really traceroute. traceroute calls
  // the pointer code, it is the one that needs fixing."
  //
  // He is right that it belongs HERE. The default was 0 — no patience at all —
  // so every caller that did not think about it gave up the instant the
  // neighbour held the beam, and then reported a move it never made. Sharing is
  // a property of the rotator, not of each caller's memory.
  //
  // `true` means "wait out the hold it stated", not "wait forever": the retry
  // below runs once. A caller that must fail fast passes patienceMs: 0.
  async point(az, { timeoutMs = 60_000, hold = 0, patienceMs = true, by = 'mission' } = {}) {
    // THE HOLD CEILING BINDS EVERY CALLER, AND IT LIVES HERE NOW.
    //
    // Peter, 2026-08-12: "the rotator has many users, not just node dash, it
    // does NOT have exclusive access to it ... it is not permitted to issue very
    // long hold periods to effectively lock out everything else from using the
    // rotator."
    //
    // It used to be enforced in traceroute.js (`HOLD_CEILING_MS`, :425-431),
    // which meant the limit held for that ONE caller and for the config form,
    // and for nobody else — this method's own signature took `hold = 0` with no
    // upper bound. Moved here 2026-08-17 for the reason stated twelve lines
    // above by Peter himself: the pointer is the thing that needs fixing.
    //
    // Same number as before, not a new one of my own: it is the operator's
    // stated answer to "how long may we hold a shared beam", and config-api.js
    // imports it from here so the form and the pointer cannot drift apart.
    if (Number(hold) > HOLD_CEILING_MS) {
      console.log(`[rotator] warn: hold ${hold}ms from '${by}' exceeds the shared-rotator ceiling ${HOLD_CEILING_MS}ms — clamped`);
      hold = HOLD_CEILING_MS;
    }
    const started = this._now();
    let r = await this._pointOnce(az, timeoutMs, by);

    // ARE YOU FREE? — no. How long? Wait it out if the caller's policy allows,
    // then ask exactly once more. One retry, never a loop: if it is still held
    // after its own stated hold has lapsed, something else took it and spinning
    // here would hold up the caller indefinitely.
    if (r.busy && patienceMs) {
      const ceiling = patienceMs === true ? Infinity : Number(patienceMs) || 0;
      const holdMs  = Number(r.holdMs) || 0;
      if (holdMs > 0 && holdMs <= ceiling) {
        const waitMs = holdMs + HOLD_LAPSE_MARGIN_MS;
        await new Promise(res => setTimeout(res, waitMs));
        r = await this._pointOnce(az, timeoutMs, by);
      }
    }

    // REQUESTING THE HOLD IS PART OF POINTING. Callers that aimed and then held
    // were issuing two calls with a gap between them, and that gap is precisely
    // when another user can take the beam.
    if (hold > 0 && r.ok && !r.busy && !r.timeout) this.hold(hold);

    const waitedMs = this._now() - started;
    return {
      timeout: false, busy: false, err: null, ...r,
      // TELL THE CALLER WHEN TO COME BACK. Only meaningful while still refused;
      // null otherwise, so `if (r.retryInMs)` is a safe test for "not now".
      retryInMs: r.busy ? (Number(r.holdMs) || 0) + HOLD_LAPSE_MARGIN_MS : null,
      waitedMs,
    };
  }

  /** Monotonic-ish clock, isolated so the negotiation above stays testable. */
  _now() { return Date.now(); }

  _pointOnce(az, timeoutMs, by = 'mission') {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('done', onDone);
        this.off('busy', onBusy);
        resolve(r);
      };
      const onDone = (m) => finish({ ok: m.ok !== false, az: m.az ?? this.status?.az ?? null, err: m.err ?? null });
      // CARRY THE REMAINING HOLD. This discarded the busy frame entirely, so the
      // caller knew it was refused but not for how long — and deferred a whole
      // 180 s mission tick over a hold the firmware reported as 423 ms.
      //
      // THE STATUS FRAME IS THE SOURCE OF holdMs, NOT THE BUSY FRAME. Measured
      // against the v4 on 2026-08-03: a refused move answers with exactly
      // `{"evt":"busy","held":true}` — no countdown in it. The remaining time
      // lives only on the status stream (`held:true, holdMs:2233`, ticking
      // down), which _connect merges into _status. So `m?.holdMs` is the
      // defensive read and `this.status.holdMs` is the one that actually
      // supplies the number; do not "simplify" by dropping the status side.
      // Task `aim-wait-out-the-hold`.
      const onBusy = (m) => finish({
        ok: false, busy: true,
        az: this.status?.az ?? null,
        holdMs: m?.holdMs ?? this.status?.holdMs ?? null,
      });
      const timer = setTimeout(() => finish({ ok: false, timeout: true, az: this.status?.az ?? null }), timeoutMs);
      this.on('done', onDone);
      this.on('busy', onBusy);
      this.move(az, { by });
    });
  }

  /** HOLD THE BEAM. The firmware verb is `hold`, and it takes milliseconds.
   *
   *  Peter, 2026-08-02: "the pointer function seems to be unaware of the hold
   *  feature that the rotator now has", then "and it's called hold and not
   *  lock." Both corrections were needed. I had tested `lock` — the name in
   *  docs/ROTATOR_API_V5.md — got `{"log":"No such Function: lock"}` and
   *  concluded the v4 had no hold at all. That proved only that `lock` is not
   *  the verb.
   *
   *  Asking the device settled it. `@help()` lists 40 functions including
   *  `@hold()`, and a bare `@hold` replies `"@hold: ms"`. Verified live:
   *  `hold(10000)` → `held=true`, `holdMs` counting down from 9985.
   *
   *  node-dash had never asked: _connect() only requests a schema when the
   *  variant is v5, so a v4's capabilities were never read at all and we worked
   *  from a hardcoded list of three setvars. The firmware is the authority;
   *  the docs and our own lists are both incomplete.
   *
   *  Used to keep the beam still across a mission: the yagi has two users and
   *  the v4 has its own drift behaviour, so "aimed" and "still aimed a few
   *  seconds later" are different claims. */
  hold(ms) {
    this._send({ action: 'hold', args: [Math.max(0, Math.round(Number(ms) || 0))] });
  }

  sendAction(action, args) {
    this._send(args !== undefined ? { action, args } : { action });
  }

  _send(msg) {
    if (!this._ws || !this._connected) return;
    this._ws.send(JSON.stringify(msg));
  }

  _connect() {
    if (this._ws) return;
    const url = this._url();
    console.log(`[rotator] connecting to ${url} (target=${this._activeName})`);
    const ws = new WebSocket(url);
    this._ws = ws;

    ws.on('open', () => {
      if (this._ws !== ws) return;                            // superseded by a switch/reconnect
      console.log(`[rotator] connected (${this._activeName})`);
      this._connected = true;
      if (this._pingTimer) clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.ping();
      }, pingMs());
      this.emit('connected');
    });

    ws.on('message', (data) => {
      if (this._ws !== ws) return;                            // ignore frames from an old socket
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // v5 config protocol frames — handled, not merged into _status.
      if (msg.evt === 'schema') { this._schema = msg.config ?? []; this.emit('schema', this._schema); return; }
      if (msg.evt === 'reply') {
        const p = this._cfgPending.get(msg.cmd);
        if (p) { clearTimeout(p.t); this._cfgPending.delete(msg.cmd); p.resolve({ ok: !!msg.ok, msg: msg.msg, value: msg.value }); }
        return;
      }
      // THE CLOSED-LOOP HANDSHAKE. These were swallowed here, which is why
      // every consumer had to poll az on a timer and guess when a move had
      // finished — Peter, 2026-08-02: "do not hammer the rotator, send it the
      // command and wait for it to says it's ready… there's a handshake."
      //
      // Shapes are identical on v4 and v5 (docs/ROTATOR_API_V5.md, "v4
      // compatibility"), so both variants get a real completion signal:
      //   { evt:'started', cmd:'move2az', target:90 }
      //   { evt:'done',    cmd:'move2az', az:89.9, ok:true }
      //   { evt:'busy',    held:true }        ← another user holds the lock
      if (msg.evt === 'started') { console.log(`[rotator] started ${JSON.stringify(msg)}`); this.emit('started', msg); return; }
      if (msg.evt === 'done')    {
        console.log(`[rotator] done ${JSON.stringify(msg)}`);
        // MERGE THE LANDED AZIMUTH INTO STATUS. `done` carries where the move
        // actually finished, and returning early left `status.az` holding a
        // MID-TRAVEL sample until the next status frame. Anything reading the
        // position straight after a move got a stale answer — which made the
        // off-beam guard defer every mission, reading 141° while the rotator
        // sat on 219°.
        if (msg.az != null) this._status = { ...this._status, az: msg.az };
        this.emit('done', msg);
        return;
      }
      if (msg.evt === 'busy')    { console.log(`[rotator] busy ${JSON.stringify(msg)}`);    this.emit('busy', msg);    return; }
      if (msg.evt === 'subs') return;
      if (msg.log != null && msg.az == null && msg.evt == null) return;   // bare log echo

      // Auto-detect variant from the announced api version. v5 status frames
      // always carry api:5; v4 frames never do (identified by pwm/busy fields).
      if (msg.api === 5) this._variant = 'v5';
      else if (this._variant == null && (msg.pwmMin != null || msg.busy != null)) this._variant = 'v4';

      // On first v5 detection: subscribe to log/done (enables config replies)
      // and request the device config schema. Guarded so it fires once.
      if (this._variant === 'v5' && !this._v5Init) {
        this._v5Init = true;
        this._send({ op: 'set', events: ['status', 'log', 'done'] });
        this._send({ action: 'schema' });
      }

      this._status = { ...this._status, ...msg };
      this.emit('status', this._normalize(msg));
    });

    ws.on('close', () => {
      if (this._ws !== ws) return;                            // an old socket closing after a switch — ignore
      console.log(`[rotator] disconnected — retry in ${RECONNECT_DELAY_MS}ms`);
      this._connected = false;
      this._ws = null;
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
      this._resetV5State('disconnected');                     // re-fetched on reconnect
      this.emit('disconnected');
      this._reconnectTimer = setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
      if (this._ws !== ws) return;
      console.error(`[rotator] WS error: ${err.message}`);
    });
  }
}

export const rotator = new RotatorClient();
