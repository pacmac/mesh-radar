// ── Feature flags for SSOT refactor (frontend) ───────────────────────────────
//
// Mirror of src/feature-flags.js for the browser.
// Must be kept in sync with src/feature-flags.js — flip both together.
// No pm2 restart needed for public/ changes; hard-refresh browser to pick up.
//
// false = V1 legacy path  |  true = V2 SSOT module path
// ─────────────────────────────────────────────────────────────────────────────

export const FF = {
  // SSOT_TRACEROUTE removed 2026-08-17 — its only consumer was the legacy
  // raw-packet block in app-ws.js, deleted with the traceroute surface.
  // Spec: docs/modules/traceroute-removal-browser.md.
  //
  // SSOT_ROUTE_RENDER STAYS. It reads as traceroute-shaped and is not: it gates
  // whether the radar builds its display context from the backend's
  // radar_context event or falls back to deciding locally. Three live call
  // sites still branch on it (app-radar.js:137, app-ws.js:601,
  // app-components.js:21), and removing it would make them read `undefined` —
  // falsy — and silently drop the radar onto the V1 path.
  SSOT_SIGNAL:         false,  // (backend only — no frontend flag needed)
  SSOT_ROUTE_RENDER:   true,   // app-radar.js — radar display state from radar_context
  SSOT_SIGNAL_DISPLAY: false,  // app-signal.js — single writer for yagiSignal
  SSOT_WS_BROADCAST:   false,  // (backend only — no frontend flag needed)
};
