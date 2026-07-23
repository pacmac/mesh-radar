// Mobile Yagi alignment page — used one-handed at the mast while turning an
// antenna. Standalone document at /align.
//
// PRESENTATION LAYER ONLY (docs/BROWSER_CONTRACT.md). This file renders the align
// view-model pushed by src/align-api.js over WS /align/events and computes NOTHING
// — no quality, no best, no trend, no averaging, no bar maths. Two phones on one
// session render identical screens because both render the same pushed model.
//
// The one value the browser originates is the N selector (how many pings per
// burst) — raw user input, sent with the ping request. It decides nothing about
// what is displayed.

window.alignPage = function alignPage() {
  return {
    // last view-model we were told; never derived from
    model: { running: false, readings: [], burst: null, best: null, current: null,
             warning: null, tx: null, nBurst: 4, replyWindowSec: 30 },
    nBurst: 4,               // N selector — the only browser-held input
    replyWinSec: 30,         // reply-wait field; server-PERSISTED (adopted from model)
    target: '', targets: [],
    _ws: null, _wsOpening: null, _reconnectTimer: null,
    _wake: null, _ended: false,

    async init() {
      // Favourites for the selector. (Population for a form control — the one
      // sanctioned GET; all page DATA arrives on the WS.)
      try {
        const res = await fetch('/align/targets');
        await this._requireOk(res, 'Load targets');
        this.targets = await res.json();
      } catch (e) {
        console.error('[align] targets failed:', e.message);
        this.targets = [];
      }
      if (this.targets.length) this.target = this.targets[0].num;

      this._open().catch(e => console.error('[align] socket open failed:', e.message));
      window.addEventListener('pageshow', () => this._resume());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this._resume();
      });
    },

    // Selecting the flagged current reading to display is rendering, not deciding.
    get cur()      { return this.model.current; },
    get bursting() { return !!this.model.burst?.active; },

    async ping() {
      if (!this.target || this.bursting) return;
      this._ended = false;
      try {
        await this._open();
        const res = await fetch('/align/ping', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ num: this.target, n: this.nBurst }),
        });
        await this._requireOk(res, 'PING');
        await this._holdWake();
      } catch (e) {
        console.error('[align] ping failed:', e.message);
      }
    },

    // Persist the reply-wait period. Server owns/persists it; we send the raw
    // input and render whatever the pushed model reports back.
    async setReplyWindow() {
      try {
        const res = await fetch('/align/reply-window', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sec: this.replyWinSec }),
        });
        await this._requireOk(res, 'Set reply window');
      } catch (e) {
        console.error('[align] reply-window failed:', e.message);
      }
    },

    async end() {
      this._ended = true;
      this._clearReconnect();
      try {
        const res = await fetch('/align/stop', { method: 'POST' });
        await this._requireOk(res, 'End');
      } catch (e) {
        console.error('[align] end failed:', e.message);
      } finally {
        const ws = this._ws;
        this._ws = null;
        this._wsOpening = null;
        if (ws) { ws.onmessage = null; try { ws.close(); } catch {} }
        await this._releaseWake();
      }
    },

    async _open() {
      if (this._ws?.readyState === WebSocket.OPEN) return;
      if (this._wsOpening) return this._wsOpening;
      this._clearReconnect();

      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/align/events`);
      this._ws = ws;

      ws.onmessage = (e) => {
        let f; try { f = JSON.parse(e.data); } catch { return; }
        if (f.kind !== 'align') return;
        this.model = f;                          // render what we are told, nothing else
        if (f.target != null) this.target = f.target;
        // Adopt the server's persisted reply-window (also reflects clamping on set).
        if (typeof f.replyWindowSec === 'number') this.replyWinSec = f.replyWindowSec;
        if (f.running) this._holdWake();
        else this._releaseWake();
      };

      const opening = new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { ws.close(); } catch {}
          reject(new Error('WebSocket open timeout'));
        }, 5000);

        ws.onopen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        ws.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          reject(new Error('WebSocket connection error'));
        };
        ws.onclose = () => {
          clearTimeout(timer);
          if (this._ws === ws) this._ws = null;
          if (!settled) {
            settled = true;
            reject(new Error('WebSocket closed before opening'));
          }
          this._scheduleReconnect();
        };
      });

      this._wsOpening = opening;
      try { await opening; }
      finally { if (this._wsOpening === opening) this._wsOpening = null; }
    },

    _scheduleReconnect() {
      if (this._ended || this._reconnectTimer) return;
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        if (document.visibilityState !== 'visible' || this._ended) return;
        this._open().catch(e => console.error('[align] reconnect failed:', e.message));
      }, 1000);
    },

    _clearReconnect() {
      if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    },

    _resume() {
      if (this._ended) return;
      this._open().catch(e => console.error('[align] resume failed:', e.message));
      if (this.model.running) this._holdWake();
    },

    async _holdWake() {
      if (!this.model.running || document.visibilityState !== 'visible') return;
      if (!navigator.wakeLock?.request || (this._wake && !this._wake.released)) return;
      try {
        const lock = await navigator.wakeLock.request('screen');
        this._wake = lock;
        lock.addEventListener('release', () => {
          if (this._wake === lock) this._wake = null;
        }, { once: true });
      } catch { /* unavailable/insecure is non-fatal */ }
    },

    async _releaseWake() {
      const lock = this._wake;
      this._wake = null;
      try { await lock?.release(); } catch {}
    },

    async _requireOk(res, action) {
      if (res.ok) return res;
      const detail = (await res.text()).slice(0, 160);
      throw new Error(`${action} failed HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    },
  };
};
