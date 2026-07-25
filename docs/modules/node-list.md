---
module: node-list
source: src/node-list.js
source_hash: 056ad3b9ed1c1734f332e25ed601d7f34edc1b8cb4d972703e9ee2e40be81fbe
updated: 2026-07-08
---

# Module: node-list

## Purpose

In-memory node cache and the single source of truth for the live node list. Aggregates
node identity, position, telemetry, and scan results from all gw events into a unified
per-node entry. Emits a debounced `'change'` event when the list changes so consumers
(ws-relay, active-tracker, passive-tracer) react to a single stream rather than
individual field updates.

Owns the scan buffering state machine: during a BLE scan, node updates are held in a
pending buffer until `confirmScanContact` proves physical proximity.

## Responsibilities

- Maintain `_cache`: live node entries that pass the current filter
- Maintain `_pending`: node entries buffered during scan, not yet confirmed by `scan_contact`
- Maintain `_ownDevices`: own BLE device nodes (never scan-filtered, never cleared on scan start)
- Route own-device updates to `_ownDevices` and remote-node updates to `_cache`/`_pending`
- Backfill identity and position from `nodeinfo` (permanent DB) when live data lacks them (`enrichFromCache`)
- Compute `_km` / `_az` relative to `home.lat`/`home.lon` config for positioned nodes
- Debounce `'change'` emission — 150 ms coalesce window to avoid per-field update storms
- Write traceroute results to SQLite (`stmts.upsertTraceroute`, `stmts.insertTracerouteHistory`) and patch in-memory entry

## Dependencies

- `db.js` — `getConfig`, `setConfig`, `getMqttNode`, `stmts`
- `device-config.js` — `getRotatorAddress`
- `node-filter.js` — `passesFilter`, `ownDeviceNums`
- `utils.js` — `haversine`, `bearing`
- `node:events` — EventEmitter base

## Public interface

### Pure helpers

```js
export function hopsAway(hopStart, hopLimit)  // → int | null (UNKNOWN)
```

Hops-away computed the way the Meshtastic firmware does (`NodeDB.cpp`
`getHopsAway`): `hop_start - hop_limit`, but **guarded**. Returns `null`
(UNKNOWN — caller must leave the prior value intact) when:
- `hop_start` or `hop_limit` is missing (`null`/`undefined`), or
- `hop_start === 0` (old/MQTT-injected packets that never set it; the v3
  0-hop `has_bitfield` exception is NOT distinguishable from our event feed,
  so a genuine 0-hop reads as unknown — accepted limitation), or
- `hop_start < hop_limit` (invalid).

Otherwise returns `hop_start - hop_limit` (≥ 0; 0 = direct/adjacent).

### Singleton

```js
export const nodeList  // instance of NodeList
```

### Getters

```js
nodeList.nodes            // → nodeData[]  — filtered, __km/__az annotated if homePos set
nodeList.ownDeviceNodes   // → nodeData[]  — own BLE device entries (unfiltered)
nodeList.homePos          // → {lat,lon}|null  — from config 'home.lat'/'home.lon'
```

### Mutation methods

```js
// Bridge event ingest
nodeList.handleNodeUpdate(ev)
// ev: { data: nodeData, addr/__ble_addr: BLE MAC of the reporting radio }
// Enriches node DATA only — never contributes _device/_devices (see
// "Device attribution invariant")

// Packet receipt — update last_heard and device tag
nodeList.touchLastHeard(num, ts, device = null)

// Patch environment metrics onto in-memory entry
nodeList.setEnvironmentMetrics(num, data)

// Patch guarded hops-away onto in-memory entry (per received packet)
nodeList.setHopsAway(num, hops)
// hops from hopsAway(pkt.hop_start, pkt.hop_limit). A null (UNKNOWN) is
// ignored so a prior KNOWN value survives — mirrors firmware updateFrom,
// which only sets hops_away when it can compute it. Patches _cache, _pending,
// or _ownDevices (like setEnvironmentMetrics). No-op / no emit if unchanged.

// Write traceroute result to DB and patch in-memory entry
nodeList.setTraceroute(num, data, fromNum, rxDevice)

// SCAN: promote pending node into live cache
nodeList.confirmScanContact(num, device, az, rssi, snr)

// SCAN: restore confirmed contacts after restart
nodeList.restoreScanNodes(nodes)

// Toggle scan mode — clears cache/pending on activation
nodeList.setScanActive(active, clearPersisted = true)

// Bulk seed from bridge REST (connect or scan start)
nodeList.seed(nodes, device, forceDevice = false)

// Restore device attribution from SQLite after cold seed
nodeList.restoreDeviceAttribution(rows)

// Seed a single own-device node
nodeList.seedOwnDevice(node, deviceId)

// Wipe all in-memory state (call after clearNodeCache())
nodeList.clear()

// Re-apply filter without new data (after config change)
nodeList.refilter()
```

