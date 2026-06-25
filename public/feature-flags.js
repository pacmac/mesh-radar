// ── Feature flags for SSOT refactor (frontend) ───────────────────────────────
//
// Mirror of src/feature-flags.js for the browser.
// Must be kept in sync with src/feature-flags.js — flip both together.
// No pm2 restart needed for public/ changes; hard-refresh browser to pick up.
//
// false = V1 legacy path  |  true = V2 SSOT module path
// ─────────────────────────────────────────────────────────────────────────────

export const FF = {
  SSOT_TRACEROUTE:     true,   // app-ws.js — single route_discovered handler replaces dual raw+event paths
  SSOT_SIGNAL:         false,  // (backend only — no frontend flag needed)
  SSOT_ROUTE_RENDER:   true,   // app-radar.js _drawRadarTraceroute() — args instead of mode checks
  SSOT_SIGNAL_DISPLAY: false,  // app-signal.js — single writer for yagiSignal
  SSOT_WS_BROADCAST:   false,  // (backend only — no frontend flag needed)
};
