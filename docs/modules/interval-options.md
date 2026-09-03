---
module: interval-options
source:
  - src/interval-options.js
source_hash: 66f1d7cee74f4016670bd9a928c279962afb3f0eafa3ecbc35e1bfd7a410d8bf
updated: 2026-09-03
---

# Bad values are made unenterable, because that is how the phone app does it

**ORPHANED 2026-09-03.** This module's only consumer, `src/radio-admin-api.js`
(`GET /radio-admin/schema/:section`, described below), was deleted along with
the rest of node-dash's device-management surface — task
`devices-management-removed-meshgw-owns-it`, mesh-gw now owns radio config
editing. Nothing imports `decorateSchema` any more. Left in place rather than
deleted here because that deletion is out of this task's scope; tracked at
`interval-options-orphaned-by-radio-admin-removal`. The history below still
describes real, if currently unreachable, code.

Peter, 2026-08-18: *"in fact none of the fields are validated. I can enter any
value I like for things like send freq for metadata, node dash allows it and saves
it an breaks the radio because the vales sent are invalid"*, then *"that schema
MUST exist in phoen app!"*, and *"we should use that becos it works 100% of the
time"*, and finally — correcting my own sequencing — *"well on second thoughts they
are directly related arent they"*.

He is right on all four counts, and the last one is the important one: a save that
can carry a value which breaks the radio is not a **stable** save. Delivery is not
stability. The write path (`radio-admin`) and this are one job.

## Why the app is reliable, and it is not validation

The app does **not** check the number you typed. It never lets you type one.

`feature/settings/.../TelemetryConfigItemList.kt`:

```kotlin
val items = remember { IntervalConfiguration.BROADCAST_SHORT.allowedIntervals }
DropDownPreference(
    title = stringResource(Res.string.device_metrics_update_interval_seconds),
    selectedItem = formState.value.device_update_interval.toLong(),
    items = items.map { it.value to it.toDisplayString() },
    onItemSelected = { formState.value = formState.value.copy(device_update_interval = it.toInt()) },
)
```

A `DropDownPreference` over a curated allowlist. There is no invalid state to
reject, so there is no rejection path to get wrong. **That is the mechanism behind
"works 100% of the time", and it is a UI-shape decision, not a validation
decision.**

Ours was a number box with an advisory `min` attribute — and because the form is
read by JS (`collectForm`) rather than natively submitted, the browser's
constraint validation never runs at all. The attribute decorated a control that
enforced nothing.

## What was ported, and from where

**The tables are not in this module.** They are generated into
`src/interval-tables.js` by `scripts/gen_interval_tables.mjs` from
`vendor/meshtastic-android/FixedUpdateIntervals.kt`, and `npm run check` fails if
the two disagree. See `docs/modules/interval-tables.md` — including the bug the
generator found in the original hand-port of `ALL`.

This module re-exports `INTERVAL_CONFIGURATIONS` and owns only what upstream does
not state: the field → configuration map, the labels, and `decorateSchema`.

From `feature/settings/src/commonMain/kotlin/org/meshtastic/feature/settings/util/FixedUpdateIntervals.kt`
(414 lines):

- **34 named intervals** — `UNSET` (0) through `SEVENTY_TWO_HOURS` (259200), plus
  `ALWAYS_ON` (`Int.MAX_VALUE`, 2147483647).
- **17 configurations**, each naming the subset legal for that setting:
  `ALL`, `BROADCAST_SHORT`, `BROADCAST_MEDIUM`, `BROADCAST_LONG`,
  `NODE_INFO_BROADCAST`, `DETECTION_SENSOR_MINIMUM`, `DETECTION_SENSOR_STATE`,
  `NAG_TIMEOUT`, `OUTPUT`, `PAX_COUNTER`, `POSITION`, `POSITION_BROADCAST`,
  `GPS_UPDATE`, `RANGE_TEST_SENDER`, `SMART_BROADCAST_MINIMUM`,
  `DISPLAY_SCREEN_ON`, `DISPLAY_CAROUSEL`.

`BROADCAST_SHORT` starts at **1800**, which is exactly the `min: 1800` mesh-gw
hand-transcribed into `/schema` as "firmware-enforced". Same number, from the
source that owns it.

