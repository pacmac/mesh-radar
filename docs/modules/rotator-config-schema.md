---
module: rotator-config-schema
source: src/rotator-config-schema.js
source_hash: 4542d0abdeb1e44cd43df59a065f2e1d9b308ac8d9d88423c8f11a014938b7b1
updated: 2026-07-07
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
export const ROTATOR_CONFIG_SCHEMA  // { fields: [...], variants: { v4, v5 } }
```

## Schema structure

Backward-compatible: the top-level `fields` still describes the **v4** form
(so the current browser settings UI keeps rendering unchanged), and a
`variants` map adds a per-firmware schema. A later Domain-2 browser task
picks `variants[rotator.variant].fields`; until then the legacy `fields`
path is authoritative. `index.js` serves the whole object verbatim at
`GET /schema/rotator_config` — its call site is unchanged.

```js
{
  fields: FieldGroup[],              // == variants.v4.fields (legacy)
  variants: {
    v4: { fields: FieldGroup[] },
    v5: { fields: FieldGroup[] },
  }
}
```

`FieldGroup` = `{ name, type:'object', fields: FieldDef[] }`;
`FieldDef` = `{ name, type:'int'|'float' }`.

## Fields

### v4 `motor` (PWM DC motor)

| Field | Type | Meaning |
|---|---|---|
| `pwm_min` | int | Minimum PWM duty cycle to start movement |
| `pwm_run` | int | Running PWM duty cycle |
| `pulses_per_deg` | float | Encoder pulses per degree of rotation |

### v5 `motor` (NEMA8 stepper / TMC2209)

| Field | Type | Meaning |
|---|---|---|
| `run_ma` | int | RMS run current (mA) |
| `hold_pct` | int | Hold current as % of run |
| `sps` | int | Cruise step rate (steps/s) |
| `usteps` | int | Microstepping (changes steps/degree) |

### `scan` (object, both variants)

| Field | Type | Meaning |
|---|---|---|
| `step_deg` | int | Degrees between scan positions |
| `dwell_sec` | float | Seconds to dwell at each scan position |

### `actv` (object, both variants)

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
