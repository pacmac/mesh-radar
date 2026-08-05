// ── Snapshot board (Domain 2) ────────────────────────────────────────────────
//
// Presentation only. Every value is computed in Node and served by
// GET /snapshot/frontier — this file fetches and renders, it derives nothing
// (BROWSER_CONTRACT).
//
// WHY THIS FILE EXISTS AT ALL: the window buttons shipped as static markup. A
// control that looks live and does nothing is the exact defect that had just
// been fixed on the callout transmit toggle hours earlier, and it is worse than
// no control because it is trusted. Peter: "the date range selector does not
// work. so much for your tests."
//
// Increment 1 of 6 is wired: the hero band. Bands 2-5 are still static values
// and are LABELLED as not following the window, rather than silently ignoring
// it — a number that quietly disobeys the control above it is how the board
// showed an all-time 189.1 km under a 7D badge.

import { fetchJSON } from './app-helpers.js';

export const snapshotMixin = {
  snapWindow: 1,            // days; 0 = all-time, matching config-api WINDOW_DAYS
  snapLoading: false,
  snapError: '',
  snapFrontier: null,       // the served payload, rendered verbatim
  snapDist: null,           // distance bands + doors
  snapNew: null,            // new ground
  snapProd: null,           // attempts / answered / daily series
  snapHealth: null,         // observable machine state, with gaps admitted

  /** Sparkline path from the served daily series — geometry only, no analysis.
   *  The previous chart was a hand-plotted polyline that looked like data. */
  get snapSparkPoints() {
    const d = this.snapProd?.daily || [];
    if (d.length < 2) return '';
    const max = Math.max(10, ...d.map(x => x.rate_pct ?? 0));
    const W = 560, H = 100;
    return d.map((x, i) => {
      const px = (i / (d.length - 1)) * W;
      const py = H - ((x.rate_pct ?? 0) / max) * H;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    }).join(' ');
  },

  get snapSparkLabels() {
    const d = this.snapProd?.daily || [];
    return d.length ? { first: d[0].day.slice(5), last: d[d.length - 1].day.slice(5) } : null;
  },

  /** Switch the window and refetch. The button set is served vocabulary in
   *  increment 6; until then it is declared once in the markup. */
  async setSnapWindow(days) {
    if (this.snapLoading || days === this.snapWindow) return;
    this.snapWindow = days;
    await this.loadSnapshot();
  },

  async loadSnapshot() {
    this.snapLoading = true;
    this.snapError = '';
    try {
      // ONE window for every band. The board previously mixed all-time, 30-day
      // and today in a single view, so all four load with the same `days`.
      const w = this.snapWindow;
      const [dist, ng, prod] = await Promise.all([
        fetchJSON(`/snapshot/distribution?days=${w}`),
        fetchJSON(`/snapshot/new-ground?days=${w}`),
        fetchJSON(`/snapshot/productivity?days=${w}`),
      ]);
      this.snapHealth = await fetchJSON('/snapshot/health');   // not window-scoped
      this.snapDist = dist; this.snapNew = ng; this.snapProd = prod;
      // The server owns the default; ?days only overrides for this call.
      this.snapFrontier = await fetchJSON(`/snapshot/frontier?days=${this.snapWindow}`);
      // Trust the payload's window over the local one — if the server clamped or
      // rejected the value, the badge must show what was actually applied.
      if (Number.isFinite(this.snapFrontier?.window_days)) {
        this.snapWindow = this.snapFrontier.window_days;
      }
    } catch (e) {
      this.snapError = e.message || 'Could not load the snapshot';
      this.snapFrontier = null; this.snapDist = null;
      this.snapNew = null; this.snapProd = null; this.snapHealth = null;
    } finally {
      this.snapLoading = false;
    }
  },

  /** The window as the labels say it, driven by the SERVED window_days — so a
   *  caption can never claim "24h" while the numbers are all-time. That mismatch
   *  is exactly what the static page shipped. */
  get snapWindowLabel() {
    const d = this.snapFrontier?.window_days ?? this.snapWindow;
    return d === 0 ? 'all time' : d === 1 ? '24h' : `${d}d`;
  },

  /** Format a served distance. Null means "no evidence in this window" and is
   *  drawn as a dash — NOT as zero, which would read as "we reached nothing"
   *  when the truth is "we have not looked". */
  snapKm(v) {
    return (v == null || !Number.isFinite(v)) ? '—' : String(v);
  },
};
