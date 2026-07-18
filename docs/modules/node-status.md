---
module: node-status
source: src/node-status.js
source_hash: e2ad82e0415cca002884bf5b9f5142d41ee8694a45a5710c654e90aadd2e28ec
updated: 2026-07-18
---

# Module: node-status

## Purpose

Builds the `node_status` payload: an **ordered list of display-ready sections**
for any node in the mesh. Works for ANY node — it is not restricted to a
designated subset.

## Responsibilities

- Query the node's identity, history and cached private-app state
- Decide **which sections exist** for this node (presence follows real data)
- Decide **what order** sections appear in
- Format every displayed value via `format.js` so the browser formats nothing

## Dependencies

- `db.js` — `stmts` (read-only queries)
- `format.js` — all display strings
- `utils.js` — `numToNodeId` only

## Public interface

```js
buildNodeStatus(num)
// → { num, found, header, sections: [...] }
// → { num, found: false, header: null, sections: [] } for an unknown node
```

## The section-kinds contract

The browser knows a small fixed vocabulary of section **kinds** and nothing
else. It does not know which port a datum came from, what portnum 260 is, or
what a detection is.

| kind | shape |
|---|---|
| `value_grid` | `{ fields: [{label, raw, text, ts}] }` |
| `series` | `{ series: [{key, label, unit, points:[{t,v}]}], t_min, t_max, t_min_text, t_max_text }` |
| `event_log` | `{ events: [{ts, ts_text, ts_ago, label, text}] }` |

Adding a port, a `type` or a field later is a change to **this file alone** —
the browser is never touched again.

`config_form` is not built here. The 260 config panel ships read-only as a
`value_grid`; the editor (OpManager + a new `MeshRunner`) is separate work.

## Sections emitted (source-grouped, fixed order)

| id | kind | source | present when |
|---|---|---|---|
| `device_vitals` | `series` | `device_metrics_history` | ≥1 row in window |
| `environment` | `series` | `environment_history` | ≥1 row in window |
| `detections` | `event_log` | `detection_events` | ≥1 row in window |
| `alarm_config` | `value_grid` | `node_app_state` 260 `config` | row exists |
| `diagnostics` | `value_grid` | `node_app_state` 260 `debug` | row exists |
| `power` | `value_grid` | `node_app_state` 260 `calc` | row exists |
| `position` | `value_grid` | `nodeinfo`/`nodes` lat+lon | coords present |

Grouping is **source-based** — honest about provenance, matches the SSOT table
in NODE_STATUS_SPEC. Question-based grouping (e.g. overlaying `alarm`/`cleared`
events on the environment chart) is deliberately not done yet; because the
browser is a dumb renderer this is a backend-only decision, cheap to revise.

## Invariants

- **Presence is a server decision.** A section with no data is ABSENT from
  `sections`, never present-and-empty. A browser-side `x-if="data.length"` would
  be the browser deciding — forbidden by iron rule 1.
- **Order is a server decision**, for the same reason.
- Every field carries `raw` + `text` (+ `ts` where meaningful). The browser binds
  `text` verbatim.
- A field whose formatted text is null **or empty string** is dropped — an empty
  array (e.g. the device's `pts`) must not render as a blank row.
- Series are downsampled to ≤200 points, preserving first and last so the
  visible time axis spans the true window.
- 260 payload keys are flattened with the **device's own key names**
  (`det.n`, `alm.ovr`) — renaming them would be node-dash editorialising device
  data (iron rule 2).
- Nothing here is sourced from a command reply (`@ping`/`@status`/`@env`) —
  iron rule 3.
- Header shows values, never verdicts: no health pill, no "battery low".

## Test notes

- Node with 260 traffic → gains `alarm_config`/`diagnostics`; a plain node does not
- Env-only sensor node → `environment` + `position`, no `device_vitals`
- Unknown num → `{found:false, sections:[]}`, no throw
- 260 config flattens nested keys to `det.n`, `alm.ovr`, …
- Empty array value → field omitted, not a blank row

## Out of scope

- Ingestion/storage — `persist.js` and `db.js` own those
- WS transport and the live-push hint — `ws-relay.js`
- Rendering — the browser, which decides nothing
