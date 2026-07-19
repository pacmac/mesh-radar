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
             warning: null, tx: null, nBurst: 4 },
    nBurst: 4,               // N selector — the only browser-held input
    target: '', targets: [],
    _ws: null, _wake: null,

    async init() {
      // Favourites for the selector. (Population for a form control — the one
      // sanctioned GET; all page DATA arrives on the WS.)
      try { this.targets = await (await fetch('/align/targets')).json(); }
      catch { this.targets = []; }
      if (this.targets.length) this.target = this.targets[0].num;

      this._open();
      window.addEventListener('pagehide', () => { navigator.sendBeacon?.('/align/stop'); });
    },

    // Selecting the flagged current reading to display is rendering, not deciding.
    get cur()      { return this.model.current; },
    get bursting() { return !!this.model.burst?.active; },

    async ping() {
      if (!this.target || this.bursting) return;
      if (!this._ws) this._open();
      await fetch('/align/ping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ num: this.target, n: this.nBurst }),
      }).catch(() => {});
      try { this._wake = this._wake || await navigator.wakeLock?.request('screen'); } catch { /* not fatal */ }
    },

    async end() {
      await fetch('/align/stop', { method: 'POST' }).catch(() => {});
      try { this._ws?.close(); } catch {}
      this._ws = null;
      try { await this._wake?.release(); } catch {}
      this._wake = null;
    },

    _open() {
      // Idempotent: two live sockets would render every push twice.
      if (this._ws) { try { this._ws.onclose = null; this._ws.onmessage = null; this._ws.close(); } catch {} this._ws = null; }
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/align/events`);
      ws.onmessage = (e) => {
        let f; try { f = JSON.parse(e.data); } catch { return; }
        if (f.kind !== 'align') return;
        this.model = f;                          // render what we are told, nothing else
        if (f.target != null) this.target = f.target;
      };
      ws.onclose = () => { this._ws = null; };
      this._ws = ws;
    },
  };
};
