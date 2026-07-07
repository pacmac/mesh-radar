import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { getConfig, setConfig } from './db.js';

const RECONNECT_DELAY_MS = 5000;

// Two rotator firmwares co-exist and are switchable at runtime:
//   v4 — PWM DC motor + QMC compass (busy/target, seek2az)
//   v5 — NEMA8 stepper + AS5600 encoder, api:5 (moving/targetAz, move2az)
// The core contract (WS :81 envelope, {action,args}, absolute seek,
// started/done, az, northOffset) is shared — see docs/ROTATOR_API_V5.md.
// ROTATOR_WS_URL env, if set, overrides the default v4 url (back-compat).
const ENV_URL = process.env.ROTATOR_WS_URL || null;
const DEFAULT_TARGETS = [
  { name: 'v4', url: ENV_URL || 'ws://192.168.10.186:81' },
  { name: 'v5', url: 'ws://192.168.10.195:81' },
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
  }

  get connected()    { return this._connected; }
  get variant()      { return this._variant; }
  get activeTarget() { return this._activeName; }
  get targets()      { return loadTargets(); }

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
      // Auto-detect variant from the announced api version. v5 status frames
      // always carry api:5; v4 frames never do (identified by pwm/busy fields).
      if (msg.api === 5) this._variant = 'v5';
      else if (this._variant == null && (msg.pwmMin != null || msg.busy != null)) this._variant = 'v4';
      this._status = { ...this._status, ...msg };
      this.emit('status', this._normalize(msg));
    });

    ws.on('close', () => {
      if (this._ws !== ws) return;                            // an old socket closing after a switch — ignore
      console.log(`[rotator] disconnected — retry in ${RECONNECT_DELAY_MS}ms`);
      this._connected = false;
      this._ws = null;
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
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
