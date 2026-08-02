---
module: rotator-api
source: src/rotator-api.js
source_hash: 9078e54e0af933b2e425280ba21f6c0a4c18bb3b0de1918d41a09c7a0290eb50
updated: 2026-07-07
---

# Module: rotator-api

## Purpose

Express Router owning all `/rotator/*` REST endpoints. Extracted from `index.js`.
Provides browser-facing control of the rotator hardware: movement, mode selection,
targeting, scan control, calibration, and firmware config read/write.

## Responsibilities

- Serve `GET /rotator/status` — combined rotator/dashMode/scanner state
- Serve `POST /rotator/move` — command an azimuth move
- Serve `POST /rotator/mode` — set dashboard mode (PASV/ACTV/SCAN)
- Serve `POST /rotator/target` — set ACTV target node (num)
- Serve `POST /rotator/scan/start` and `/scan/abort` — scan lifecycle
- Serve `POST /rotator/calibrate` — send named calibration procedure
- Serve `POST /rotator/setvar` — set named hardware variable
- Serve `POST /rotator/offset` — set azimuth north offset (normalised to 0–360)
- Serve `GET /rotator/firmware_config` — read motor/scan/actv config composite
- Serve `POST /rotator/firmware_config` — write motor/scan/actv config
- Serve `POST /rotator/active` — switch the active rotator target (v4/v5)
- Serve `POST /rotator/config` — set one v5 device config value; returns the
  device's `{ ok, msg, value }` reply (the device is the single validator).
  Task `rotator-device-schema-backend`. v4 keeps the hardcoded
  `firmware_config` path unchanged.

**Variant-aware.** The hardware-facing routes (`/calibrate`, `/setvar`,
`/offset`, `/firmware_config`) select their command vocabulary by
`rotator.variant`. The v4 maps are unchanged; v5 maps are added. See
`docs/ROTATOR_API_V5.md` for the v5 command surface. The browser sending the
correct per-variant field names is a separate Domain-2 task; until then the
v4 path is byte-for-byte identical to before.

## Routes

Mounted at `/rotator` by `index.js`. Paths below are router-relative.

| Method | Path | Action |
|---|---|---|
| GET | `/status` | `{ connected, variant, active_target, targets, mode, dash_mode, scan_active, scan_az, scan_dwell_az, scan_contacts, ...fwStatus }` |
| POST | `/active` | `{ name }` → `rotator.setActiveTarget(name)`; 404 on unknown target |
| POST | `/config` | `{ id, value }` → `await rotator.setConfigValue(id, value)` → `{ ok, msg, value }` (device's `evt:reply`); 400 if `id`/`value` missing. v5 only — the device validates. |
| POST | `/move` | `{ az }` → `rotator.move(az)`; **PASV-only** — 409 `{refused}` in ACTV or during a scan |
| POST | `/mode` | `{ mode }` → `dashMode.set(mode)`; refused if mode=1 and scan active |
| POST | `/target` | `{ num }` → `activeTracker.targetNum(num)`; requires dashMode=1 |
| POST | `/scan/start` | `scanner.start()` |
| POST | `/scan/abort` | `scanner.abort()` |
| POST | `/calibrate` | `{ procedure }` → `rotator.sendAction(procedure)`; per-variant whitelist |
| POST | `/setvar` | `{ action, val }` → `rotator.sendAction(action, [String(val)])`; per-variant whitelist |
| POST | `/offset` | `{ offset }` → normalised, `sendAction(offsetCmd, [String(offset)])` (v4 `setOffset`, v5 `caloffset`) |
| GET | `/firmware_config` | motor read from status per variant; `scan`/`actv` from DB |
| POST | `/firmware_config` | Write motor (via sendAction, per variant) and scan/actv (via setConfig) |

**Per-variant command maps** (selected by `rotator.variant`, default `v4`):

| Route | v4 | v5 |
|---|---|---|
| calibrate whitelist | `calMotor, qmcCali, calPwmMin, qmcOsStart, qmcOsEnd` | `dirtest, caltrue, caloffset, encsign` |
| setvar whitelist | `setPwmRunPct, setPwmFreq, setNorthOffset` | `cur, hold, spd, ms, trackband, trackdelay` |
| offset command | `setOffset` | `caloffset` |
| firmware_config motor read (status) | `pwm_min←pwmMin, pwm_run←pwmRun, pulses_per_deg←ppd` | `run_ma←curMa, hold_pct←holdPct, sps←sps, usteps←usteps` |
| firmware_config motor write (sendAction) | `pwmMin, pwmRun, ppd` | `cur, hold, spd, ms` |

**Firmware config defaults:** `scan.step_deg=5`, `scan.dwell_sec=60`, `actv.dwell_sec=90`

## Dependencies

- `rotator.js` — `rotator` (status, move, sendAction, connected)
- `scanner.js` — `scanner` (active, az, dwellAz, contacts, start, abort)
- `dash-mode.js` — `dashMode` (value, set)
- `active-tracker.js` — `activeTracker` (targetNum)
- `db.js` — `getConfig`, `setConfig` (scan_config, actv_config)

## Public interface

```js
export default router  // Express Router — mounted at /rotator by index.js
```

## State

_N/A_ — all state lives in rotator.js, scanner.js, dashMode.js, db.js.

## Events emitted

_N/A_

## DISC is refused during a scan, on the same terms as ACTV

`POST /mode` already refused ACTV while the scanner was running. DISC aims the
YAGI at each mission's bearing, so it collides with a sweep in exactly the same
way and is refused identically. SCAN takes precedence over every mode that wants
to point the rotator.

## Invariants

- `POST /rotator/move` (manual point) is **PASV-only**: refused with 409 `{ refused: true, reason }` when `dashMode.value === 1` (ACTV — active-tracker owns the rotator) or `scanner.active` (scan owns it). This is a backend control — the browser must not decide it. Rationale: a competing manual `move2az` aborts the in-progress closed-loop move on v5 and stutters the motor.
- `POST /rotator/mode` with `mode=1` (ACTV) is refused if `scanner.active` — returns `{ refused: true }`.
- `POST /rotator/target` requires `dashMode.value === 1`; returns 409 otherwise.
- `POST /rotator/calibrate` only allows procedures in the active variant's whitelist; 400 on unknown.
- `POST /rotator/setvar` only allows vars in the active variant's whitelist; 400 on unknown.
- `POST /rotator/offset` normalises offset to `((offset % 360) + 360) % 360`; command name is per-variant.
- Motor firmware config is sent to the rotator via `sendAction` (per-variant command names); scan/actv config is persisted in SQLite.
- `POST /rotator/active` returns 404 for a target name not in `rotator.targets`; on success reconnects to the new device and returns `{ active }`.
- Whitelist selection defaults to the v4 map when `rotator.variant` is null (not yet detected).

## Test notes

- **GET /rotator/status**: returns `{ connected, mode, scan_active, scan_az, scan_contacts, ...fwStatus }`.
- **POST /rotator/mode — scan active**: `{ refused: true }` not `{ mode }`.
- **POST /rotator/target — wrong mode**: 409.
- **POST /rotator/calibrate — unknown**: 400.
- **POST /rotator/offset — normalisation**: `-10` → `350`.

## Out of scope

- Rotator hardware communication — `rotator.js` owns that.
- Scan sweep execution — `scanner.js` owns that.
- Mode persistence across restarts — `dash-mode.js` and `db.js` own that.
