// ── Feature flags for SSOT refactor ─────────────────────────────────────────
//
// Each flag gates a V1 (legacy) / V2 (SSOT) code path pair.
// false = V1 legacy code runs (safe default, no behaviour change)
// true  = V2 SSOT module runs
//
// Convention in code:
//   // ── [V1] LEGACY — remove when <FLAG> verified ────────────────────────
//   if (!FF.FLAG) { ...old code... }
//   // ── [V2] SSOT — <ModuleName> owns this ──────────────────────────────
//   else { ...new module call... }
//   // ─────────────────────────────────────────────────────────────────────
//
// Flip a flag → pm2 restarts automatically (src/ change).
// Both src/ and public/ flags must be flipped together for features that
// span backend + frontend.
//
// Grep '[V1]' → all legacy blocks still in codebase (refactor progress).
// Grep '[V2]' → all new SSOT paths wired in.
// ─────────────────────────────────────────────────────────────────────────────

export const FF = {
  SSOT_TRACEROUTE:     true,   // src/traceroute.js — dispatch, decode, relay_positions, storage, broadcast
  SSOT_SIGNAL:         false,  // src/signal-recorder.js — recordYagiContact, insertRangeTestEntry, confirmScanContact
  SSOT_ROUTE_RENDER:   true,   // app-radar.js _drawRadarTraceroute() — parameterised, no mode checks inside
  SSOT_SIGNAL_DISPLAY: false,  // app-signal.js — single writer for yagiSignal state
  SSOT_WS_BROADCAST:   false,  // ws-relay.js — eliminate index.js broadcastAll() bypass
};