## State

| Field | Type | Description |
|---|---|---|
| `_cache` | Map\<num, nodeData\> | Live confirmed nodes; the SSOT passed to consumers |
| `_pending` | Map\<num, nodeData\> | Buffered during scan; not yet confirmed by `scan_contact` |
| `_ownDevices` | Map\<num, nodeData\> | Own BLE device self-reports; never filtered, never cleared on scan |
| `_scanActive` | boolean | Scan mode flag; gates routing in `handleNodeUpdate` and `touchLastHeard` |
| `_emitTimer` | Timer\|null | Debounce handle for `'change'` emission (150 ms) |

### Node entry metadata fields (not from gw)

| Field | Set by | Meaning |
|---|---|---|
| `_device` | heard-evidence paths only | Last BLE MAC that actually HEARD this node |
| `_devices` | heard-evidence paths only | All BLE MACs that have actually HEARD this node |
| `_from_cache` | `enrichFromCache` | Identity/position backfilled from `nodeinfo` |
| `_new` | `enrichFromCache` | `first_heard` within last 24 h |
| `_scanAz` | `confirmScanContact` | Rotator azimuth at scan contact |
| `_scanRssi` | `confirmScanContact` | RSSI at scan contact |
| `_scanSnr` | `confirmScanContact` | SNR at scan contact; used to pick best contact on repeat |
| `_km` | `_filter` | Haversine distance from home position |
| `_az` | `_filter` | Bearing from home position |

## Events emitted

| Event | Payload | When |
|---|---|---|
| `'change'` | `nodeData[]` | 150 ms after any state change; filtered and annotated |

## Scan state machine

```
setScanActive(true)
  → _cache.clear(), _pending.clear()
  → all handleNodeUpdate calls: own-device → _ownDevices; from non-rotator device → dropped;
    from rotator: if in _cache → update in place; else → buffer in _pending

confirmScanContact(num, …)
  → if in _pending → promote to _cache, delete from _pending
  → if in _cache → update scan fields if SNR improves
  → if neither → create minimal entry; node_update will enrich later
  → persists _cache to config('scan_nodes')

setScanActive(false)
  → _scanActive = false; future updates go directly to _cache
  → _pending entries remain until next scan start (they are not promoted)
  → the pre-scan cache snapshot (_preScanCache, taken at setScanActive(true)
    before the wipe) is RESTORED, with confirmed scan contacts overlaid on
    top (scan data is fresher). Without this the wipe was permanent and
    post-scan ACTV starved on a near-empty radar (task scan-cache-restore).
    A restart mid-scan loses the in-memory snapshot — the cache then
    rebuilds from packets (and the gw reseed once its /nodes endpoint is
    fixed).

restoreScanNodes(nodes)  — called on restart when scan was in progress
  → only nodes with _scanAz or _scanSnr (confirmed contacts) are restored
```

## Invariants

- `nodeList` is the single source of truth for the live node list. No other module maintains a parallel map of live nodes (except `_liveNodeIds` in `ws-relay.js` — a v1 artifact to be removed).
- `_ownDevices` entries are never cleared on `setScanActive(true)` or `clear()`. They are only updated, never removed.
- `_filter()` always excludes own-device nums (`ownDeviceNums()`), regardless of how they arrived in `_cache`.
- `touchLastHeard` is a no-op during scan (`_scanActive === true`). Packet receipts do not promote pending entries.
- `confirmScanContact` persists the live `_cache` to config `'scan_nodes'` on every call so progress survives a restart.
- `enrichFromCache` is idempotent: running it twice on the same node produces the same result.
- `_scheduleEmit` coalesces all changes within a 150 ms window into a single `'change'` emission.
- **Device attribution invariant** (task `node-source-attribution`):
  `_device`/`_devices` mean "radios that actually heard this node over RF"
  and are written ONLY by heard-evidence paths — `touchLastHeard` (received
  packet), `confirmScanContact` (scan hit), and `restoreDeviceAttribution`
  (packet-derived `nodes.device` from SQLite). `handleNodeUpdate` must NOT
  write them: `node_info` is a nodedb replay on every BLE sync — both radios
  replay the same nodedb, so attributing from it tags every node with every
  radio and turns the `node_source` filter into a no-op (the 2026-07-03
  "source set to YAGI but all sources shown" bug). `seed` only tags when
  given an explicit device (boot seed passes `null`). Vocabulary is BLE MAC
  (`__ble_addr`) exclusively.
