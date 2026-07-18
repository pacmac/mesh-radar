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

// STYLE_GUIDE §4: no raw hex. themeColor() reads the per-theme DaisyUI custom
// properties, so series re-colour correctly in both themes.
const SERIES_ROLES = ['primary', 'success', 'warning', 'info', 'secondary'];
const seriesColor = i => window.themeColor(SERIES_ROLES[i % SERIES_ROLES.length]);

// Chart instances live HERE, at module scope — never on `this`.
//
// Anything assigned to an Alpine data property is wrapped in a reactive Proxy.
// Chart.js walks its own internals during update(), and through a Proxy that
// recurses until "Maximum call stack size exceeded", or corrupts scale config
// ("Cannot set properties of undefined (setting 'fullSize')"). Observed
// 2026-07-18. A chart is an imperative object, not display state.
const _charts = new Map();   // section id → Chart

// Chart.js bakes option colours in at draw time, so a chart built in one theme
// keeps that theme's tick/legend colours — invisible text after a switch. The
// data path only recolours on the next live update, which for a quiet node may
// never come, so watch the theme attribute directly.
function _chartThemeColors() {
  const bc = getComputedStyle(document.documentElement).getPropertyValue('--bc').trim();
  return {
    grid: bc ? `oklch(${bc} / 0.10)` : 'transparent',
    tick: bc ? `oklch(${bc} / 0.60)` : 'currentColor',
  };
}

function _recolourCharts() {
  const { grid, tick } = _chartThemeColors();
  for (const c of _charts.values()) {
    c.options.plugins.legend.labels.color = tick;
    c.options.scales.x.grid.color = grid;
    c.options.scales.x.ticks.color = tick;   // axis labels too — easily missed
    c.options.scales.y.grid.color = grid;
    c.options.scales.y.ticks.color = tick;
    if (c.options.scales.y.title) c.options.scales.y.title.color = tick;
    // y1 exists only on dual-axis charts — omitting it here is how the x-axis
    // labels ended up invisible after a theme switch.
    if (c.options.scales.y1) {
      c.options.scales.y1.ticks.color = tick;
      if (c.options.scales.y1.title) c.options.scales.y1.title.color = tick;
    }
    c.update('none');
  }
}

