---
module: feature-flags
source: src/feature-flags.js
source_hash: f702769c2aa284dc9883d62b15e0a089ddd50dc9e825bafacae7b1a62d33e08d
updated: 2026-06-30
---

# Module: feature-flags

## Purpose

Exports the `FF` object — a set of boolean gates that control which code path runs
during the SSOT refactor. Each flag governs a V1 (legacy inline code) / V2 (dedicated
SSOT module) pair. `false` = V1 runs (safe, no behaviour change). `true` = V2 runs.

Flipping a flag and restarting the process is the only mechanism for switching paths.
No runtime toggling. No config key. No API.

## Responsibilities

- Provide the single source of truth for which SSOT modules are active
- Allow incremental refactor: each subsystem can be cut over independently
- Provide grep anchors `[V1]` and `[V2]` in code to track refactor progress

## Dependencies

_N/A_ — no imports.

## Public interface

```js
export const FF = {
  SSOT_TRACEROUTE:     boolean,
  SSOT_SIGNAL:         boolean,
  SSOT_ROUTE_RENDER:   boolean,
  SSOT_SIGNAL_DISPLAY: boolean,
  SSOT_WS_BROADCAST:   boolean,
}
```

## State

_N/A_ — module-level constants, immutable after load.

## Events emitted

_N/A_

## Flag reference

| Flag | Current | Gates | Checked in |
|---|---|---|---|
| `SSOT_TRACEROUTE` | `true` | `src/traceroute.js` — dispatch, decode, relay_positions, storage, broadcast | `index.js` (×5), `passive-tracer.js` (×2), `ws-relay.js` (×1) |
| `SSOT_SIGNAL` | `false` | `src/signal-recorder.js` — `recordYagiContact`, `insertRangeTestEntry`, `confirmScanContact` | not yet wired |
| `SSOT_ROUTE_RENDER` | `true` | `app-radar.js` — `_drawRadarTraceroute()` parameterised, no mode checks inside | `ws-relay.js` (×1) |
| `SSOT_SIGNAL_DISPLAY` | `false` | `app-signal.js` — single writer for `yagiSignal` state | not yet wired |
| `SSOT_WS_BROADCAST` | `false` | `ws-relay.js` — eliminate `index.js` `broadcastAll()` bypass | not yet wired |

### Code block convention

```js
// ── [V1] LEGACY — remove when SSOT_<FLAG> verified ──────────────────────────
if (!FF.SSOT_FLAG) { /* old inline code */ }
// ── [V2] SSOT — <ModuleName> owns this ──────────────────────────────────────
else { /* new module call */ }
// ────────────────────────────────────────────────────────────────────────────
```

- Grep `[V1]` → all legacy blocks still in codebase (refactor progress indicator)
- Grep `[V2]` → all new SSOT paths wired in

## Invariants

- `false` is always the safe default — the V1 legacy path is production-proven.
- Flags are module-level `const` — they cannot be changed at runtime without a restart.
- A flag set to `true` means the V2 module is proven and the V1 block is dead code pending removal.
- Flags that span both backend (`src/`) and frontend (`public/`) must be flipped together — the two sides share the same flag value because `public/` code does not import this module; the convention is enforced by discipline, not the module system.
- When a V2 path is fully verified: remove the `[V1]` block, remove the `FF.*` check, remove the flag from this file.

## Test notes

- No unit tests for this module itself — it is pure config.
- Each flag's V2 path has its own module tests; those tests are the gate before flipping `true`.
- Regression: flip `SSOT_TRACEROUTE` to `false` → legacy traceroute path should still pass its tests (V1 path must not bitrot while V2 is active).

## Out of scope

- Runtime feature toggling (no API, no config key, no DB read)
- A/B testing or partial rollout — flags are all-or-nothing per process restart
- Frontend flags — `public/` code reads these values only by copying the flag state at deploy time; it does not import this module
