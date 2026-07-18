// Node focus page — renders an ordered list of server-supplied sections.
//
// BROWSER_CONTRACT.md: the browser makes zero decisions. NODE_STATUS_SPEC iron
// rule 1 goes further for this page — every value arrives already formatted, so
// there is no unit string, no rounding and no date math anywhere in this file.
//
// This module knows THREE section kinds and nothing else. It does not know what
// portnum 260 is, what a detection is, or which port any datum came from. A new
// backend section of a known kind renders with no change here.
//
// Presence and order are server decisions: we render `sections` in the order
// given and never test whether one has content.

const CHART_COLORS = ['#22d3ee', '#a3e635', '#fbbf24', '#f472b6', '#818cf8'];

export const nodeStatusMixin = {
  // ---- entry ---------------------------------------------------------------

  // Tier 2: leave the current page and focus this node. Called from the tier-1
  // summary modal, which stays as the peek that does not navigate away.
  openNodeStatusPage(num) {
    if (!num) return;
    this.$refs.nodeInfoDialog?.close();
    this.setNav('node');
    this.focusNode(Number(num));
  },

  focusNode(num) {
    this.nodeStatusNum = Number(num);
    this.nodeStatus = null;          // null = awaiting reply; the page shows a
                                     // loading state rather than guessing
    this._destroyNodeCharts();
    const id = '!' + (Number(num) >>> 0).toString(16).padStart(8, '0');
    const path = `/node/${id}`;
    if (window.location.pathname !== path) {
      history.pushState({ tab: 'node', num: Number(num) }, '', path);
    }
    this.requestNodeStatus();
  },

  requestNodeStatus() {
    if (!this.nodeStatusNum) return;
    this.wsSend({ type: 'node_status', num: this.nodeStatusNum });
  },

  // ---- WS reply ------------------------------------------------------------

  applyNodeStatus(msg) {
    if (!msg || Number(msg.num) !== Number(this.nodeStatusNum)) return;
    this.nodeStatus = msg;
    this._destroyNodeCharts();
    // Charts are rebuilt wholesale: a refresh replaces the data entirely, so
    // reusing instances would leak canvases (same reason perf destroys on leave).
    this.$nextTick(() => this._renderNodeCharts());
  },

  // Hint carries only a num — never a value. Re-request so there is exactly one
  // code path producing displayed values. Filtering to the focused node is a
  // delivery concern, not a data decision.
  onNodeStatusUpdate(num) {
    if (this.tab !== 'node') return;
    if (Number(num) !== Number(this.nodeStatusNum)) return;
    this.requestNodeStatus();
  },

  // ---- charts --------------------------------------------------------------

  _destroyNodeCharts() {
    for (const c of Object.values(this._nodeCharts || {})) {
      try { c.destroy(); } catch { /* already gone */ }
    }
    this._nodeCharts = {};
  },

  _renderNodeCharts() {
    if (!this.nodeStatus) return;
    this._nodeCharts = this._nodeCharts || {};
    for (const section of this.nodeStatus.sections) {
      if (section.kind !== 'series') continue;
      const el = document.getElementById('nodechart-' + section.id);
      if (!el) continue;
      // Destroy whatever owns this canvas RIGHT NOW, not just what we last
      // tracked. Live hints arrive ~1s apart, so two applyNodeStatus calls can
      // each queue a $nextTick render; both destroys run before either render,
      // and the second render would otherwise hit a canvas the first claimed
      // ("Canvas is already in use"). Chart.getChart is the authority here.
      Chart.getChart(el)?.destroy();
      const dark = document.documentElement.getAttribute('data-theme') === 'business';
      const grid = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
      const tick = dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
      this._nodeCharts[section.id] = new Chart(el.getContext('2d'), {
        type: 'line',
        data: {
          datasets: section.series.map((s, i) => ({
            label: s.unit ? `${s.label} (${s.unit})` : s.label,
            // Points arrive pre-sorted and pre-downsampled; x is a unix second.
            data: s.points.map(p => ({ x: p.t * 1000, y: p.v })),
            borderColor: CHART_COLORS[i % CHART_COLORS.length],
            backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
            borderWidth: 1.5, pointRadius: 0, tension: 0.25, spanGaps: true,
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'nearest', intersect: false },
          plugins: {
            legend: { labels: { color: tick, boxWidth: 10, font: { size: 10 } } },
            tooltip: { callbacks: { title: () => '' } },   // no browser date formatting
          },
          scales: {
            // Visible time axis, WITHOUT browser date math.
            //
            // Chart.js `type: 'time'` needs a date adapter that this app does
            // not load. The existing perf charts work around that with a tick
            // callback doing new Date(val).getHours() — browser-side date
            // formatting, which iron rule 1 forbids for this page.
            //
            // So: a linear axis with tick LABELS SUPPRESSED, and the axis range
            // shown beneath the chart using the server's pre-formatted
            // t_min_text / t_max_text. The axis is visible and labelled, and no
            // date is ever formatted here.
            x: {
              type: 'linear',
              grid: { color: grid },
              ticks: { display: false },
            },
            y: { grid: { color: grid }, ticks: { color: tick, font: { size: 10 } } },
          },
        },
      });
    }
  },
};
