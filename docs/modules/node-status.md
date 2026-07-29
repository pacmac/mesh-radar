---
module: node-status
source: src/node-status.js
source_hash: b71a9254080e8d4c7db6f74b78d1f5b9ffb0427fce6f19cf9eba81077cb260ec
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
| *(plugin-contributed)* | *(any)* | **not this module** — see the extension point below | a plugin is installed and has something to say |
| `device_vitals` | `series` | `device_metrics_history` | ≥1 row in window |
| `signal` | `series` | `signal_history` | ≥1 usable row in window |
| `environment` | `series` | `environment_history` | ≥1 row in window |
| `air_quality` | `series` | gas baseline + `environment_history` | gas rows exist |
| `detections` | `event_log` | `detection_events` | ≥1 row in window |

Grouping is source-based and follows `NODE_STATUS_SPEC`.

### Host extension point — plugins contribute sections (task `alarm-plugin-boundary-restore`, 2026-07-29)

```js
export function registerNodeSection(fn) { _sectionProviders.push(fn); }
```

Providers run **before** the core sections and receive `(num, { perRadio, now, since })`.
A provider returning `null` contributes nothing — which makes *"no plugin installed"*
and *"this plugin has nothing to say about this node"* the same code path, so core
needs no `if (pluginPresent)` anywhere.

**Core knows nothing about what a provider is for.** It must never import, name or
branch on a plugin. This point exists because `1f8842b` put a hard `pac-host` import
and 164 lines of alarm logic directly in this file, breaching
`reference/alarm-integration/INVENTORY.md` (*"code must not be copied back into shared
dashboard modules"*). Peter, 2026-07-29: *"the alarm is a plugin … node dash must be
able to exist with or without it."*

`ctx.perRadio` is passed in, never re-queried by a provider: it is the same
`stmts.latestDirectPerRadio` array the header's Signal tile is built from, and
re-querying would turn the header↔section agreement (`cc2e55f`) back into a
coincidence.

The `reachability` section is now contributed by `src/alarm-sections.js` — see
`docs/modules/alarm-sections.md` and `docs/PLUGIN_BOUNDARY_SPEC.md`. Its full data
contract remains in `docs/REACHABILITY_SPEC.md`.

**Verified 2026-07-29:** with the plugin unwired, GARG returned
`[device_vitals, signal, environment, air_quality, detections]` and two core nodes were
section-identical to their pre-change baseline.

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
- **SUPERSEDED 2026-07-29 (task `signal-ssot-header`).** This invariant used to
  read *"`node.rssi`/`node.snr` are gated direct-only at write time"*. **That was
  false** — `handleNodeInfo` wrote mesh-gw's ungated nodedb aggregate straight
  in, so the header could display a value that matched no measurement we held
  (GARG: `-98 dBm / +6.8 dB` against zero positive-SNR rows in 24 h). Left
  recorded rather than deleted: a spec asserting an invariant that the code broke
  is why nobody looked.
- **The header's Signal tile is the BEST of each radio's LATEST direct
  reading**, from `stmts.latestDirectPerRadio` — never `nodes.rssi/snr`. `desc`
  names the radio and its age (`best of 2 · YAGI · direct 6m ago`), because a
  headline dBm figure is meaningless when two radios sit 15 dB apart.
  - Latest per radio, **not best-ever**: GARG's best-ever is −17 dBm from 27 Jul,
    when it sat on the bench beside the radios.
  - `best of N` appears only when N > 1, otherwise it implies a comparison that
    never happened.
  - Falls back to `stmts.latestDirectAny` (no radio named) when a node has no
    attributed rows — 18,681 of 29,897 `signal_history` rows predate `rx_device`,
    so most of the mesh is in that state. The reading is still direct-gated; only
    the antenna is unknown, and withholding the tile entirely would hide a fact
    we hold.
- **`Least hops` comes from `messages`, not `signal_history`.** The latter is
  100 % `hops = 0` by construction (direct receptions only), so a least-hops
  derived from it would always be 0. `desc` carries the radio and the
  direct/total split — `OMNI · 434 of 464 direct` — because a best-case hop count
  without its typicality is how a 2.5 km link once rendered as `-36 dBm / hops 0`.
  Window is a fixed 7 days, deliberately NOT the chart selector's window: the
  header must not change meaning when someone clicks 1HR.
- **`Verified hops` states when its refresh path is dead.** A traceroute value can
  be correct and ancient at once — GARG's is `route: []` from 14 Jul followed by
  886 consecutive timeouts. `desc` is `traceroute {stamp} · {N} failed since`,
  from `stmts.tracerouteHealth`. The number is right; presenting it as current is
  the defect.
- **The header can only show a number the Reachability section also shows.** Both
  are computed from one `perRadio` array read once in `buildNodeStatus` and
  passed down — agreement by construction, not by convention.

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
