// Mobile Yagi alignment page — used one-handed at the mast while turning an
// antenna. Standalone document at /align (same port, same server, just another
// route), following the public/debug.html precedent. Loads none of the
// dashboard's app-* modules and subscribes to WS /align/events, NOT /events —
// the dashboard stream pushes 7.2 MB on connect and this page needs ~11 KB for a
// whole session.
//
// BROWSER_CONTRACT: `delta` and `direct` arrive pre-computed. Session best/worst/
// age ARE computed here, because they are properties of THIS alignment session
// rather than of the data.

// Chart instance at MODULE scope, never on Alpine state. Storing a live Chart on
// reactive state wraps it in a Proxy and breaks it — app-node-status.js lost
// hours to exactly that.
let _chart = null;
let _themeObserver = null;

const WINDOW_MS = 5 * 60 * 1000;   // 5 minutes of history
const STALE_SEC = 15;              // amber
const DEAD_SEC  = 30;              // red

// Meter scale in dB SNR. Fixed rather than auto-ranging: an auto-scaling meter
// re-maps itself as you turn, so the bar moves even when the signal does not —
// which destroys the one thing the operator is reading it for. LoRa SNR runs
// roughly -20 (floor) to +12 (very strong).
const SCALE_MIN = -20;
const SCALE_MAX = 12;

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
// DaisyUI exposes theme colours as space-separated HSL parts.
const themeColor = (v, alpha = 1) => `hsl(${css(v)} / ${alpha})`;

function chartOptions() {
  const grid = themeColor('--bc', 0.12);
  const tick = themeColor('--bc', 0.6);
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,               // no destroy-during-animation window
    parsing: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: {
        type: 'linear',
        ticks: { display: false },
        grid: { color: grid },
      },
      y: {
        ticks: { color: tick, font: { size: 10 } },
        grid: { color: grid },
        title: { display: false },
      },
    },
    elements: { point: { radius: 0 }, line: { borderWidth: 2, tension: 0.25 } },
  };
}

function buildChart(el) {
  // init() can run more than once (Alpine re-init, hot reload), and a Chart binds
  // to its canvas — a second construction throws "Canvas is already in use".
  // Reuse the existing instance rather than destroying and rebuilding: rebuilding
  // is what caused the destroy-during-animation crashes on the node focus page.
  const existing = Chart.getChart(el);
  if (existing) return existing;

  return new Chart(el, {
    type: 'line',
    data: {
      datasets: [
        // Solid vs dashed, not colour alone — hue does not survive sunlight.
        { label: 'YAGI', data: [], borderColor: themeColor('--p'), spanGaps: false },
        { label: 'OMNI', data: [], borderColor: themeColor('--bc', 0.55),
          borderDash: [5, 4], spanGaps: false },
      ],
    },
    options: chartOptions(),
  });
}

