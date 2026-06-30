---
module: rotator-config-schema
source: src/rotator-config-schema.js
source_hash: 22ebb52475dbcdc0db93ea8defb904fde37bcfae29a6d380ba03884f17dd6903
updated: 2026-06-30
---

# Module: rotator-config-schema

## Purpose

Static metadata describing the rotator hardware configuration fields. Used by
`index.js` to serve a machine-readable schema to the browser so the UI can render
rotator configuration forms without hard-coding field definitions.

## Responsibilities

- Export `ROTATOR_CONFIG_SCHEMA` — a pure data constant; no logic, no imports

## Dependencies

None.

## Exports

```js
export const ROTATOR_CONFIG_SCHEMA  // { fields: [...] }
```

## Schema structure

```js
{
  fields: [
    { name: string, type: 'object', fields: FieldDef[] }
  ]
}
```

Each `FieldDef`:

```js
{ name: string, type: 'int'|'float' }
```

## Fields

### `motor` (object)

| Field | Type | Meaning |
|---|---|---|
| `pwm_min` | int | Minimum PWM duty cycle to start movement |
| `pwm_run` | int | Running PWM duty cycle |
| `pulses_per_deg` | float | Encoder pulses per degree of rotation |

### `scan` (object)

| Field | Type | Meaning |
|---|---|---|
| `step_deg` | int | Degrees between scan positions |
| `dwell_sec` | float | Seconds to dwell at each scan position |

### `actv` (object)

| Field | Type | Meaning |
|---|---|---|
| `dwell_sec` | float | Seconds to dwell at each ACTV target position |

## Callers

| Caller | Usage |
|---|---|
| `index.js` | `GET /schema/rotator_config` → `res.json(ROTATOR_CONFIG_SCHEMA)` |

## Invariants

- Pure data — no functions, no imports, no side effects.
- The field values described here (motor PWM, pulses/deg, etc.) are stored in the rotator hardware's own config, not in node-dash's SQLite config table. This schema is metadata for UI rendering only.
- `scan.step_deg` and `scan.dwell_sec` mirror the same config keys that `scanner.js` reads from `scan_config` in the node-dash DB. The schema description here and the scanner's defaults should stay in sync.

## Out of scope

- Config validation — this is metadata only
- Rotator hardware communication — `rotator.js` owns that
- Scan sweep execution — `scanner.js` owns that
