---
module: node-status
source: src/node-status.js
source_hash: b7aef893417ace2d68a5a30a144b0fc4eece82fb4f246dbdd7b3704026196862
updated: 2026-07-24
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
| `device_vitals` | `series` | `device_metrics_history` | ≥1 row in window |
| `signal` | `series` | `signal_history` | ≥1 usable row in window |
| `environment` | `series` | `environment_history` | ≥1 row in window |
| `air_quality` | `series` | gas baseline + `environment_history` | gas rows exist |
| `detections` | `event_log` | `detection_events` | ≥1 row in window |

Grouping is source-based and follows `NODE_STATUS_SPEC`.

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

## Test notes

- Env-only sensor node → `environment`, header position when known, no `device_vitals`
- Unknown num → `{found:false, sections:[]}`, no throw
- Empty array value → field omitted, not a blank row

## Out of scope

- Ingestion/storage — `persist.js` and `db.js` own those
- WS transport and the live-push hint — `ws-relay.js`
- Rendering — the browser, which decides nothing