- `setTraceroute` writes directly to `db.stmts` — a mixed concern. Traceroute DB writes are coupled to the node cache because the in-memory patch and the DB write must stay in sync.

## Test notes

- **`handleNodeUpdate` PASV/ACTV**: event arrives for a cached node → data enriched, `_device`/`_devices` UNCHANGED; `'change'` fires after 150 ms
- **attribution stays clean**: node heard only by OMNI, then `node_info` replay arrives via YAGI → `_devices` still `[OMNI MAC]`
- **`handleNodeUpdate` scan buffering**: `setScanActive(true)` → event from rotator → node in `_pending`, not `_cache`; event from non-rotator → dropped
- **`confirmScanContact` promotion**: pending node → promoted to `_cache` with `_scanAz`/`_scanRssi`/`_scanSnr` set
- **`confirmScanContact` SNR update**: repeated contact with better SNR → fields updated; worse SNR → ignored
- **`touchLastHeard` no-op during scan**: `setScanActive(true)` → `touchLastHeard` → `_cache` unchanged
- **`seed` scan mode**: confirmed entries in `_cache` get enriched, preserve scan fields; unconfirmed → `_pending`
- **`enrichFromCache` backfill**: node with no identity → `getMqttNode` returns cached names → returned node has `user.short_name` set, `_from_cache: true`
- **`_new` flag**: `first_heard` < 24 h ago → `_new: true`; older → `_new: false`
- **`clear()`**: both `_cache` and `_pending` empty; `_ownDevices` unchanged
- **`refilter()`**: no data change → `'change'` fires with same filtered set
- **`homePos` annotation**: node with position + homePos set → `_km` and `_az` present in `'change'` payload
- **`setEnvironmentMetrics`**: patches `environment_metrics` onto `_cache` entry; also patches `_pending` if not in cache; also patches `_ownDevices` if own device num
- **`hopsAway()` guard**: `(3,3)→0`, `(3,1)→2`, `(0,3)→null`, `(null,3)→null`, `(2,3)→null`
- **`setHopsAway`**: known value patches `_cache` entry `hops`; `null` leaves prior `hops` untouched; same value → no `'change'` emit
- **gw hops stripped**: `handleNodeUpdate` with `ev.data.hops = 5` on a cached node → entry `hops` unchanged (not set to 5); `seed` node with `hops: 5` → seeded entry has no `hops` from the gw
- **replay-regression guard**: cached node with `last_heard=200` → `handleNodeUpdate` with `node.last_heard=100` (older) → entry UNCHANGED, no `'change'` emitted; same with `node.last_heard=300` (newer) → entry enriched as before; `node.last_heard` absent → enriched as before (unknown freshness, unchanged legacy behavior)

## Out of scope

- Filter rules — `node-filter.js` owns `passesFilter`
- Label resolution — `node-label.js` owns name lookup
- Broadcasting to browser WebSocket — `ws-relay.js` listens to `'change'`
- Scan rotation control — `scanner.js` owns the scan sequence; it calls `confirmScanContact`
- Traceroute lifecycle management — `traceroute.js` owns the request/response cycle; it calls `setTraceroute`

## V2 field alignment (2026-07-02, task `v2-backend-alignment`; revised 2026-07-03, task `node-source-attribution`)

The scan-time source gate compares `ev.addr` against the rotator MAC.
`handleNodeUpdate` no longer derives a device key at all — attribution
comes exclusively from the heard-evidence paths listed in the Device
attribution invariant, keyed by `__ble_addr` MAC (never `node_id`, which
V2 IDENTITY.md marks as unstable).

## Phantom-node guard (task `phantom-nodes-regression`)

`handleNodeUpdate` (non-scan path) updates EXISTING cache entries only —
`node_info` replays the radio's whole nodedb on every BLE sync, and creating
entries from it put never-heard nodes on the radar and in the ACTV rotator
queue (the recurring phantom-target bug; regressed 2026-07-02 by the
node_info routing fix, caught same day: ACTV targeted GZG/OMT while absent
from the node list). Cache-entry creation is reserved for heard packets
(`touchLastHeard`), the opt-in per-device boot seed, and confirmed scan
contacts. Live `node_info` still enriches heard nodes with
rssi/snr/via_mqtt/device_metrics — the node-filter fields keep flowing.
(`hops` is NO LONGER taken from `node_info` — see "Hops-away ownership".)

## Hops-away ownership (task `hops-away-official-calc`, 2026-07-08)

`node.hops` (the "hops away" the browser badge shows) is owned **solely** by
`setHopsAway`, computed per received packet via the guarded `hopsAway()`
helper — the same calculation the Meshtastic phone app uses
(`NodeDB.cpp` `getHopsAway`, run on every packet by `updateFrom`).

