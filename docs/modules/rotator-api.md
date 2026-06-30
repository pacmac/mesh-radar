---
module: rotator-api
source: src/rotator-api.js
source_hash: d388e54645a8299f7e952e967f9885bb102621b594b804eda1498bda7beac757
updated: 2026-06-30
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

## Routes

Mounted at `/rotator` by `index.js`. Paths below are router-relative.

| Method | Path | Action |
|---|---|---|
| GET | `/status` | `{ connected, mode, dash_mode, scan_active, scan_az, scan_dwell_az, scan_contacts, ...fwStatus }` |
| POST | `/move` | `{ az }` → `rotator.move(az)` |
| POST | `/mode` | `{ mode }` → `dashMode.set(mode)`; refused if mode=1 and scan active |
| POST | `/target` | `{ num }` → `activeTracker.targetNum(num)`; requires dashMode=1 |
| POST | `/scan/start` | `scanner.start()` |
| POST | `/scan/abort` | `scanner.abort()` |
| POST | `/calibrate` | `{ procedure }` → `rotator.sendAction(procedure)`; whitelist enforced |
| POST | `/setvar` | `{ action, val }` → `rotator.sendAction(action, [String(val)])`; whitelist enforced |
| POST | `/offset` | `{ offset }` → normalised, `rotator.sendAction('setOffset', [String(offset)])` |
| GET | `/firmware_config` | `{ motor: {pwm_min,pwm_run,pulses_per_deg}, scan: {step_deg,dwell_sec}, actv: {dwell_sec} }` |
| POST | `/firmware_config` | Write motor (via sendAction) and scan/actv (via setConfig) |

**Calibration procedure whitelist:** `['calMotor', 'qmcCali', 'calPwmMin', 'qmcOsStart', 'qmcOsEnd']`

**Setvar action whitelist:** `['setPwmRunPct', 'setPwmFreq', 'setNorthOffset']`

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

## Invariants

- `POST /rotator/mode` with `mode=1` (ACTV) is refused if `scanner.active` — returns `{ refused: true }`.
- `POST /rotator/target` requires `dashMode.value === 1`; returns 409 otherwise.
- `POST /rotator/calibrate` only allows procedures in `ALLOWED` whitelist; 400 on unknown.
- `POST /rotator/setvar` only allows vars in `ALLOWED_VARS` whitelist; 400 on unknown.
- `POST /rotator/offset` normalises offset to `((offset % 360) + 360) % 360`.
- Motor firmware config (`pwm_min`, `pwm_run`, `pulses_per_deg`) is sent to the rotator via `sendAction`; scan/actv config is persisted in SQLite.

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
