import { EventEmitter } from 'events';
import WebSocket from 'ws';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8001';
const BRIDGE_WS_URL = process.env.BRIDGE_WS_URL || 'ws://localhost:8001';

const RECONNECT_DELAY_MS = 5000;

class BridgeClient extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._reconnectTimer = null;
    this._connected = false;
  }

  get connected() {
    return this._connected;
  }

  start() {
    this._connect();
  }

  stop() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._ws) this._ws.terminate();
    this._ws = null;
    this._connected = false;
  }

  _connect() {
    const url = `${BRIDGE_WS_URL}/events`;
    console.log(`[bridge] connecting to ${url}`);
    const ws = new WebSocket(url);
    this._ws = ws;

    ws.on('open', () => {
      console.log('[bridge] WS connected');
      this._connected = true;
      this.emit('connected');
    });

    ws.on('message', (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      const BLE_LOG_TYPES = ['connecting','syncing','reconnecting','error','ready','idle'];
      if (BLE_LOG_TYPES.includes(event.type)) {
        const dev = event.device || '?';
        const msg = event.message ? `: ${event.message}` : '';
        console.log(`[ble] ${dev} → ${event.type}${msg}`);
      }
      this.emit('event', event);
      if (event.type) this.emit(event.type, event);
    });

    ws.on('close', () => {
      console.log(`[bridge] WS disconnected — retry in ${RECONNECT_DELAY_MS}ms`);
      this._connected = false;
      this.emit('disconnected');
      this._reconnectTimer = setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
      console.error(`[bridge] WS error: ${err.message}`);
    });
  }

  async fetch(path, options = {}) {
    const url = `${BRIDGE_URL}${path}`;
    const res = await fetch(url, options);
    if (!res.ok) {
      const text = await res.text();
      throw Object.assign(new Error(`Bridge ${res.status}: ${text}`), { status: res.status });
    }
    return res.json();
  }

  async get(path) {
    return this.fetch(path);
  }

  async post(path, body) {
    return this.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async put(path, body) {
    return this.fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async delete(path) {
    return this.fetch(path, { method: 'DELETE' });
  }
}

export const bridge = new BridgeClient();
