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

// No fetch import. This module makes no HTTP request of any kind — the board
// arrives over the socket.

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

  /** Ask for the board. ONE message over the socket, not five GETs.
   *
   *  Peter, 2026-08-13: "no HTTP GETS for live data, ws feeds for everything
   *  except static data / forms." This was five fetches on page load and five
   *  more on every window change — the clearest violation on the page.
   *
   *  Fire-and-forget: the reply arrives as a `snapshot` message and is applied
   *  by the handler below. Nothing here awaits, because a socket reply is not a
   *  return value. */
  loadSnapshot() {
    this.snapLoading = true;
    this.snapError = '';
    // ONE window for every band. The board previously mixed all-time, 30-day
    // and today in a single view, so every band asks with the same `days`.
    this.wsSend?.({ type: 'snapshot', days: this.snapWindow });
  },

  /** The board arrived. */
  onSnapshot(msg) {
    // A reply for a window we have already moved off is DROPPED — two rapid
    // window clicks race, and the loser must not paint bands describing a
    // window the badge no longer shows. Addressing, not a decision: the server
    // said which window it answered.
    //
    // EXCEPT for the first board. The connect replay arrives at the SERVER's
    // default window, which need not match the one this page happens to be
    // showing; dropping it would leave the board empty until something else
    // asked. So the first payload is accepted whatever its window, and the
    // badge follows it — the server owns the default.
    const haveBoard = !!this.snapFrontier;
    if (haveBoard && msg?.days != null && Number(msg.days) !== Number(this.snapWindow)) return;
    if (!haveBoard && Number.isFinite(Number(msg?.days))) this.snapWindow = Number(msg.days);

    this.snapLoading = false;
    if (msg?.error) {
      this.snapError = msg.error;
      this.snapFrontier = null; this.snapDist = null;
      this.snapNew = null; this.snapProd = null; this.snapHealth = null;
      return;
    }
    this.snapError = '';
    this.snapFrontier = msg.frontier ?? null;
    this.snapDist     = msg.distribution ?? null;
    this.snapNew      = msg.new_ground ?? null;
    this.snapProd     = msg.productivity ?? null;
    this.snapHealth   = msg.health ?? null;
    // Trust the payload's window over the local one — if the server clamped or
    // rejected the value, the badge must show what was actually applied.
    if (Number.isFinite(this.snapFrontier?.window_days)) {
      this.snapWindow = this.snapFrontier.window_days;
    }
  },

  /** Clusters were all created by a single auto-seed run, so the count is the
   *  same in every window that reaches past it. Saying WHEN removes the
   *  ambiguity between "correct" and "hard-coded". */
  get snapClusterWhen() {
    const t = this.snapNew?.clusters_seeded_at;
    if (!t) return `${this.snapNew?.clusters_total ?? '?'} known`;
    const hrs = Math.round((Date.now() / 1000 - t) / 3600);
    const when = hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
    return `${this.snapNew?.clusters_sources || ''} · ${when}`;
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
