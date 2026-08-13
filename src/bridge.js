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
    this._helloReceived = false;
    this._apiVersion = null;
  }

  get connected() {
    return this._connected;
  }

  get apiVersion() {
    return this._apiVersion;
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
      console.log('[bridge] WS connected — awaiting hello');
      this._helloReceived = false;
      this._apiVersion = null;
    });

    ws.on('message', (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!this._helloReceived) {
        if (event.type !== 'hello') {
          console.error('[bridge] protocol error: expected hello, got:', event.type);
          return;
        }
        this._apiVersion = event.api_version ?? null;
        const major = String(this._apiVersion ?? '').split('.')[0];
        if (major !== '2') {
          console.error(`[bridge] unsupported api_version: ${this._apiVersion}`);
          this.emit('version_error', { api_version: this._apiVersion });
          return;
        }
        this._helloReceived = true;
        this._connected = true;
        console.log(`[bridge] hello validated (api_version=${this._apiVersion})`);
        this.emit('connected');
        return;
      }
      const BLE_LOG_TYPES = ['connecting','syncing','reconnecting','error','ready','idle'];
      if (BLE_LOG_TYPES.includes(event.type)) {
        const dev = event.node_id || event.addr || '?';
        const msg = event.message ? `: ${event.message}` : '';
        console.log(`[ble] ${dev} → ${event.type}${msg}`);
      }
      this.emit('event', event);
      if (event.type && event.type !== 'error') this.emit(event.type, event);
    });

    ws.on('close', () => {
      console.log(`[bridge] WS disconnected — retry in ${RECONNECT_DELAY_MS}ms`);
      this._helloReceived = false;
      this._connected = false;
      this.emit('disconnected');
      this._reconnectTimer = setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
      // `err.message` IS EMPTY ON THIS ERROR — measured, 1368 identical lines
      // reading "[bridge] WS error: " and nothing else. A socket error from ws
      // carries its diagnosis in `code` (ECONNREFUSED, ECONNRESET, EPIPE...),
      // and that is precisely the field this line omitted, so 1368 log entries
      // recorded that something failed and never once what.
      //
      // Everything present is printed and everything absent is skipped, so the
      // line cannot go empty again: if some future error carries only a name or
      // only a stack, that is what appears.
      const bits = [err?.code, err?.syscall, err?.errno, err?.message]
        .filter(v => v !== undefined && v !== null && v !== '');
      const addr = [err?.address, err?.port].filter(Boolean).join(':');
      if (addr) bits.push(addr);
      // `name` is a LAST RESORT, not a field. On a plain Error it appends a
      // bare "Error" that says nothing; it only earns its place when the error
      // carried no code, no syscall and no message at all.
      if (!bits.length && err?.name) bits.push(err.name);
      console.error(`[bridge] WS error: ${bits.length ? bits.join(' · ') : String(err)}`);
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
