import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { getConfig, setConfig } from './db.js';

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
      const t = setTimeout(() => { this._cfgPending.delete(id); resolve({ ok: false, msg: 'no reply', value: null }); }, 3000);
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

  // Absolute closed-loop seek. Dispatches the active variant's native
  // command: v4 seek2az (live-verified on .186), v5 move2az. Both are
  // shortest-path absolute seeks on the encoder.
  move(az) {
    const cmd = (this._variant === 'v5') ? 'move2az' : 'seek2az';
    this._send({ action: cmd, args: [Number(az)] });
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
   *  The timeout is a backstop for a device that never answers, not a poll. */
  point(az, { timeoutMs = 60_000 } = {}) {
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
      const onBusy = ()  => finish({ ok: false, busy: true, az: this.status?.az ?? null });
      const timer = setTimeout(() => finish({ ok: false, timeout: true, az: this.status?.az ?? null }), timeoutMs);
      this.on('done', onDone);
      this.on('busy', onBusy);
      this.move(az);
    });
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
      }, 5000);
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
      if (msg.evt === 'started') { this.emit('started', msg); return; }
      if (msg.evt === 'done')    { this.emit('done', msg);    return; }
      if (msg.evt === 'busy')    { this.emit('busy', msg);    return; }
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
