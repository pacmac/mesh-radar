---
module: node-status
source: src/node-status.js
source_hash: f6f0baf38c9a491a9ac95a3f3357789e0f4358f56b5e1e73cf79eee66ab07070
updated: 2026-07-29
---

# Module: node-status

## Purpose

Builds the `node_status` payload: an **ordered list of display-ready sections**
for any node in the mesh. Works for ANY node — it is not restricted to a
designated subset.

## Responsibilities

- Query the node's identity and standard history
- Decide **which sections exist** for this node (presence follows real data)
- Decide **what order** sections appear in
- Format every displayed value via `format.js` so the browser formats nothing

## Dependencies

- `db.js` — `stmts` (read-only queries), `getConfig` (home position)
- `format.js` — all display strings
- `utils.js` — `numToNodeId`, `signalQuality`, `bearing`

## Public interface

```js
buildNodeStatus(num, windowHours?)
// → { num, found, header, sections: [...] }
// → { num, found: false, header: null, sections: [] } for an unknown node
```

## The section-kinds contract

The browser knows a small fixed vocabulary of section **kinds** and nothing
else. It does not know which port a datum came from or how data was ingested.

| kind | shape |
|---|---|
| `value_grid` | `{ fields: [{label, raw, text, ts}] }` |
| `series` | `{ series: [{key, label, unit, points:[{t,v,min,max}]}], t_min, t_max, t_min_text, t_max_text }` |
| `event_log` | `{ events: [{ts, ts_text, ts_ago, label, text}] }` |

Adding a port, a `type` or a field later is a change to **this file alone** —
the browser is never touched again.

## Sections emitted (source-grouped, fixed order)

| id | kind | source | present when |
|---|---|---|---|
| `reachability` | `value_grid` | **pac-host `_units`** (not SQLite) | pac-host holds a unit for this num |
| `device_vitals` | `series` | `device_metrics_history` | ≥1 row in window |
| `signal` | `series` | `signal_history` | ≥1 usable row in window |
| `environment` | `series` | `environment_history` | ≥1 row in window |
| `air_quality` | `series` | gas baseline + `environment_history` | gas rows exist |
| `detections` | `event_log` | `detection_events` | ≥1 row in window |

Grouping is source-based and follows `NODE_STATUS_SPEC`.

### `reachability` — task `node-page-reachability`, 2026-07-29

Full contract in `docs/REACHABILITY_SPEC.md`. The essentials that must not be
re-derived:

**Ordered FIRST.** The other sections answer what a unit *is*; this one answers
whether we can *reach* it, which is the only reason anyone opens this page for an
alarm unit.

**The only section not sourced from our own SQLite.** Joined here, via
`pac-host.unitForNum()`, and **never in the browser** — pac-host's roster reaches
the browser on a different WS message, so merging the two client-side to decide
what a tile says would be the browser deciding, and would create a second code
path for one displayed value.

**Time units.** Every pac-host instant is epoch **milliseconds**; `fmtAgo`,
`fmtUntil` and `fmtStamp` take epoch **seconds**. `msToSec()` does the divide
once, at this boundary. Missing it is silent and yields a plausible wrong answer.

**`nextWake` uses `fmtUntil`, never `fmtAgo`** — see `docs/modules/format.md`.

**Fields that carry NO age, deliberately:** `Beat`, `Window`, `Awake`,
`TX radio`. pac-host does not record when those were established and will not
invent a timestamp; under the mechanical `<field>At` convention an absent sibling
is *detectable*, so they render undated rather than borrowing another field's
instant or being stamped with `now()`.

**Three cases where a wrong rendering would be worse than none:**

- `acks: null` → `"not yet asked"` + *"no command has been sent to this unit"*.
  Never a blank, never a failure state. Peter must be able to tell *not yet
  asked* from *asked and got nothing* at a glance.
- `wakesExpected: null` → the field is **omitted entirely**. An always-listening
  unit does not wake, so there is no denominator and no percentage exists.
  `wakesExpected: 0` is different — a real denominator that happens to be zero —
  and renders `"<n> seen"` + *"none expected in this window yet"*. Both make a
  percentage impossible for different reasons, so they must not print the same
  string. Neither path divides.
- Delivery keeps **five numbers, never one boolean**. `sends` counts POSTs
  mesh-gw *accepted*, not transmissions: 15 of GARG's 131 sends in one day never
  left the radio and every one was counted as a send. `transmitted < sends` is
  stated explicitly; equality is left unsaid because "1/1 left the radio" is
  noise and the gap is the point.

**Radio naming** goes through `node-label.resolveDeviceLabel`, the app's SSOT —
user alias, then `short_name`, then an honest fallback. It accepts a BLE MAC or a
`!hex` id, so the same radio cannot be called two different things on two parts
of one page. Without it the section printed `!2687afb1` and `TA2y` beside a
sidebar reading OMNI and YAGI.

Verified live 2026-07-29 against `GET /v1/mesh/devices` for both units, plus two
non-pac-host nodes confirming the section is absent and their own sections are
unaffected.

Position is part of `header.position`, not a section. Latitude and longitude
use nodeinfo-first precedence; bearing is computed server-side from configured
home coordinates. When coordinates exist but home coordinates do not, the
header emits the server-owned `—` bearing placeholder.

## Invariants

- **Presence is a server decision.** A section with no data is ABSENT from
  `sections`, never present-and-empty. A browser-side `x-if="data.length"` would
  be the browser deciding — forbidden by iron rule 1.
- **Order is a server decision**, for the same reason.
- Every field carries `raw` + `text` (+ `ts` where meaningful). The browser binds
  `text` verbatim.
- A field whose formatted text is null **or empty string** is dropped — an empty
  array (e.g. the device's `pts`) must not render as a blank row.
- Series are time-bucketed to ≤200 points. `v` is the bucket mean and `min`/`max`
  retain the observed envelope for readability without hiding spikes.
- Nothing here is sourced from a text command reply.
- Header shows values, never verdicts: no health pill, no "battery low".
- Header signal bars/labels and position/bearing are computed server-side.
- **`buildSignal`'s `desc` carries staleness provenance (task
  `node-signal-freeze`, 2026-07-25).** `node.rssi`/`node.snr` are gated
  direct-only at write time and freeze indefinitely once a node goes
  relay-only (see `docs/modules/db.md`'s `nodes` note); `desc` is
  `"direct {fmtAgo(latestSignalTs)}"` from `stmts.latestSignalTs` (most
  recent `signal_history` row for the node) so the card always shows how
  old the displayed reading actually is, same provenance treatment as
  `hopsField`'s "verified"/"reported" desc. `null` only if the node has no
  `signal_history` row at all, which should not happen whenever
  `rssi`/`snr` are non-null since both share the same `isDirect` gate.

## Test notes

- Env-only sensor node → `environment`, header position when known, no `device_vitals`
- Unknown num → `{found:false, sections:[]}`, no throw
- Empty array value → field omitted, not a blank row
- Verified live 2026-07-25 (GARG, num 2364420971, relay-only for ~5h):
  `signal.desc` = `"direct 5h ago"`, confirming a frozen -39dBm/Excellent
  reading is correctly flagged as stale rather than shown as current.

## Out of scope

- Ingestion/storage — `persist.js` and `db.js` own those
- WS transport and the live-push hint — `ws-relay.js`
- Rendering — the browser, which decides nothing