The gw's aggregate `node_info.data.hops` (and the REST `/nodes` `hops`) is
**unguarded** — raw `hop_start - hop_limit` with no validity check
(docs/gw/API_SSE.md), delivered on only a subset of events, and it carries no
`hop_start`/`hop_limit` to re-guard at the `node_info` layer. It is therefore
**stripped on ingest**: `handleNodeUpdate` destructures `hops` off `ev.data`,
and `seed()` destructures it off each REST node, before the entry is merged.

## Replay-regression guard (task `nodeinfo-replay-regression`, 2026-07-25)

Same root cause as the phantom-node guard above, one layer deeper: even
restricted to *existing* entries, `handleNodeUpdate`'s enrich merge
(`{ ...existing, ...node }`, both the scan-active `_cache`/`_pending`
branches and the PASV/ACTV branch) applied replay data **unconditionally** —
no comparison against the entry's own `last_heard`. Found via `/investigate`:
a node_info/node_update nodedb replay carries the radio's own cached
`last_heard`, which is stale for any node the radio hasn't personally
re-heard recently, and every replay cycle (BLE resync — reconnects,
restarts) re-applied that stale snapshot over whatever fresher direct
reception had already produced, regressing `short_name`/`long_name`/
`hw_model`/position/`last_heard` together, silently.

Each of the three merge sites now checks: if `node.last_heard` is present
and older than the entry's own `last_heard`, skip the merge (`return`
without mutating `_cache`/`_pending`, no `'change'` emitted for that node).
An incoming `node.last_heard` that is `null`/absent still merges as before
(unknown freshness — matches this fix's sibling in `db.js`'s `upsertNode`,
which treats an unset incoming timestamp the same way). This is the
in-memory, live-WS-push counterpart to the equivalent fix in `db.js`'s
`upsertNode` — that one protects the persisted `nodes` table; this one
protects what's actually pushed to the browser right now.
This is why the earlier badge read `1h` for almost every node regardless of
its real distance (e.g. a 5-relay traceroute node showing `1h`).

- **Source of truth**: `bridge-events.js` calls `setHopsAway(pkt.from,
  hopsAway(pkt.hop_start, pkt.hop_limit))` for every heard packet (all
  portnums), inside the same `!yagiOnly` scan guard as `touchLastHeard`.
- **UNKNOWN handling**: `hopsAway()` → `null` leaves the prior value; a node
  never heard with a valid `hop_start` has no `hops` (badge renders `0h` today
  — the unknown-vs-0 presentation nuance is a separate Domain-2 concern).
- **Cold start**: on a fresh entry with no live `hops` yet, `enrichFromCache`
  warms it from the **persisted** `nodeinfo.hops_away` (below), so the badge +
  `max_hops` filter start populated after a restart instead of empty.
- **Not the traceroute path length**: hops-away (live reception distance) and
  `last_traceroute.route.length` (a routed probe path) are different
  measurements and will rarely match — by design.

### Persistence (task `persist-hops-away`, 2026-07-09)

`hops_away` is our own live `getHopsAway` result — but it accumulates only if
it survives restarts, the way the firmware NodeDB does (we NEVER read that DB).
So it is **persisted to `nodeinfo.hops_away`**, mirroring `last_traceroute`:

- **Write-through**: `setHopsAway` writes the KNOWN value via
  `stmts.upsertNodeHopsAway` (UPDATE by `num`; no-op if the node has no
  `nodeinfo` row yet). Deduped by `_persistedHops` (num → last written) so a
  stable value isn't re-written on every packet.
- **Reload**: `enrichFromCache` attaches `cached.hops_away` as `node.hops` on a
  COLD entry only — `node.hops ?? cached.hops_away`, so a **live value always
  wins** and the persisted one just warms the gap.
- **Why**: the in-memory cache is wiped every process restart; without this the
  reported number reset to empty each time (and could never retain the higher
  4–6 hop readings that arrive rarely). Verified: after a restart, nodes reload
  with values spanning 2–6, and a re-heard node correctly overrides its warm
  value.

## setTraceroute (task `perf-per-device`)

Persists `tx_device` and `rotator_az` from the result into
traceroute_history. Success rows carry `status: 'ok'` (task `perf-honesty`
step 2 — failure rows are inserted by traceroute.js, never through here).

## Identity Phase B — _ownDevices vocabulary

`_ownDevices._device` is MAC-first (`ev.__ble_addr ?? ev.addr ??
ev.node_id`), matching `_cache._device` — audit violation B8.

## Phase C1

`setTraceroute` returns the inserted history row id (for WS row keying).