**Labels are derived from the seconds**, not ported. The app's labels come from
Android plural string resources; re-implementing that machinery to render "30
minutes" would import a localisation system to solve arithmetic.

## The field → configuration map

The app's enum names line up almost one-to-one with our field names:

| our field | configuration |
|---|---|
| `device_update_interval`, `environment_update_interval`, `air_quality_interval`, `power_update_interval`, `health_update_interval` | `BROADCAST_SHORT` |
| `node_info_broadcast_secs` | `NODE_INFO_BROADCAST` |
| `position_broadcast_secs` | `POSITION_BROADCAST` |
| `broadcast_smart_minimum_interval_secs` | `SMART_BROADCAST_MINIMUM` |
| `gps_update_interval` | `GPS_UPDATE` |
| `screen_on_secs` | `DISPLAY_SCREEN_ON` |
| `auto_screen_carousel_secs` | `DISPLAY_CAROUSEL` |
| `nag_timeout` | `NAG_TIMEOUT` |
| `minimum_broadcast_secs` | `DETECTION_SENSOR_MINIMUM` |
| `state_broadcast_secs` | `DETECTION_SENSOR_STATE` |
| `paxcounter_update_interval` | `PAX_COUNTER` |
| `sender` (range test) | `RANGE_TEST_SENDER` |
| `output`, `output_vibra`, `output_buzzer` | `OUTPUT` |

A field NOT in this map is left exactly as it was. **An unmapped field must not
silently acquire a guessed allowlist** — that would be inventing a constraint,
which is the mirror of the bug being fixed.

## Every numeric-entry advisory is stripped, not just min/max

`decorateSchema` removes `min`, `max`, `hint` **and** `unit` from a mapped field.

The first cut removed only `min`/`max`, and the browser caught the rest: the
telemetry dropdowns rendered still captioned

> min 1800 (firmware-enforced); 0 = use default (3600 s)

over a list whose lowest option is 1800 and which offers no `0` at all — and
labelled `seconds` beside a value reading `30 minutes`. A caption that names a
value the control cannot express is worse than no caption, because it reads as an
instruction. The option labels carry the units now.

## The change

### `src/interval-options.js`

The tables, the map, and `decorateSchema(section, schema)` which rewrites a mapped
field to:

```js
{ name, type: 'choice', options: [{ value: 1800, label: '30 minutes' }, …], … }
```

`type: 'choice'` is a NEW type, deliberately not `enum`. `enum` options are bare
strings used as both value and label, and reusing it would make the select emit
the STRING `"1800"` where the protobuf needs an int — sending a wrong-typed value
to fix wrong-valued ones.

### `src/radio-admin-api.js` — `GET /radio-admin/schema/:section` (DELETED 2026-09-03)

This route served the decorated schema. mesh-gw's `/schema` was untouched and
still the source of the fields themselves; this only replaced the control for
mapped interval fields. Gone along with the rest of `radio-admin-api.js` — see
the ORPHANED note above.

### `public/app-forms.js` — render `choice`

A `<select>` over `{value,label}` options, coercing the selection back to a Number
on read. This is the Domain 2 half and is in the same task deliberately: Peter,
*"they are directly related arent they"* — a backend that offers a choice with no
control to render it changes nothing.

## What this does NOT do

- **No range validation.** There is nothing left to validate: an allowlist has no
  out-of-range state. Free-text numeric fields with no mapping are unchanged and
  still unconstrained — recorded honestly rather than implied fixed.
- **No enum deprecation.** `ROUTER_CLIENT` and `REPEATER` are still offered
  (ledger: `role-dropdown-offers-deprecated-values`). Separate job.
- **No firmware-source parsing.** The protobuf carries no ranges
  (`uint32 device_update_interval = 1;` and a comment); the curated app tables are
  the real source and they are now here.

## Test notes

1. `decorateSchema('telemetry', …)` turns `device_update_interval` into a `choice`
   whose lowest option is 1800 — matching mesh-gw's hand-written `min: 1800`.
2. An unmapped field (e.g. `telemetry.environment_screen_enabled`) is returned
   byte-identical.
3. Every one of the 17 configurations resolves to a non-empty option list.
4. Every option value is an integer, never a string.
5. `GET /radio-admin/schema/telemetry` differs from `GET /schema/telemetry` only in
   the mapped fields.
