# gas_resistance — capture the BME680's fourth reading

Backlog #6, raised again by Peter: *"isn't gas one of the sensors available in
the BME 680?"* It is, and node-dash has been discarding it.

Names `docs/STYLE_GUIDE.md` (§8.6). Contract: `docs/mt-transport/API.md`.

## The gap

`API.md:52` — `TELEMETRY_APP` / `environment_metrics` carries **four** fields:

```
temperature, relative_humidity, barometric_pressure, gas_resistance
°C,          %RH,               hPa,                 MΩ
```

`API.md:175` confirms the source: `@env` returns "temp, hum (+ baro, **gas if
BME680**)". A node reporting barometric pressure has a BME680, so it is
reporting gas too.

Actual state:
- `environment_history` columns: `id ts num temperature relative_humidity barometric_pressure packet_id` — **no gas**
- `grep gas_resistance src/` → **nothing captures it**
- `fmtGas()` already exists in `format.js`, unused

This was filed as backlog #6 on 2026-07-18 and left unfixed through three
subsequent tasks. Unlike a formatting bug, the loss is **unrecoverable** — the
readings are simply never stored, so the gap can never be backfilled. Every
heartbeat since widens it.

## Changes

**1. `src/db.js` — column + statements**

Guarded migration, matching the `packet_id` pattern:

```sql
ALTER TABLE environment_history ADD COLUMN gas_resistance REAL;
```

`insertEnvHistory` gains `@gas_resistance`; `queryEnvHistory` and
`queryAllEnvHistory` select it. The wrapper defaults it to null so existing
callers that pass no gas (the bridge-events replay writer) keep working —
better-sqlite3 throws on a missing named parameter.

**2. `src/persist.js` — capture on both environment paths**

`handleTelemetryEvent` (typed event) and `handlePacket`'s `environment_metrics`
branch both read `m.gas_resistance ?? null`, exactly as they already read the
other three.

**3. `src/node-status.js` — plot it**

Add `{ key: 'gas_resistance', label: 'Gas resistance', unit: 'MΩ' }` to the
environment series spec. Existing rules then apply unchanged: the series is
omitted for any node that does not report it, and the environment chart moves
from 3 units to 4, so `assignAxes` falls through to the magnitude split.

## Deliberately NOT changed

- **`nodes` table / header.** Gas is a series, not an at-a-glance vital, and the
  header shows no environment values today. Adding a column there would be
  scope creep.
- **No backfill** — impossible. The readings were never stored. History for gas
  begins at deploy, and that is worth stating plainly rather than papering over.

## Invariants

- Absent gas omits the series (existing capability rule); it is never plotted
  as zero.
- Dedup unchanged: `(num, packet_id)`.
- The other three environment series are untouched.

## Done when

- `environment_history.gas_resistance` exists and populates from live traffic
- A BME680 node shows a Gas resistance series; a node without one does not
- Existing environment series still render correctly
- 1440×900, both themes, zero console errors
- `check_specs.py` green