// Theme flips must recolour EVERY axis and tick, not just the datasets. That
// omission recurred three times on the node focus page.
function watchTheme() {
  if (_themeObserver) return;
  _themeObserver = new MutationObserver(() => {
    if (!_chart) return;
    _chart.options = chartOptions();
    _chart.data.datasets[0].borderColor = themeColor('--p');
    _chart.data.datasets[1].borderColor = themeColor('--bc', 0.55);
    _chart.update('none');
  });
  _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

window.alignPage = function alignPage() {
  return {
    targets: [], target: '', running: false, warning: null,
    samples: [], marks: [],
    cur: { yagi: null, omni: null, delta: null },
    best: null, worst: null,
    _now: Date.now(),
    _ws: null, _wake: null, _tick: null,

    async init() {
      watchTheme();
      _chart = buildChart(document.getElementById('alignChart'));
      try {
        const r = await fetch('/align/targets');
        this.targets = await r.json();
        // Default to the first favourite. A <select> renders its first option as
        // visually chosen regardless, so leaving `target` empty makes START look
        // broken — the control appears set but the model disagrees.
        if (this.targets.length) this.target = this.targets[0].num;
      } catch { this.targets = []; }

      // Connect on LOAD, not on START. A second phone opening the page while a
      // session is already running must show that session — it cannot learn the
      // state without a socket, and the server sends a status frame on connect.
      this._open();

      // AGE ticks locally so it keeps counting when samples STOP arriving —
      // that is the whole point of the card.
      this._tick = setInterval(() => { this._now = Date.now(); }, 1000);

      // Dead-man: a phone that locks or navigates away must not leave the mesh
      // transmitting. The server also stops on last-client-disconnect.
      window.addEventListener('pagehide', () => this.stop());
    },

    // Derived from the newest SAMPLE, never from "the socket looks open". Over a
    // mobile link the socket dies silently (bugs #10) and a frozen curve is worse
    // than a blank one — it is a lie the operator will act on. _now ticks every
    // second so this keeps climbing precisely when samples STOP arriving.
    get ageSec() {
      const last = this.samples[this.samples.length - 1];
      if (!last) return null;
      return Math.max(0, Math.round((this._now - last.t * 1000) / 1000));
    },

    get stale()  { return this.running && this.ageSec !== null && this.ageSec >= STALE_SEC; },

    // ── peak-hold meter ────────────────────────────────────────────────────
    // Borrowed from field-strength meters: the live level moves, the peak marker
    // holds at the session best. Closing the gap IS the alignment task, which is
    // why this and not another number.
    SCALE_MIN, SCALE_MAX,
    _pct(v) {
      if (v === null || v === undefined) return 0;
      const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, v));
      return Math.round(((clamped - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100);
    },
    get livePct() { return this._pct(this.cur.yagi); },
    get peakPct() { return this.best === null ? null : this._pct(this.best); },
    // Signal-coded, not decorative: the colour states how good the link is.
    get levelClass() {
      const v = this.cur.yagi;
      if (v === null) return 'bg-base-content/20';
      if (v >= 5)  return 'bg-success';
      if (v >= -5) return 'bg-warning';
      return 'bg-error';
    },
    get spread() { return (this.best !== null && this.worst !== null)
                          ? Math.round((this.best - this.worst) * 10) / 10 : null; },
    get ageClass() {
      if (this.ageSec === null) return 'text-base-content/40';
      if (this.ageSec >= DEAD_SEC)  return 'text-error';
      if (this.ageSec >= STALE_SEC) return 'text-warning';
      return 'text-success';
    },
    get bestMarkN() {
      if (!this.marks.length) return null;
      return this.marks.reduce((a, b) => (b.yagi > a.yagi ? b : a)).n;
    },

    async start() {
      if (!this.target) return;
      // BEST/WORST/marks are per-session: this mast, this attempt.
      this.samples = []; this.marks = [];
      this.best = this.worst = null;
      this.cur = { yagi: null, omni: null, delta: null };
      this._redraw();

      if (!this._ws) this._open();   // reconnect if the socket dropped
      await fetch('/align/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ num: this.target }),
      });
      // `running` is NOT set here — it arrives on the server's status frame.
      try { this._wake = await navigator.wakeLock?.request('screen'); } catch { /* not fatal */ }
    },

    async stop() {
      // Tell the server first; it broadcasts the new state to every client.
      await fetch('/align/stop', { method: 'POST' }).catch(() => {});
      try { this._ws?.close(); } catch {}
      this._ws = null;
      this.running = false;   // the socket is gone, so no status frame will arrive
      // Released deliberately — holding it after stop drains the phone in a pocket.
      try { await this._wake?.release(); } catch {}
      this._wake = null;
    },

    mark() {
      if (this.cur.yagi === null) return;
      this.marks.push({ n: this.marks.length + 1, yagi: this.cur.yagi, t: Date.now() });
    },

    _open() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/align/events`);
      ws.onmessage = (e) => {
        let f; try { f = JSON.parse(e.data); } catch { return; }
        if (f.kind === 'status') {
          // The SERVER owns the session. The browser reflects it and decides
          // nothing (BROWSER_CONTRACT). Setting `running` locally made two
          // phones disagree: one showed STOP while the other showed START for
          // the same single server-side session.
          this.running = f.running;
          this.warning = f.warning ?? null;
          if (f.target !== null && f.target !== undefined) this.target = f.target;
          return;
        }
        this._onSample(f);
      };
      ws.onclose = () => { if (this.running) this._ws = null; };
      this._ws = ws;
    },

    _onSample(s) {
      // A relayed reply says nothing about where the antenna is pointing.
      if (s.direct === false) return;
      this.cur = { yagi: s.yagi, omni: s.omni, delta: s.delta };
      this.samples.push(s);
      const cutoff = Date.now() - WINDOW_MS;
      this.samples = this.samples.filter(x => x.t * 1000 >= cutoff);

      if (s.yagi !== null) {
        this.best  = this.best  === null ? s.yagi : Math.max(this.best, s.yagi);
        this.worst = this.worst === null ? s.yagi : Math.min(this.worst, s.yagi);
      }
      this._redraw();
    },

    _redraw() {
      if (!_chart) return;
      // Update in place. Rebuilding per sample is what caused the
      // destroy-during-animation crashes on the node focus page.
      _chart.data.datasets[0].data = this.samples.map(s => ({ x: s.t * 1000, y: s.yagi }));
      _chart.data.datasets[1].data = this.samples.map(s => ({ x: s.t * 1000, y: s.omni }));
      _chart.update('none');
    },
  };
};
