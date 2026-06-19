import { EventEmitter } from 'events';
import WebSocket from 'ws';

const ROTATOR_WS_URL = process.env.ROTATOR_WS_URL || 'ws://192.168.10.186:81';
const RECONNECT_DELAY_MS = 5000;

class RotatorClient extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._connected = false;
    this._status = {};
    this._reconnectTimer = null;
    this._pointTarget = null;
    this._mode = 0; // 0=passive, 1=active
  }

  get connected() { return this._connected; }
  get status()    { return this._status; }
  get mode()      { return this._mode; }

  start() {
    this._connect();
  }

  stop() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._ws) this._ws.terminate();
    this._ws = null;
    this._connected = false;
  }

  move(az) {
    this._send({ action: 'move2az', args: [Number(az)] });
  }

  setMode(mode) {
    this._mode = mode;
    this._send({ action: 'mode', args: [mode] });
    this.emit('mode', { _mode: mode });
  }

  sendAction(action, args) {
    this._send(args !== undefined ? { action, args } : { action });
  }

  pointAtNode(num, az) {
    this._pointTarget = num;
    this.emit('point_target', { point_target: num, az });
    if (this._mode === 1) this.move(az);
  }

  _send(msg) {
    if (!this._ws || !this._connected) return;
    this._ws.send(JSON.stringify(msg));
  }

  _connect() {
    console.log(`[rotator] connecting to ${ROTATOR_WS_URL}`);
    const ws = new WebSocket(ROTATOR_WS_URL);
    this._ws = ws;

    ws.on('open', () => {
      console.log('[rotator] connected');
      this._connected = true;
      this.emit('connected');
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      this._status = { ...this._status, ...msg };
      this.emit('status', msg);
    });

    ws.on('close', () => {
      console.log(`[rotator] disconnected — retry in ${RECONNECT_DELAY_MS}ms`);
      this._connected = false;
      this._ws = null;
      this.emit('disconnected');
      this._reconnectTimer = setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
      console.error(`[rotator] WS error: ${err.message}`);
    });
  }
}

export const rotator = new RotatorClient();
