// Observatory page mixin — the live observation feed.
//
// Peter, 2026-08-02: "a new page in the main menu, below radar, so that I can
// see the page growing with live data as it is added" and, watching me read
// numbers out of a terminal, "you can see data, I see nothing at all."
//
// PRESENTATION ONLY. Every value here arrived over the WS from
// src/observatory-ws.js; this file decides nothing (BROWSER_CONTRACT). There is
// no fetch anywhere in it and there must never be — the feed is pushed,
// replayed on connect, and appended on arrival.
//
// TIMES ARE ABSOLUTE, NOT RELATIVE, and that is a contract decision rather than
// a style one. BROWSER_CONTRACT forbids the browser computing "3s ago" on a
// timer; formatting a timestamp it was given is expressly allowed. So rows carry
// a clock time. When the server starts pushing a formatted age, it can replace
// this without the page changing shape.
import { persistSet } from './app-persist.js';

// Enough to fill a tall screen and scroll a while, small enough that an idle tab
// cannot grow without bound. The server replays 200 on connect.
const MAX_ROWS = 500;

export const observatoryMixin = {
  // Sub-tabs. Peter, 2026-08-02: "maybe we need a main menu and sub menus for
  // this? … that way debug sub pages can be added and we still have the main
  // nasa dashboard."
  //
  // The board stays the board. Raw feeds and diagnostics live behind their own
  // tabs, so adding the tenth debug view never costs the dashboard a pixel.
  // Same shape as switchControlTab/switchCfgTab; no data load on switch, because
  // everything here is WS-pushed regardless of which tab is showing.
  switchObsTab(name) {
    this.obsTab = name;
    persistSet('obsTab', name);
  },

  /** Newest first. Fed by both WS messages below. */
  observations: [],

  /** Relay usage — the doors. Server-computed by the relay.usage inference and
   *  pushed; the browser ranks nothing and counts nothing. */
  relayUsage: [],

  applyRelayUsage(ev) { this.relayUsage = ev.relays || []; },

  /** The reach model — record, ladder, frontier, and the honest counts around
   *  them. Entirely server-computed; the page ranks and decides nothing. */
  reach: null,

  applyReachModel(ev) { this.reach = ev.reach || null; },

  /** Observed links, both endpoints placed. Server-computed geometry. */
  meshLinks: null,
  applyMeshLinks(ev) { this.meshLinks = ev.links || null; },

  /** The mission shortlist — what to try next and why. Ranked, classified and
   *  explained by the reach.mission inference; the page orders nothing and
   *  writes no reasons (BROWSER_CONTRACT). */
  missions: null,
  applyMissions(ev) { this.missions = ev.missions || null; },

  /** Live discovery activity — what the runner is doing right now, what it has
   *  just done, and what those routes revealed. Entirely server-computed; the
   *  `found` strings are written by the runner, not assembled here. */
  missionActivity: null,

  // THE LOG. Replayed on connect, then appended live as each event is emitted.
  // Peter, 2026-08-03: "this board needs to be a live feed, rather than one that
  // appears to be stale, I want to see that things are actually happening."
  eventLog: [],
  hookList: [],
  logFilter: 'all',
  applyEventLog(ev) { this.eventLog = ev.events || []; this.hookList = ev.hooks || []; },
  applyEvent(ev) {
    // Newest first, matching the replay order. Capped so a long session cannot
    // grow the page without bound — the database keeps the history, this is a view.
    this.eventLog = [ev.event, ...this.eventLog].slice(0, 400);
  },

  /** Filtered view. The server decides what an event IS; this only chooses which
   *  kinds to show. */
  obsLogRows() {
    const f = this.logFilter;
    return (this.eventLog || []).filter(e =>
      f === 'all'     ? true
    : f === 'changes' ? ['config', 'deploy', 'mode'].includes(e.kind)
    : f === 'probes'  ? e.kind === 'probe'
    : f === 'tasks'   ? e.kind === 'task'
    : true);
  },

  /** One probe's steps, grouped. A trace reads FORWARDS in time even though the
   *  log reads backwards — the steps are a sequence and reversing them would
   *  make the narrative nonsense. */
  obsProbeTraces() {
    const byProbe = new Map();
    for (const e of this.eventLog || []) {
      if (!e.probe_id) continue;
      if (!byProbe.has(e.probe_id)) byProbe.set(e.probe_id, []);
      byProbe.get(e.probe_id).push(e);
    }
    return [...byProbe.entries()].slice(0, 12)
      .map(([id, steps]) => ({ id, steps: [...steps].reverse() }));
  },

  obsSeverityClass(sev) {
    return sev === 'fault' ? 'text-error' : sev === 'notice' ? 'text-warning' : 'text-base-content/60';
  },

  obsLogTime(ts) {
    const d = new Date(ts * 1000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
         + ':' + String(d.getSeconds()).padStart(2, '0');
  },

  applyMissionActivity(ev) { this.missionActivity = ev.activity || null; },

  /** How old the newest traceroute attempt is, as a sentence.
   *
   *  ABSOLUTE-TIME RULE, DELIBERATELY BENT — and it is worth saying why. The
   *  page does not compute "3s ago" on a timer anywhere else. Here the whole
   *  point IS the age: a board built on five-day-old evidence must say so, and
   *  "27 Jul 14:02" does not communicate staleness the way "5 days" does.
   *  Computed on render from a server timestamp, not ticking. */
  obsFreshness() {
    const ts = this.reach?.last_attempt;
    if (!ts) return '';
    const mins = Math.floor((Date.now() / 1000 - ts) / 60);
    if (mins < 2)    return 'evidence is current';
    if (mins < 90)   return `newest evidence ${mins} min old`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48)    return `newest evidence ${hrs}h old`;
    return `newest evidence ${Math.round(hrs / 24)} days old`;
  },

  /** Stale enough to be misleading rather than merely old. */
  obsIsStale() {
    const ts = this.reach?.last_attempt;
    return !!ts && (Date.now() / 1000 - ts) > 6 * 3600;
  },

  /** Target a node for discovery, straight from an Observatory table.
   *
   *  Same endpoint and same no-local-state rule as the crosshair on the Nodes
   *  page — this is a second PLACE to reach it, not a second mechanism. It is
   *  here because the Nodes page is not where this work happens, and a control
   *  the operator cannot find is a control that does not exist. */
  async toggleObsTargetNum(num, current) {
    if (!num) return;
    try {
      await fetch(`/nodes/${num}/obs_target`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ obs_target: !current }),
      }).then(r => { if (!r.ok) throw new Error('could not update target'); });
    } catch (e) {
      this.showToast?.(e.message || 'Could not update target', 'error', 0);
    }
  },

  /** Chart series — server-computed, pushed. See docs/OBSERVATORY_CHARTS.md. */
  charts: null,
  applyCharts(ev) { this.charts = ev.charts || null; },

  // Every chart below is an SVG STRING with DaisyUI variable colours, for the
  // two reasons already documented on obsRadarSvg(): <template x-for> cannot
  // work inside <svg>, and Tailwind classes injected via x-html are never
  // compiled by the in-browser JIT. The page scales and positions; every number
  // came from the server.

  /** THE RECORD OVER TIME — the product's narrative (MESH_REACH_SPEC §1a).
   *
   *  A STEP chart, not a line: the record is a ratchet that holds until it is
   *  beaten, and interpolating between rungs would draw a slow climb that never
   *  happened. What it shows is uncomfortable and should be: the whole climb
   *  took ~18 hours on 24 June, and the frontier has moved 7.5 km since. */
  obsChartLadder() {
    const r = this.charts?.ladder || [];
    if (r.length < 2) return '';
    const W = 520, H = 190, L = 42, B = 30;
    const t0 = r[0].ts, t1 = r[r.length - 1].ts || t0 + 1;
    const kmMax = Math.ceil(Math.max(...r.map(x => x.km)) / 50) * 50 || 50;
    const X = ts => L + ((ts - t0) / Math.max(1, t1 - t0)) * (W - L - 10);
    const Y = km => (H - B) - (km / kmMax) * (H - B - 12);
    const p = [];
    for (let i = 0; i <= 4; i++) {
      const km = (kmMax / 4) * i, y = Y(km);
      p.push(`<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - 10}" y2="${y.toFixed(1)}" stroke="oklch(var(--bc)/0.10)" stroke-width="1"/>`);
      p.push(`<text x="${L - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="oklch(var(--bc)/0.45)" font-size="10" font-family="JetBrains Mono">${Math.round(km)}</text>`);
    }
    let d = `M ${X(r[0].ts).toFixed(1)} ${Y(r[0].km).toFixed(1)}`;
    for (let i = 1; i < r.length; i++) {
      d += ` L ${X(r[i].ts).toFixed(1)} ${Y(r[i - 1].km).toFixed(1)}`;
      d += ` L ${X(r[i].ts).toFixed(1)} ${Y(r[i].km).toFixed(1)}`;
    }
    d += ` L ${(W - 10).toFixed(1)} ${Y(r[r.length - 1].km).toFixed(1)}`;
    p.push(`<path d="${d}" fill="none" stroke="oklch(var(--p))" stroke-width="2"/>`);
    for (const x of r) {
      p.push(`<circle cx="${X(x.ts).toFixed(1)}" cy="${Y(x.km).toFixed(1)}" r="3" fill="oklch(var(--p))"><title>${x.km} km — ${x.label}</title></circle>`);
    }
    const last = r[r.length - 1];
    p.push(`<text x="${W - 12}" y="${(Y(last.km) - 7).toFixed(1)}" text-anchor="end" fill="oklch(var(--p))" font-size="11" font-weight="700" font-family="JetBrains Mono">${last.km} km</text>`);

    // THE X AXIS. It had none — the chart plotted time and never said what the
    // horizontal meant. Peter, 2026-08-02: "records over time has no x axis, and
    // you can use a very short form for date/time, we know what year it is."
    //
    // Five evenly spaced ticks across the real span, "24 Jun" — no year, because
    // the whole series is this year and the column has to fit the data.
    p.push(`<line x1="${L}" y1="${H - B}" x2="${W - 10}" y2="${H - B}" stroke="oklch(var(--bc)/0.25)"/>`);
    for (let i = 0; i <= 4; i++) {
      const ts = t0 + ((t1 - t0) / 4) * i;
      const x  = X(ts);
      p.push(`<line x1="${x.toFixed(1)}" y1="${H - B}" x2="${x.toFixed(1)}" y2="${H - B + 4}" stroke="oklch(var(--bc)/0.25)"/>`);
      p.push(`<text x="${x.toFixed(1)}" y="${H - B + 15}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}" fill="oklch(var(--bc)/0.45)" font-size="10" font-family="JetBrains Mono">${this.obsShortDate(ts)}</text>`);
    }
    return p.join('');
  },

  /** "24-06" — day-month, zero padded, no year.
   *
   *  Peter, 2026-08-02: "24-06 etc etc". The label fits the column rather than
   *  the column stretching for the label, and the year is dropped because the
   *  whole series is one year.
   *
   *  BUILT BY HAND, not via toLocaleDateString. A locale formatter cannot be
   *  relied on to give day-first or to use hyphens — that instability is
   *  exactly what forced an explicit 'en-GB' an hour ago, and hand-formatting
   *  removes the dependency rather than pinning it.
   *
   *  Formatting a timestamp the server supplied is expressly allowed
   *  (BROWSER_CONTRACT); computing an age on a timer is not, and this does not. */
  obsShortDate(ts) {
    const d = new Date(ts * 1000);
    return String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0');
  },

  /** ATTEMPTS AND ANSWERS PER DAY. The 27 July cliff — ~1,000/day to 1, because
   *  traceroute.enabled was false — took a database query to find and should
   *  have taken one glance. */
  obsChartDaily() {
    const r = this.charts?.daily || [];
    if (!r.length) return '';
    const W = 520, H = 190, L = 42, B = 26;
    const max = Math.max(1, ...r.map(x => x.attempts));
    const bw = (W - L - 10) / r.length;
    const Y = v => (H - B) - (v / max) * (H - B - 12);
    const p = [];
    for (let i = 0; i <= 3; i++) {
      const v = (max / 3) * i, y = Y(v);
      p.push(`<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - 10}" y2="${y.toFixed(1)}" stroke="oklch(var(--bc)/0.10)"/>`);
      p.push(`<text x="${L - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="oklch(var(--bc)/0.45)" font-size="10" font-family="JetBrains Mono">${Math.round(v)}</text>`);
    }
    r.forEach((x, i) => {
      const bx = L + i * bw;
      p.push(`<rect x="${(bx + 1).toFixed(1)}" y="${Y(x.attempts).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${((H - B) - Y(x.attempts)).toFixed(1)}" fill="oklch(var(--bc)/0.22)"><title>${x.day}: ${x.attempts} attempts</title></rect>`);
      if (x.answers) p.push(`<rect x="${(bx + 1).toFixed(1)}" y="${Y(x.answers).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${((H - B) - Y(x.answers)).toFixed(1)}" fill="oklch(var(--su))"><title>${x.day}: ${x.answers} answered</title></rect>`);
    });
    // Same axis treatment as the ladder, so the two read as a pair. Labels are
    // thinned to roughly five so they never collide at 30 bars.
    p.push(`<line x1="${L}" y1="${H - B}" x2="${W - 10}" y2="${H - B}" stroke="oklch(var(--bc)/0.25)"/>`);
    const every = Math.max(1, Math.ceil(r.length / 5));
    r.forEach((x, i) => {
      if (i % every && i !== r.length - 1) return;
      const cx = L + i * bw + bw / 2;
      p.push(`<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="oklch(var(--bc)/0.45)" font-size="10" font-family="JetBrains Mono">${this.obsShortDate(Date.parse(x.day + 'T00:00:00Z') / 1000)}</text>`);
    });
    return p.join('');
  },

  /** Shared bar renderer for the two rate charts — same shape, same scale rule,
   *  so they read as a pair rather than two dialects. */
  _obsRateBars(rows, labelOf, colourOf) {
    if (!rows?.length) return '';
    const W = 520, H = 190, L = 42, B = 34;
    const rate = x => x.attempts ? (100 * x.answers / x.attempts) : 0;
    const max = Math.max(5, ...rows.map(rate));
    const bw = (W - L - 10) / rows.length;
    const Y = v => (H - B) - (v / max) * (H - B - 14);
    const p = [];
    for (let i = 0; i <= 3; i++) {
      const v = (max / 3) * i, y = Y(v);
      p.push(`<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - 10}" y2="${y.toFixed(1)}" stroke="oklch(var(--bc)/0.10)"/>`);
      p.push(`<text x="${L - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="oklch(var(--bc)/0.45)" font-size="10" font-family="JetBrains Mono">${v.toFixed(0)}%</text>`);
    }
    rows.forEach((x, i) => {
      const bx = L + i * bw, v = rate(x), y = Y(v);
      p.push(`<rect x="${(bx + 3).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(2, bw - 6).toFixed(1)}" height="${((H - B) - y).toFixed(1)}" fill="${colourOf(x, v)}"><title>${labelOf(x)}: ${x.answers}/${x.attempts} = ${v.toFixed(1)}%</title></rect>`);
      p.push(`<text x="${(bx + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" fill="oklch(var(--bc)/0.7)" font-size="10" font-family="JetBrains Mono">${v.toFixed(1)}</text>`);
      p.push(`<text x="${(bx + bw / 2).toFixed(1)}" y="${(H - 18)}" text-anchor="middle" fill="oklch(var(--bc)/0.5)" font-size="9" font-family="JetBrains Mono">${labelOf(x)}</text>`);
      p.push(`<text x="${(bx + bw / 2).toFixed(1)}" y="${(H - 6)}" text-anchor="middle" fill="oklch(var(--bc)/0.3)" font-size="9" font-family="JetBrains Mono">n=${x.attempts}</text>`);
    });
    return p.join('');
  },

  /** ANSWER RATE BY SILENCE — the strongest predictor measured, and the whole
   *  justification for max_silence_days. On screen it can be argued with. */
  obsChartSilence() {
    return this._obsRateBars(this.charts?.silence || [], x => x.bucket,
      (x, v) => v >= 15 ? 'oklch(var(--su))' : v >= 5 ? 'oklch(var(--wa))' : 'oklch(var(--er))');
  },

  /** ANSWER RATE BY DISTANCE — the chart that settles whether a run of silence
   *  is the targets or the setup. */
  obsChartDistance() {
    return this._obsRateBars(this.charts?.distance || [], x => x.band + '+',
      (x, v) => v >= 15 ? 'oklch(var(--su))' : v >= 5 ? 'oklch(var(--wa))' : 'oklch(var(--er))');
  },

  /** RATE BY BAND, BY DAY — four lines, one per distance band.
   *
   *  The chart that would have caught the collapse. The aggregate daily chart
   *  above cannot separate a change in TARGET MIX from a change in PERFORMANCE,
   *  and that ambiguity hid a fall from ~58% to ~7% at under 25 km across three
   *  weeks while the 100+ km band never moved off 0-4%.
   *
   *  A LINE per band, not stacked bars: these are rates that must be COMPARED
   *  against each other, and stacking would imply they sum to something.
   *
   *  `rate === null` means the server suppressed it as too few attempts. The
   *  line BREAKS there rather than dropping to zero — a gap reads as "not known",
   *  a zero reads as "nothing answered", and they are different claims. */
  obsChartBands() {
    const rows = this.charts?.bands || [];
    if (!rows.length) return '';
    // A SEQUENTIAL RAMP IN ONE HUE, because distance is an ordered variable and
    // four arbitrary hues would not say so. Strongest for the nearest band: it
    // carries the story, and it is the one the far bands are read against.
    //
    // Not success/warning/error — the other two rate charts already map those to
    // GOOD and BAD RATE, and green meaning "good" in one chart and "under 25 km"
    // in the next is a broken vocabulary on a single page.
    //
    // Not --s either: in the corporate theme it is chroma 0.055, near enough to
    // grey that it was indistinguishable from the no-pos line beside it.
    //
    // Opacity steps rather than hardcoded oklch values, so the ramp follows the
    // theme instead of fighting it. `no pos` sits deliberately OUTSIDE the ramp,
    // in neutral, because it is not a distance at all.
    const BANDS = [
      { key: '<25',    label: '<25 km',    colour: 'oklch(var(--p))' },
      { key: '25-100', label: '25-100 km', colour: 'oklch(var(--p)/0.62)' },
      { key: '100+',   label: '100+ km',   colour: 'oklch(var(--p)/0.34)' },
      { key: 'no-pos', label: 'no pos',    colour: 'oklch(var(--bc)/0.35)' },
    ];
    const days = [...new Set(rows.map(r => r.day))].sort();
    const W = 520, H = 190, L = 42, B = 34;
    const max = Math.max(20, ...rows.map(r => r.rate ?? 0));
    const X = i => L + (days.length === 1 ? (W - L - 10) / 2 : i * ((W - L - 10) / (days.length - 1)));
    const Y = v => (H - B) - (v / max) * (H - B - 14);
    const p = [];
    for (let i = 0; i <= 3; i++) {
      const v = (max / 3) * i, y = Y(v);
      p.push(`<line x1="${L}" y1="${y.toFixed(1)}" x2="${W - 10}" y2="${y.toFixed(1)}" stroke="oklch(var(--bc)/0.10)"/>`);
      p.push(`<text x="${L - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="oklch(var(--bc)/0.45)" font-size="10" font-family="JetBrains Mono">${v.toFixed(0)}%</text>`);
    }
    const byDay = new Map(days.map((d, i) => [d, i]));
    BANDS.forEach((b) => {
      // Break the path wherever the server suppressed the rate.
      let open = false;
      const seg = [];
      days.forEach((d) => {
        const r = rows.find(x => x.day === d && x.band === b.key);
        if (!r || r.rate === null) { open = false; return; }
        const x = X(byDay.get(d)).toFixed(1), y = Y(r.rate).toFixed(1);
        seg.push(`${open ? 'L' : 'M'}${x} ${y}`);
        open = true;
      });
      if (seg.length) {
        p.push(`<path d="${seg.join(' ')}" fill="none" stroke="${b.colour}" stroke-width="1.8"/>`);
      }
      days.forEach((d) => {
        const r = rows.find(x => x.day === d && x.band === b.key);
        if (!r || r.rate === null) return;
        p.push(`<circle cx="${X(byDay.get(d)).toFixed(1)}" cy="${Y(r.rate).toFixed(1)}" r="1.6" fill="${b.colour}"><title>${d} ${b.label}: ${r.rate}% of ${r.attempts}</title></circle>`);
      });
    });
    p.push(`<line x1="${L}" y1="${H - B}" x2="${W - 10}" y2="${H - B}" stroke="oklch(var(--bc)/0.25)"/>`);
    const every = Math.max(1, Math.ceil(days.length / 5));
    days.forEach((d, i) => {
      if (i % every && i !== days.length - 1) return;
      // Anchor the ends inward: the last label sits at X = W-10 and a centred
      // one overflows the viewBox, which clipped "03-08" to "03-0".
      const anchor = i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle';
      p.push(`<text x="${X(i).toFixed(1)}" y="${H - 18}" text-anchor="${anchor}" fill="oklch(var(--bc)/0.45)" font-size="10" font-family="JetBrains Mono">${this.obsShortDate(Date.parse(d + 'T00:00:00Z') / 1000)}</text>`);
    });
    // The only chart here that needs a key, because it is the only one with more
    // than one series. Same type scale as the axis labels so it reads as part of
    // the chart rather than as a caption bolted underneath.
    BANDS.forEach((b, i) => {
      const lx = L + i * 120;
      p.push(`<rect x="${lx}" y="${H - 10}" width="7" height="2.5" fill="${b.colour}"/>`);
      p.push(`<text x="${lx + 11}" y="${H - 6}" fill="oklch(var(--bc)/0.45)" font-size="9" font-family="JetBrains Mono">${b.label}</text>`);
    });
    return p.join('');
  },

  /** THE THREE VERDICTS. Task `board-panel`.
   *
   *  Grammar borrowed wholesale from the NODE PAGE, which Peter pointed at as
   *  informative: stat-title / big mono stat-value / stat-desc carrying the
   *  provenance. That page already states how it knows a thing — "assumed",
   *  "device-reported", "inferred from silence" — and the board needs exactly the
   *  same discipline. No new visual language was invented; there was no need.
   *
   *  The desc is the SERVER's basis string. The browser assembles no explanation
   *  (BROWSER_CONTRACT) and this method picks no thresholds — it colours what it
   *  is told. */
  obsVerdictClass(state) {
    return state === 'ok'    ? 'text-success'
         : state === 'warn'  ? 'text-warning'
         : state === 'fault' ? 'text-error'
         : 'text-base-content/60';
  },

  /** A sparkline: shape only. No axes, no gridlines, no legend — those live on
   *  Charts, which is where you go once the shape makes you suspicious. Peter:
   *  "one glance is better with graphical rather than text, but thats not to say
   *  we should litter it with graphs as we have chart page to drill down."
   *
   *  A null value BREAKS the line rather than plotting zero: a gap reads as "not
   *  known", a zero reads as "nothing happened". Same rule as the bands chart. */
  obsSpark(series, state) {
    const pts = (series || []);
    if (!pts.length) return '';
    const vals = pts.map(p => p.v).filter(v => v != null);
    if (!vals.length) return '';
    const W = 200, H = 34;
    const max = Math.max(...vals), min = Math.min(...vals);
    const span = (max - min) || 1;
    const X = i => pts.length === 1 ? W / 2 : (i * W) / (pts.length - 1);
    const Y = v => H - 3 - ((v - min) / span) * (H - 8);
    const colour = state === 'ok' ? 'oklch(var(--su))'
                 : state === 'warn' ? 'oklch(var(--wa))'
                 : state === 'fault' ? 'oklch(var(--er))'
                 : 'oklch(var(--bc)/0.4)';
    const seg = [];
    let open = false;
    pts.forEach((p, i) => {
      if (p.v == null) { open = false; return; }
      seg.push(`${open ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`);
      open = true;
    });
    const last = [...pts].reverse().find(p => p.v != null);
    const li = pts.indexOf(last);
    return `<path d="${seg.join(' ')}" fill="none" stroke="${colour}" stroke-width="1.6"/>`
         + (li >= 0 ? `<circle cx="${X(li).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="2.2" fill="${colour}"/>` : '');
  },

  /** THE FRONTIER RULER — the one glance-graphic that is a GAP, not a trend.
   *  A sparkline cannot say "92 of 189, and the notch is over there", and that
   *  gap is the entire product. Also honest in a way the bare record never was:
   *  189.1 km alone implied success for a month. */
  obsFrontierRuler() {
    const f = this.charts?.board?.frontier;
    if (!f || f.record_km == null) return '';
    const W = 520, H = 40, L = 8, R = 8;
    const span = Math.max(f.record_km, f.window_km ?? 0) * 1.08 || 1;
    const X = km => L + (km / span) * (W - L - R);
    const p = [];
    p.push(`<line x1="${L}" y1="24" x2="${W - R}" y2="24" stroke="oklch(var(--bc)/0.2)" stroke-width="2"/>`);
    if (f.window_km != null) {
      p.push(`<line x1="${L}" y1="24" x2="${X(f.window_km).toFixed(1)}" y2="24" stroke="oklch(var(--p))" stroke-width="3"/>`);
      p.push(`<circle cx="${X(f.window_km).toFixed(1)}" cy="24" r="4" fill="oklch(var(--p))"/>`);
      p.push(`<text x="${X(f.window_km).toFixed(1)}" y="14" text-anchor="middle" fill="oklch(var(--bc)/0.7)" font-size="11" font-family="JetBrains Mono">${f.window_km} km</text>`);
    }
    const rx = X(f.record_km).toFixed(1);
    p.push(`<line x1="${rx}" y1="16" x2="${rx}" y2="32" stroke="oklch(var(--bc)/0.55)" stroke-width="2"/>`);
    p.push(`<text x="${rx}" y="14" text-anchor="end" fill="oklch(var(--bc)/0.5)" font-size="11" font-family="JetBrains Mono">${f.record_km} km</text>`);
    p.push(`<text x="${L}" y="38" fill="oklch(var(--bc)/0.4)" font-size="9" font-family="JetBrains Mono">this period</text>`);
    p.push(`<text x="${W - R}" y="38" text-anchor="end" fill="oklch(var(--bc)/0.4)" font-size="9" font-family="JetBrains Mono">all-time</text>`);
    return p.join('');
  },

  /** THE SELECTION FUNNEL — where the candidate pool actually goes.
   *
   *  Peter, 2026-08-03: "I need to be able to see what you see in raw data, but
   *  I want to see it at a glance."
   *
   *  This is the single most informative thing read from the database all day
   *  that was not on screen. It explains why a pool of 531 nodes produces a
   *  shortlist of 3, and EVERY SEGMENT NAMES THE KNOB THAT CAUSED IT — so the
   *  answer to "why is it only trying three things" is on the page rather than
   *  in a query.
   *
   *  The old line showed 3 of the 5 exclusions and omitted the two LARGEST
   *  (beyond-window 191, silent 151), which is how the biggest filters stayed
   *  invisible.
   *
   *  Server-computed counts; this only lays them out. */
  obsFunnel() {
    const s = this.missions?.summary;
    if (!s) return [];
    const segs = [
      { k: 'shown',      n: s.shown ?? 0,                 label: 'working now', tone: 'bg-primary' },
      { k: 'cooling',    n: s.skipped_cooling ?? 0,       label: `cooling · ${s.cooldown_min}m`,        tone: 'bg-info/60' },
      { k: 'exhausted',  n: s.skipped_exhausted ?? 0,     label: `tried out · ${s.attempts_per_target}`, tone: 'bg-base-content/25' },
      { k: 'window',     n: s.skipped_beyond_window ?? 0, label: `too far · ${s.window_km}km step`,      tone: 'bg-warning/70' },
      { k: 'silent',     n: s.skipped_silent ?? 0,        label: `silent · ${s.max_silence_days}d`,      tone: 'bg-base-content/40' },
      { k: 'suspect',    n: s.skipped_suspect ?? 0,       label: 'no position',                          tone: 'bg-base-content/15' },
    ].filter(x => x.n > 0);
    const total = segs.reduce((a, b) => a + b.n, 0) || 1;
    return segs.map(x => ({ ...x, pct: (100 * x.n) / total, total }));
  },

  /** Set the ANALYSIS WINDOW. Server state, not a browser preference — Peter,
   *  2026-08-03: "the browser is a presentation layer ONLY, this filtering must
   *  be done backend so anyone using the browser sees the same thing."
   *
   *  So this PUTs and does nothing else. The server re-broadcasts `charts` and
   *  every viewer re-renders from that — no optimistic local state, the same
   *  rule that governs the target crosshair above. The allowed values are the
   *  server's enum; a value outside it is rejected with 400 rather than clamped. */
  async setObsWindow(days) {
    try {
      await fetch('/config/observatory.window_days', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: Number(days) }),
      });
    } catch (e) {
      console.error('window set failed', e);
    }
  },

  /** Pin a mission to the top of the queue, or unpin it.
   *
   *  Writes the `discovery` config key, which is where `pinned` lives — one
   *  value, so pinning another target moves the pin rather than adding to a
   *  list. No local state: the row re-renders from the next missions push.
   *
   *  Selection is recomputed on a timer, so a pin takes effect at the next
   *  recompute rather than instantly; the panel says as much. */
  async togglePinned(m) {
    if (!m?.target) return;
    const already = String(this.missions?.summary?.pinned ?? '') === String(m.target);
    try {
      await fetch('/config/discovery', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: { pinned: already ? null : Number(m.target) } }),
      }).then(r => { if (!r.ok) throw new Error('pin failed'); });
    } catch (e) {
      this.showToast?.(e.message || 'Could not pin target', 'error', 0);
    }
  },

  /** The radar, built as an SVG string.
   *
   *  NOT `<template x-for>` INSIDE `<svg>`, AND THIS IS NOT A STYLE CHOICE.
   *  The HTML parser treats a <template> inside <svg> as an SVG-namespaced
   *  element with no .content, so Alpine cannot use it as a loop scope: every
   *  binding inside reports "ring is not defined", "b is not defined",
   *  "t is not defined", and the attributes land empty ("Expected length, ''").
   *  30 console errors on the first attempt. The static mockup built its SVG as
   *  a string for the same reason and it is the right answer here too.
   *
   *  Presentation arithmetic over server-supplied values — the km and bearing
   *  were both computed by the reach model; this only decides where on a circle
   *  to put them (BROWSER_CONTRACT permits layout).
   *
   *  Range scales to the RECORD, not a fixed 200 km: the ring the eye lands on
   *  should be the frontier we actually hold. */
  obsRadarSvg() {
    // COLOURS COME FROM DAISYUI'S CSS VARIABLES, NOT TAILWIND CLASSES. Tailwind
    // here is the in-browser JIT build, and utility classes injected into SVG
    // via x-html are never compiled — the first attempt rendered a solid black
    // disc because `fill-base-200/30` resolved to nothing and SVG defaults to
    // black. oklch(var(--b2)) needs no build step and still follows the theme,
    // so the plot is correct in both light and dark.
    const C_DISC   = 'oklch(var(--b2)/0.35)';
    const C_LINE   = 'oklch(var(--b3))';
    const C_LABEL  = 'oklch(var(--bc)/0.45)';
    const C_FAR    = 'oklch(var(--p))';
    const C_NEAR   = 'oklch(var(--s))';
    const C_CENTRE = 'oklch(var(--bc))';
    const C_BEAM   = 'oklch(var(--a)/0.16)';   // the wedge — context, not subject
    const C_BEAMLN = 'oklch(var(--a))';        // the boresight and its readout
    const plot = this.reach?.plot || [];
    if (!plot.length) return '';
    const C = 500, R = 430;
    const max = this.obsRadarMax();
    const pt = (km, brg, radius = null) => {
      const r = radius ?? (km / max) * R;
      const a = (brg - 90) * Math.PI / 180;
      return [C + Math.cos(a) * r, C + Math.sin(a) * r];
    };
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const p = [`<circle cx="${C}" cy="${C}" r="${R}" fill="${C_DISC}" stroke="${C_LINE}" stroke-width="2"/>`];

    for (let i = 1; i <= 4; i++) {
      const km = Math.round((max / 4) * i), r = (km / max) * R;
      p.push(`<circle cx="${C}" cy="${C}" r="${r.toFixed(1)}" fill="none" stroke="${C_LINE}" stroke-width="1.5" stroke-dasharray="4 8"/>`);
      p.push(`<text x="${C + 8}" y="${(C - r + 22).toFixed(1)}" fill="${C_LABEL}" font-size="20" font-family="JetBrains Mono">${km}</text>`);
    }
    for (let b = 0; b < 360; b += 45) {
      const [x, y] = pt(0, b, R), [lx, ly] = pt(0, b, R + 38);
      p.push(`<line x1="${C}" y1="${C}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C_LINE}" stroke-width="${b % 90 ? 1 : 2}"/>`);
      p.push(`<text x="${lx.toFixed(1)}" y="${(ly + 8).toFixed(1)}" text-anchor="middle" fill="${C_LABEL}" font-size="22" font-family="Oxanium">${b}</text>`);
    }
    // ── THE BEAM ────────────────────────────────────────────────────────────
    // Peter, 2026-08-02: "the radar sub page does not show the yagi's current
    // bearing and it's beam width as is done in the main radar page."
    //
    // It matters more here than on the main radar now that DISC aims the beam
    // at each mission's bearing: this page is where you watch a discovery
    // happen, and a plot of targets with no indication of where the antenna is
    // looking cannot show that.
    //
    // Same two inputs the main radar uses (_drawRadarBeam): `yagiAz`, pushed
    // over the WS, and the rotator's configured beam_deg. Both are server
    // values; drawing a wedge from them is layout.
    //
    // DRAWN BEFORE THE TARGETS so a dot inside the beam stays legible — the
    // wedge is context, not the subject.
    const rotId = this.rotatorDeviceId?.();
    const beamDeg = Math.max(1, Math.min(rotId ? (this.deviceConfigs?.[rotId]?.beam_deg ?? 35) : 35, 180));
    if (this.yagiAz != null) {
      const az = Number(this.yagiAz);
      const [x1, y1] = pt(0, az - beamDeg / 2, R);
      const [x2, y2] = pt(0, az + beamDeg / 2, R);
      const [tx, ty] = pt(0, az, R + 6);
      // large-arc-flag 0: the beam is always the minor sector — a beamwidth is
      // clamped to 180 above, so the wedge can never be the reflex side.
      p.push(`<path d="M ${C} ${C} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z" fill="${C_BEAM}" stroke="none"/>`);
      p.push(`<line x1="${C}" y1="${C}" x2="${tx.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="${C_BEAMLN}" stroke-width="2"/>`);
      const [lx, ly] = pt(0, az, R + 78);
      p.push(`<text x="${lx.toFixed(1)}" y="${(ly + 8).toFixed(1)}" text-anchor="middle" fill="${C_BEAMLN}" font-size="22" font-weight="700" font-family="Oxanium">${Math.round(az)}° · ${Math.round(beamDeg)}°</text>`);
    }

    // Nearest first, so the distant targets that matter draw on top.
    const labels = [];
    for (const t of [...plot].sort((a, b) => a.km - b.km)) {
      const [x, y] = pt(t.km, t.bearing);
      const far = t.km > 100;
      // Opacity carries reliability: 1 hit in 63 must not look like a standing
      // link. The dot says reached; the fade says how dependably.
      const op = Math.max(0.25, Math.min(1, (t.hits / t.attempts) * 3)).toFixed(2);
      p.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${far ? 9 : 5}" fill="${far ? C_FAR : C_NEAR}" opacity="${op}"><title>${esc(t.label)} — ${t.km} km @ ${t.bearing}°, ${t.hits}/${t.attempts}</title></circle>`);
      if (t.km > 120) labels.push({ x, y, label: t.label });
    }

    // DE-COLLIDE THE LABELS. Targets that share a corridor share a bearing —
    // CBay and Ives are both 187.7 km at 242°, and the Guernsey pair sit on top
    // of each other at ~150°. Drawn naively they overprint into an unreadable
    // smudge, which is the thing that makes a plot look broken.
    //
    // Nudged apart vertically, with a leader offset, and the side chosen so a
    // label never runs off the disc.
    labels.sort((a, b) => a.y - b.y);
    let lastY = -Infinity;
    for (const L of labels) {
      const y = (L.y - lastY < 22) ? lastY + 22 : L.y;
      lastY = y;
      const left = L.x > C;
      p.push(`<text x="${(L.x + (left ? -15 : 15)).toFixed(1)}" y="${(y + 7).toFixed(1)}" text-anchor="${left ? 'end' : 'start'}" fill="${C_FAR}" font-size="20" font-family="JetBrains Mono">${esc(L.label)}</text>`);
    }
    p.push(`<circle cx="${C}" cy="${C}" r="8" fill="${C_CENTRE}"/>`);
    return p.join('');
  },

  obsRadarMax() {
    const rec = this.reach?.record_km || 0;
    return rec ? Math.ceil(rec / 50) * 50 : 0;
  },

  /** The mesh map, built as an SVG string — same reason as the radar.
   *
   *  EQUIRECTANGULAR, with longitude flattened by cos(latitude). Crude as
   *  projections go, and correct enough at this scale: over ~4° of latitude the
   *  distortion is far smaller than the position error in the underlying
   *  self-reported coordinates (§12). A real projection would be false
   *  precision on top of fuzzy input.
   *
   *  Links are drawn UNDER nodes, weighted by how much traffic each carried, so
   *  the corridors read as corridors rather than as a wire ball. */
  obsMapSvg() {
    const L = this.meshLinks?.links || [];
    if (!L.length) return '';
    const C_LINK   = 'oklch(var(--s))';
    const C_NODE   = 'oklch(var(--s)/0.7)';
    const C_FAR    = 'oklch(var(--p))';
    const C_HOME   = 'oklch(var(--bc))';
    // One colour per server-assigned class. DaisyUI variables, not Tailwind
    // classes — see the note on obsRadarSvg(); injected utility classes are
    // never compiled and render as black.
    const C_CLS = {
      relay:    'oklch(var(--a))',        // doors — the thing the mesh runs on
      endpoint: 'oklch(var(--p))',        // reached, but relays for nobody
      seen:     'oklch(var(--bc)/0.35)',  // known only through someone else
    };
    const W = 1000, H = 700, PAD = 40;

    const pts = [];
    for (const l of L) { pts.push([l.a_lat, l.a_lon], [l.b_lat, l.b_lon]); }
    const lats = pts.map(p => p[0]), lons = pts.map(p => p[1]);
    const la0 = Math.min(...lats), la1 = Math.max(...lats);
    const lo0 = Math.min(...lons), lo1 = Math.max(...lons);
    const k = Math.cos(((la0 + la1) / 2) * Math.PI / 180);   // flatten longitude
    const spanX = Math.max(1e-6, (lo1 - lo0) * k), spanY = Math.max(1e-6, la1 - la0);
    const s = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
    const X = lon => PAD + (lon - lo0) * k * s + ((W - PAD * 2) - spanX * s) / 2;
    const Y = lat => H - PAD - (lat - la0) * s - ((H - PAD * 2) - spanY * s) / 2;

    const maxC = Math.max(...L.map(l => l.count));
    const p = [];
    for (const l of L) {
      const f = Math.log1p(l.count) / Math.log1p(maxC);
      p.push(`<line x1="${X(l.a_lon).toFixed(1)}" y1="${Y(l.a_lat).toFixed(1)}" x2="${X(l.b_lon).toFixed(1)}" y2="${Y(l.b_lat).toFixed(1)}" stroke="${C_LINK}" stroke-width="${(0.6 + f * 3).toFixed(2)}" opacity="${(0.18 + f * 0.55).toFixed(2)}"><title>${l.km} km, seen ${l.count}x</title></line>`);
    }
    // NODES, COLOURED BY WHAT THEY DO FOR US. The class and the weight are the
    // server's (`meshLinks().nodes`); this maps them to a fill and a radius.
    // Ninety-two identical grey dots said where the mesh is and nothing about
    // what any of it does — Peter, 2026-08-02.
    //
    // Radius carries the door's share of relayed traffic. A relay is drawn
    // larger the more it has carried, so the corridors that actually work read
    // as thick nodes on thick lines.
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const nodes = this.meshLinks?.nodes || [];
    if (nodes.length) {
      for (const n of [...nodes].sort((a, b) => a.weight - b.weight)) {
        const r = n.cls === 'relay' ? 3.5 + n.weight * 8 : 3.5;
        const tip = `${n.label}${n.place ? ` — ${n.place}` : ''}, ${n.km} km`
          + (n.cls === 'relay' ? `, relayed ${n.uses}x` : n.cls === 'endpoint' ? ', route verified' : ', seen only');
        p.push(`<circle cx="${X(n.lon).toFixed(1)}" cy="${Y(n.lat).toFixed(1)}" r="${r.toFixed(1)}" fill="${C_CLS[n.cls] || C_NODE}" opacity="${n.cls === 'seen' ? 0.5 : 0.9}"><title>${esc(tip)}</title></circle>`);
      }
    } else {
      // Fallback for a payload from before classification shipped — the map
      // still draws rather than going blank on an older server.
      const drawn = new Set();
      for (const l of L) {
        for (const [n, lat, lon] of [[l.a, l.a_lat, l.a_lon], [l.b, l.b_lat, l.b_lon]]) {
          if (drawn.has(n)) continue;
          drawn.add(n);
          p.push(`<circle cx="${X(lon).toFixed(1)}" cy="${Y(lat).toFixed(1)}" r="4" fill="${C_NODE}" opacity="0.8"/>`);
        }
      }
    }
    // PLACE LABELS on the outliers only — server-chosen (meshLinks().marks), so
    // the browser decides nothing about which corridor is worth naming, which
    // neighbourhoods collapse into one mark, or what a mark is called.
    // De-collided vertically, same reason as the radar: nodes that share a
    // corridor share a pixel and overprint into a smudge otherwise.
    //
    // CLAMPED INTO THE PANEL. Pushing collisions downwards walked the Guernsey
    // stack straight off the bottom edge and four labels vanished — text that
    // is silently outside the viewBox looks like missing data, not overflow.
    const marks = [...(this.meshLinks?.marks || [])]
      .map(m => ({ ...m, px: X(m.lon), py: Y(m.lat) }))
      .sort((a, b) => a.py - b.py);
    let lastY = -Infinity;
    for (const m of marks) {
      const y = Math.min(H - 8, Math.max(14, (m.py - lastY < 16) ? lastY + 16 : m.py));
      lastY = y;
      const left = m.px > W / 2;
      // "+3" says three more nodes sit under this dot — the count is the
      // server's, so a cluster never quietly hides its members.
      const more = m.nodes > 1 ? ` +${m.nodes - 1}` : '';
      p.push(`<circle cx="${m.px.toFixed(1)}" cy="${m.py.toFixed(1)}" r="5" fill="${C_FAR}"/>`);
      p.push(`<text x="${(m.px + (left ? -9 : 9)).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="${left ? 'end' : 'start'}" fill="${C_FAR}" font-size="13" font-family="JetBrains Mono">${esc(m.label)} ${m.km}km${more}</text>`);
    }

    const hl = this.reach?.home_lat, hn = this.reach?.home_lon;
    if (hl != null && hn != null) {
      p.push(`<circle cx="${X(hn).toFixed(1)}" cy="${Y(hl).toFixed(1)}" r="8" fill="${C_HOME}"/>`);
      p.push(`<text x="${(X(hn) + 12).toFixed(1)}" y="${(Y(hl) + 5).toFixed(1)}" fill="${C_HOME}" font-size="14" font-family="JetBrains Mono">us</text>`);
    }
    return p.join('');
  },

  /** Ladder rungs are dated, not aged — same absolute-time rule as obsTime(). */
  obsDate(ts) {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleDateString([], { day: '2-digit', month: 'short' });
  },

  /** Replayed to every new connection — see observatory-ws.js. Without this the
   *  page is blank until the next packet, which on a quiet channel is minutes
   *  and reads as broken. */
  applyObservationsReplay(ev) {
    this.observations = (ev.observations || []).slice(0, MAX_ROWS);
  },

  /** One observation, as it is recorded. */
  applyObservation(ev) {
    const o = ev.observation;
    if (!o) return;
    this.observations = [o, ...this.observations].slice(0, MAX_ROWS);
  },

  // ── Pure renderers. Formatting only; nothing is derived or decided. ────────

  obsTime(ts) {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleTimeString([], { hour12: false });
  },

  /** The receiving radio's label, from the roster the server already pushed.
   *  Falls back to the raw MAC rather than inventing a name. */
  obsRadio(mac) {
    if (!mac) return '—';
    return this.deviceLabel?.(mac) || this.deviceConfigs?.[mac]?.label || mac.slice(0, 8);
  },

  /** A node's short name if the server has sent one, else its raw num. Never
   *  guessed — an unnamed node shows as a number, which is honest.
   *
   *  Looks up by num rather than through nodeById(), which takes a `!hex` id
   *  and threw `nodeId?.startsWith is not a function` 182 times when handed the
   *  numeric entity. An observation's entity is opaque to the engine and
   *  happens to be a node num here; converting it to an id would be this page
   *  asserting a format the store does not guarantee. */
  obsNode(entity) {
    const num = Number(entity);
    if (!Number.isFinite(num)) return entity;
    const n = this.nodes?.find?.(x => x.num === num);
    return n?.user?.short_name || entity;
  },

  /** THE COLUMN THIS PAGE EXISTS FOR. Null is rendered as an em dash, never as
   *  0 — north is a real bearing and a blank must not read as one. */
  obsAz(o) {
    const az = o?.data?.az;
    return (az == null) ? '—' : `${az}°`;
  },

  /** Bearing rows are the ones with information in them; everything else is
   *  context. Used to tint, not to filter — a filtered feed hides how much of
   *  the traffic carries no bearing, which is itself worth seeing. */
  obsHasAz(o) { return o?.data?.az != null; },

  obsNum(v, suffix = '') { return (v == null) ? '—' : `${v}${suffix}`; },

  /** Distinct nodes among the observations ON SCREEN. Describes the list being
   *  rendered, not a fact about the mesh — a mesh-wide count would be a derived
   *  claim and belongs to the server (BROWSER_CONTRACT). Labelled "on screen"
   *  in the UI for exactly that reason. */
  obsNodeCount() { return new Set(this.observations.map(o => o.entity)).size; },

  /** The feed's own summary line. Counting the RENDERED list is expressly
   *  allowed — it describes what is on screen, not a claim about the mesh.
   *
   *  There is no RF/MQTT split here any more and there must not be one: MQTT
   *  arrivals never enter the store (spec §3a), so every row on this page was
   *  heard on air by construction. A column reporting that would be a column
   *  that is always the same. */
  obsFeedSummary() {
    const n = this.observations.length;
    const az = this.observations.filter(o => this.obsHasAz(o)).length;
    return `${n} on screen · ${az} with a bearing`;
  },

  /** Replayed to every new connection — see observatory-ws.js. Without this the
   *  page is blank until the next packet, which on a quiet channel is minutes
   *  and reads as broken. */
  applyObservationsReplay(ev) {
    this.observations = (ev.observations || []).slice(0, MAX_ROWS);
  },

  /** One observation, as it is recorded. */
  applyObservation(ev) {
    const o = ev.observation;
    if (!o) return;
    this.observations = [o, ...this.observations].slice(0, MAX_ROWS);
  },

  // ── Pure renderers. Formatting only; nothing is derived or decided. ────────

  obsTime(ts) {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleTimeString([], { hour12: false });
  },

  /** The receiving radio's label, from the roster the server already pushed.
   *  Falls back to the raw MAC rather than inventing a name. */
  obsRadio(mac) {
    if (!mac) return '—';
    return this.deviceLabel?.(mac) || this.deviceConfigs?.[mac]?.label || mac.slice(0, 8);
  },

  /** A node's short name if the server has sent one, else its raw num. Never
   *  guessed — an unnamed node shows as a number, which is honest.
   *
   *  Looks up by num rather than through nodeById(), which takes a `!hex` id
   *  and threw `nodeId?.startsWith is not a function` 182 times when handed the
   *  numeric entity. An observation's entity is opaque to the engine and
   *  happens to be a node num here; converting it to an id would be this page
   *  asserting a format the store does not guarantee. */
  obsNode(entity) {
    const num = Number(entity);
    if (!Number.isFinite(num)) return entity;
    const n = this.nodes?.find?.(x => x.num === num);
    return n?.user?.short_name || entity;
  },

  /** THE COLUMN THIS PAGE EXISTS FOR. Null is rendered as an em dash, never as
   *  0 — north is a real bearing and a blank must not read as one. */
  obsAz(o) {
    const az = o?.data?.az;
    return (az == null) ? '—' : `${az}°`;
  },

  /** Bearing rows are the ones with information in them; everything else is
   *  context. Used to tint, not to filter — a filtered feed hides how much of
   *  the traffic carries no bearing, which is itself worth seeing. */
  obsHasAz(o) { return o?.data?.az != null; },

  obsNum(v, suffix = '') { return (v == null) ? '—' : `${v}${suffix}`; },

  /** Distinct nodes among the observations ON SCREEN. Describes the list being
   *  rendered, not a fact about the mesh — a mesh-wide count would be a derived
   *  claim and belongs to the server (BROWSER_CONTRACT). Labelled "on screen"
   *  in the UI for exactly that reason. */
  obsNodeCount() { return new Set(this.observations.map(o => o.entity)).size; },

  // obsRelayName() was here and is gone. It looked the name up in this.nodes,
  // which is a FILTERED list — 4 entries at the time — so every relay rendered
  // as a raw number. The server now sends `label` with each relay, which is
  // where a display value belongs anyway (BROWSER_CONTRACT).

  /** Bar width relative to the busiest door. Presentation of pushed values —
   *  the ranking itself was done by the server. */
  obsRelayShare(uses) {
    const top = this.relayUsage[0]?.uses || 0;
    return top ? Math.max(3, Math.round((uses / top) * 100)) : 0;
  },
};
