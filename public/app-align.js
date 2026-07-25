// Yagi Align mixin — antenna-alignment sub-tab of Control. Presentation only
// (BROWSER_CONTRACT): renders the pushed align view-model (alignModel, from
// pac_host_align — see app-ws.js) and computes nothing. Every derived value
// (quality, label, cls, trendDir, trendDelta, best, gapToBest, bestAgo,
// barPct) is pac-host's job now (API.md "Antenna alignment").
//
// Rebuilt from the archived reference/alarm-integration/public/app-align.js
// (a standalone, framework-free /align page — deliberately no Alpine, to
// survive a CDN outage on a phone at the mast). That constraint doesn't apply
// here: Alpine is vendored locally in this dashboard, not CDN-loaded, so this
// is a normal Alpine mixin like every other Control sub-tab — task
// yagi-align-rebuild, 2026-07-25.
//
// alignTarget/alignNBurst/alignReplyWinInput are the ONLY browser-originated
// values (same invariant the archive stated) — raw input, sent as-is, never
// interpreted here.
import { fetchJSON } from './app-helpers.js';

export const alignMixin = {
  // Targets are node-dash's own favourites list (server-computed, already
  // pushed as `favourites` — see app-ws.js's node_list handler), the exact
  // same source the archived /align/targets route used internally
  // (listFavourites()). No new backend route needed for this.
  alignTargets() { return this.favourites || []; },

  alignTargetLabel() {
    const t = this.alignTargets().find(f => f.num === this.alignTarget);
    return t?.label || '';
  },

  alignBursting() { return !!this.alignModel?.burst?.active; },
  alignRunning()  { return !!this.alignModel?.running; },

  async alignPing() {
    if (!this.alignTarget || this.alignSending || this.alignBursting()) return;
    this.alignSending = true;
    try {
      await fetchJSON('/align/ping', 'POST', { target: this.alignTarget, n: this.alignNBurst });
      // No manual refresh — pac-host.js polls GET /mesh/align every 2s and
      // pushes pac_host_align on change; the burst progress appears on its own.
    } catch (e) {
      this.showToast(e.message || 'Ping failed', 'error', 0);
    } finally {
      this.alignSending = false;
    }
  },

  async alignEnd() {
    try {
      await fetchJSON('/align/stop', 'POST', {});
    } catch (e) {
      this.showToast(e.message || 'End failed', 'error', 0);
    }
  },

  async alignSetReplyWindow() {
    try {
      await fetchJSON('/align/config', 'POST', { replyWindowSec: this.alignReplyWinInput });
    } catch (e) {
      this.showToast(e.message || 'Reply-window update failed', 'error', 0);
    }
  },
};