new MutationObserver(_recolourCharts)
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

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
    this.wsSend({
      type: 'node_status',
      num: this.nodeStatusNum,
      window_h: this.nodeWindowHours,
    });
  },

  // User input forwarded to the backend — BROWSER_CONTRACT permits handling raw
  // input before sending it. The browser does NOT slice or re-bucket anything;
  // it re-requests and renders whatever comes back.
  setNodeWindow(hours) {
    this.nodeWindowHours = hours;
    window.persistSet('nodeWindowHours', hours);
    this.requestNodeStatus();
  },

  // ---- WS reply ------------------------------------------------------------

  applyNodeStatus(msg) {
    if (!msg || Number(msg.num) !== Number(this.nodeStatusNum)) return;
    // Signature includes the axis shape: a node that only starts reporting
    // pressure keeps the same section id, so comparing ids alone would leave a
    // chart that can never grow its second axis.
    const sig = secs => (secs || []).map(s => `${s.id}:${s.axes?.y1 ? 2 : 1}`).join(',');
    const prevIds = sig(this.nodeStatus?.sections);
    const nextIds = sig(msg.sections);
    this.nodeStatus = msg;
    // Charts are NOT destroyed on refresh. An active node hints ~1/sec, and
    // tearing a chart down mid-animation made Chart.js draw to a dead context
    // ("Cannot read properties of null (reading 'save')") — which is why the
    // charts appeared blank. Chart.js is built to be updated in place.
    // Rebuild only when the set of sections actually changes.
    if (prevIds !== nextIds) this._destroyNodeCharts();
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
    for (const c of _charts.values()) {
      try { c.destroy(); } catch { /* already gone */ }
    }
    _charts.clear();
  },

  _renderNodeCharts() {
    if (!this.nodeStatus) return;
    for (const section of this.nodeStatus.sections) {
      if (section.kind !== 'series') continue;
      const el = document.getElementById('nodechart-' + section.id);
      if (!el) continue;

      const datasets = section.series.map((s, i) => ({
        label: s.unit ? `${s.label} (${s.unit})` : s.label,
        // Points arrive pre-sorted and pre-downsampled; x is a unix second.
        data: s.points.map(p => ({ x: p.t * 1000, y: p.v })),
        borderColor: seriesColor(i),
        backgroundColor: seriesColor(i),
        borderWidth: 1.5, pointRadius: 0, tension: 0.25, spanGaps: true,
        // Axis assignment is server-decided — bound, never computed here.
        yAxisID: s.axis || 'y',
      }));

      // Chart internals are §2's sanctioned exception, but a theme-BLIND value
      // is a §4 violation — so derive grid/tick from the theme's own
      // base-content rather than hardcoding light/dark pairs. Re-read on EVERY
      // pass: colours are baked into a chart at creation, so a chart built in
      // one theme renders invisible text after a theme switch unless its
      // options are refreshed too.
      const { grid, tick } = _chartThemeColors();

      // Update in place when the chart already exists — no teardown, no
      // flicker, no draw-after-destroy. Chart.getChart is the authority on
      // what currently owns this canvas.
      // Positions come from the server; labels are printed verbatim. This is a
      // lookup of server-supplied strings, not formatting.
      const tickVals   = (section.ticks || []).map(t => t.t * 1000);
      const tickLabels = new Map((section.ticks || []).map(t => [t.t * 1000, t.label]));

      const existing = _charts.get(section.id) ?? Chart.getChart(el);
      if (existing) {
        existing.data.datasets = datasets;
        existing.options.scales.x.afterBuildTicks = ax => { ax.ticks = tickVals.map(v => ({ value: v })); };
        existing.options.scales.x.ticks.callback = v => tickLabels.get(v) ?? '';
        existing.options.scales.x.ticks.color = tick;
        existing.options.plugins.legend.labels.color = tick;
        existing.options.scales.x.grid.color = grid;
        existing.options.scales.y.grid.color = grid;
        existing.options.scales.y.ticks.color = tick;
        if (existing.options.scales.y1) existing.options.scales.y1.ticks.color = tick;
        existing.update('none');
        _charts.set(section.id, existing);
        continue;
      }
      _charts.set(section.id, new Chart(el.getContext('2d'), {
        type: 'line',
        data: { datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          // A live instrument should not re-animate every second, and this
          // closes the draw-after-teardown window entirely.
          animation: false,
          // axis:'xy' — without it proximity is judged on x alone, every series
          // has a point at that x, so all of them tie and the tooltip lists the
          // lot. Nearest in two dimensions reports the hovered line only.
          interaction: { mode: 'nearest', axis: 'xy', intersect: false },
          plugins: {
            legend: { labels: { color: tick, boxWidth: 10 } },
            tooltip: {
              callbacks: { title: () => '' },   // no browser date formatting
              // 'nearest' can return two adjacent points of the SAME series
              // when they tie on distance, which renders the line twice.
              // Keep the first entry per dataset so a hover reports exactly one.
              filter: (item, i, arr) => arr.findIndex(a => a.datasetIndex === item.datasetIndex) === i,
            },
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
              // Tick POSITIONS and LABELS both come from the server. Chart.js
              // type:'time' would need a date adapter this app does not load,
              // and the perf workaround formats dates in the browser — which
              // iron rule 1 forbids here.
              afterBuildTicks: ax => { ax.ticks = tickVals.map(v => ({ value: v })); },
              ticks: {
                color: tick,
                autoSkip: false,
                maxRotation: 0,
                callback: v => tickLabels.get(v) ?? '',
              },
            },
            y: {
              position: 'left',
              grid: { color: grid },
              ticks: { color: tick },
              title: { display: !!section.axes?.y?.label, text: section.axes?.y?.label || '', color: tick },
            },
            // Right axis exists ONLY when the server sent a y1 group, so a
            // single-magnitude chart keeps one axis and no empty gutter.
            ...(section.axes?.y1 ? {
              y1: {
                position: 'right',
                grid: { drawOnChartArea: false },
                ticks: { color: tick },
                title: { display: !!section.axes.y1.label, text: section.axes.y1.label || '', color: tick },
              },
            } : {}),
          },
        },
      }));
    }
  },
};
