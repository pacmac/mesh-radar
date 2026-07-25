---
module: db
source: src/db.js
source_hash: 8d6f363401828c7342f9b8d0da2363ed4a4e9ac0fdb789823975eb37900204f0
updated: 2026-07-18
---

# Module: db

## Purpose

SQLite storage layer. Owns the database file, schema, all migrations, and every
prepared statement. Exports typed functions for every storage operation so no other
module constructs raw SQL. All persistence in node-dash goes through this module.

## Responsibilities

- Open the SQLite database (WAL mode, foreign keys ON)
- Create all tables on first run via `CREATE TABLE IF NOT EXISTS`
- Run column-addition migrations on startup (idempotent checks via `PRAGMA table_info`)
- Seed default alert rule rows (`INSERT OR IGNORE`)
- Expose `stmts` — a frozen object of compiled prepared statements used by high-frequency callers
- Export typed wrapper functions for all storage operations
- Maintain the in-memory `_alertedPacketIds` Set (session-level alert dedup, max 2 000 entries)

## Dependencies

- `better-sqlite3` — synchronous SQLite driver
- `node:path` — DB_PATH resolution
- Environment: `DB_PATH` (default: `./data/node-dash.db`)

## Public interface

### Raw exports (use sparingly — prefer typed functions)

```js
export default db          // better-sqlite3 Database instance — only alerts.js and filters.js use this directly; treat as a code smell to fix
export const stmts = { … } // compiled prepared statements — see §Prepared statements
```

### Config

```js
getConfig(key, fallback = null)     // → any         — JSON-parsed value or fallback
setConfig(key, value)               // → void         — JSON-serialised upsert
deleteConfig(key)                   // → void
getConfigByPrefix(prefix)           // → Record<suffix, any>  — all keys matching prefix
```

### Node storage

```js
clearNodeCache()                    // → void  — DELETE FROM nodes (ephemeral table)
getMqttNode(num)                    // → nodeinfo row | null
recordYagiTargeted(num)             // → void  — increment yagi_target_count, set yagi_last_targeted
recordYagiContact(num, rssi, snr)   // → void  — update best/last yagi signal in nodeinfo
```

### Messages

```js
// (messages are written via stmts.insertRxMessage / stmts.insertTxMessage directly)
syncAlertedAt(packetId)             // → void  — backfill alerted_at if packet was pre-alerted this session
```

### Range test log

```js
insertRangeTestEntry(entry)         // → void  — { ts, from_num, rssi, snr, hops, seq, rx_device, via_mqtt }
queryRangeTestLog(limit = 500)      // → row[]
clearRangeTestLog()                 // → void
```

### Tilt history

```js
insertTilt(entry)                   // → void  — { ts, node_id, pitch, roll, version, sample_count, window_ms, avg_roll, avg_pitch, min_roll, max_roll, min_pitch, max_pitch, max_delta, rms_motion }
queryTiltHistory(nodeId, sinceTs)   // → row[]  — ncal=0 only, ASC by ts
queryAllTiltHistory(sinceTs)        // → row[]  — all node_ids, ncal=0 only
markTiltNcal(nodeId, tsFrom, tsTo)  // → number — rows changed
getTiltCal()                        // → { zero: number|null, north_angle: number|null }
saveTiltCal({ zero, north_angle })  // → void  — undefined fields are not written
```

### Environment history

```js
insertEnvHistory(entry)             // → void  — { ts, num, packet_id?, temperature, relative_humidity, barometric_pressure }
queryEnvHistory(num, sinceTs)       // → row[]
queryAllEnvHistory(sinceTs)         // → row[]
```

`packet_id` defaults to null in the wrapper, so callers without one (the
bridge-events nodedb-replay writer) keep working — better-sqlite3 throws on a
missing named parameter. A null id is never deduped.

### Node focus page ingestion (INGESTION_SPEC)

```js
insertDeviceMetricsHistory(entry)   // → void  — { ts, num, packet_id, uptime_seconds, voltage, battery_level, channel_utilization, air_util_tx }
insertDetectionEvent(entry)         // → void  — { ts, num, packet_id, raw }
```

All history inserts are `INSERT OR IGNORE` against a **partial unique
index on `(num, packet_id)`**: a broadcast heard by N gateway radios, or the same
reading arriving as both a `telemetry` event and a raw `packet`, collapses to one
row. Rows with a null `packet_id` are never deduped.

### Geocode cache

```js
getCachedGeocode(num)               // → string | null
setCachedGeocode(num, address)      // → void
```

### Node MAC mapping

```js
persistNodeMac(nodeId, mac)         // → void  — stores config key 'node_mac.<MAC>' = nodeId
loadNodeMacMap()                    // → Map<MAC, nodeId>  — filters to MAC-format keys only
```

### Alert rules

```js
getAlertRules()                     // → rule[]
getAlertRule(type)                  // → rule | null
updateAlertRule({ type, enabled, threshold, cooldown_minutes })  // → number (rows changed)
touchAlertLastSent(type, ts?)       // → void
```

### Reply tokens

```js
createReplyToken(token, fromNodeId, toNum, replyId, channel, ttlSeconds)  // → void
getReplyToken(token)                // → row | null  — null if expired
consumeReplyToken(token)            // → row | null  — deletes on return
pruneExpiredTokens()                // → void
```

### Alert packet deduplication

```js
markPacketAlerted(packetId)         // → void  — adds to _alertedPacketIds + sets alerted_at in DB
isPacketAlerted(packetId)           // → boolean  — checks Set first, then DB
syncAlertedAt(packetId)             // → void  — writes alerted_at if already in session Set
```

## State

| Field | Type | Description |
|---|---|---|
| `db` | Database | better-sqlite3 instance, WAL mode |
| `stmts` | object | Compiled prepared statements (see below) |
| `_alertedPacketIds` | Set\<number\> | Session-level alert dedup; evicts oldest when > 2 000 |

### Prepared statements (`stmts`)

| Key | Operation |
|---|---|
| `insertMessage` | INSERT OR IGNORE into messages (legacy, no message_key) |
| `insertRxMessage` | INSERT … ON CONFLICT(message_key) — upserts best SNR/RSSI, accumulates rx_devices |
| `insertTxMessage` | INSERT OR IGNORE into messages (sent messages, message_key = 't-{id}', carries `category`) — called only via `mesh-send.js` |
| `updateMessageStatus` | UPDATE messages SET status WHERE packet_id (TX rows only) |
| `upsertNodeinfo` | INSERT … ON CONFLICT(node_id) — COALESCE merge into persistent nodeinfo (freshness gated by the caller, `_upsertCache` in persist.js — see nodeinfo's own note) |
| `upsertNode` | INSERT … ON CONFLICT(num) DO UPDATE ... WHERE — COALESCE merge into ephemeral nodes, gated so a stale (older-`last_heard`) incoming row cannot regress a fresher one (task `nodeinfo-replay-regression`) |
| `latestSignalTs` | SELECT ts FROM signal_history WHERE num = ? ORDER BY ts DESC LIMIT 1 — most recent genuinely-direct capture, used to age-stamp the frozen direct-only `nodes.rssi`/`nodes.snr` (task `node-signal-freeze`) |
| `insertEvent` | INSERT into events log |
| `insertRangeTest` | INSERT into range_test_log |
| `queryRangeTest` | SELECT … ORDER BY ts DESC LIMIT ? |
| `clearRangeTest` | DELETE FROM range_test_log |
| `clearNodes` | DELETE FROM nodes |
| `getNodeinfoByNum` | SELECT * FROM nodeinfo WHERE num = ? |
| `upsertTraceroute` | UPDATE nodeinfo SET last_traceroute WHERE num |
| `upsertNodeHopsAway` | UPDATE nodeinfo SET hops_away WHERE num — persists our live-computed getHopsAway so REPORTED hops survives restarts (task `persist-hops-away`); no-op if no row yet, reloaded via `enrichFromCache`. Column `nodeinfo.hops_away INTEGER` added by the guarded ALTER block. |
| `insertTracerouteHistory` | INSERT into traceroute_history |
| `queryTracerouteHistory` | JOIN traceroute_history + nodes, optional to_num filter |
| `upsertNodeEnvMetrics` | INSERT … ON CONFLICT(num) — COALESCE env metrics into nodes |
| `recordYagiTargeted` | UPDATE nodeinfo yagi_last_targeted, yagi_target_count |
| `recordYagiContact` | UPDATE nodeinfo yagi_last/best rssi/snr, contact count |
| `getGeocode` | SELECT address FROM nodeinfo WHERE num |
| `setGeocode` | UPDATE nodeinfo SET address WHERE num |
| `getConfig` | SELECT value FROM config WHERE key |
| `setConfig` | INSERT … ON CONFLICT(key) DO UPDATE |
| `deleteConfig` | DELETE FROM config WHERE key |
| `getNodePos` | UNION: nodes + nodeinfo WHERE num — first non-null lat/lon |
| `getNodeDevices` | SELECT num, device FROM nodes WHERE device IS NOT NULL |
| `insertTilt` | INSERT into tilt_history |
| `queryTilt` | SELECT from tilt_history WHERE node_id AND ts >= AND ncal=0 |
| `queryAllTilt` | SELECT from tilt_history WHERE ts >= AND ncal=0 |
| `markNcal` | UPDATE tilt_history SET ncal=1 WHERE node_id AND ts BETWEEN |
| `insertEnvHistory` | INSERT OR IGNORE into environment_history (dedup on num, packet_id) |
| `queryEnvHistory` | SELECT from environment_history WHERE num AND ts >= |
| `queryAllEnvHistory` | SELECT from environment_history WHERE ts >= |
| `insertDeviceMetricsHistory` | INSERT OR IGNORE into device_metrics_history (dedup on num, packet_id) |
| `insertDetectionEvent` | INSERT OR IGNORE into detection_events (dedup on num, packet_id) |
| `queryDeviceMetricsHistory` | SELECT from device_metrics_history WHERE num AND ts >= (ASC — chart-ready, browser never sorts) |
| `queryDetectionEvents` | SELECT from detection_events WHERE num AND ts >= (DESC, LIMIT) |
| `getNodeByNum` | SELECT * FROM nodes WHERE num = ? |

### Ingestion tables (INGESTION_SPEC)

| Table | Purpose |
|---|---|
| `device_metrics_history` | Per-node device vitals series (uptime, voltage, battery, channel/air utilisation). Partial unique index `idx_dmh_dedup` on `(num, packet_id)`. |
| `detection_events` | Standard `DETECTION_SENSOR_APP` events. `raw` holds the original text without application-specific interpretation. |

`environment_history` gained `packet_id` via the guarded `PRAGMA table_info`
migration, plus partial unique index `idx_env_dedup`. The index is partial so the
~86k pre-existing rows (all null `packet_id`) are untouched.

## Schema

### `messages` — persists

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| ts | INTEGER | unix seconds |
| from_num | INTEGER | sender node num |
| to_num | INTEGER | 0xFFFFFFFF = broadcast |
| text | TEXT | |
| channel | INTEGER | 0–7 |
| is_dm | INTEGER | 1 if to_num ≠ broadcast |
| hop_limit | INTEGER | |
| snr | REAL | |
| rssi | INTEGER | |
| packet_id | INTEGER | |
| reply_id | INTEGER | parent packet_id for threading |
| device | TEXT | gateway radio that received it |
| replay | INTEGER | 1 if seeded from REST on boot |
| hops | INTEGER | hop_start - hop_limit |
| short_name | TEXT | sender short name at receive time |
| long_name | TEXT | sender long name at receive time |
| alerted_at | INTEGER | unix ts when alert was sent |
| status | TEXT | TX message ACK state (sent/queued/delivered/…) |
| message_key | TEXT | dedup key: 'r-{packet_id}' rx, 't-{packet_id}' tx |
| rx_devices | TEXT | comma-separated BLE MACs that heard this packet |
| category | TEXT | traffic class on outbound: 'chat'/'command'/'ping'; NULL on received (see mesh-send.md) |

Unique index on `(packet_id, device)` WHERE packet_id IS NOT NULL (legacy).
Unique index on `message_key` WHERE message_key IS NOT NULL (current dedup).

### `nodes` — ephemeral (cleared on restart)

Live node state from the bridge. COALESCE upsert — existing non-null values are never overwritten with null.
Columns: num (PK), node_id, short_name, long_name, hw_model, role, last_heard, snr, rssi, hops, lat, lon, alt, battery, voltage, channel_util, air_util_tx, uptime_seconds, device, temperature, relative_humidity, barometric_pressure, updated_at.

**Monotonic `last_heard` gate (task `nodeinfo-replay-regression`, 2026-07-25).**
`upsertNode`'s `ON CONFLICT DO UPDATE` carries a `WHERE excluded.last_heard IS
NULL OR nodes.last_heard IS NULL OR excluded.last_heard >= nodes.last_heard`
guard. Found via `/investigate`: `node_info`/`node_update` events are a
**BLE nodedb replay**, not reception evidence (`bridge-events.js`,
`persist.js`'s own comments) — the radio replays its *entire* onboard cache
on every BLE sync, which for any node it hasn't personally re-heard recently
is itself stale. Before this gate, the old COALESCE-only upsert applied that
replay unconditionally, so a resync could silently roll a node's
`short_name`/`long_name`/`hw_model`/position/`last_heard` **backward** to an
old snapshot even after fresher direct reception had already landed.
Confirmed live: 5 real nodes had `nodes.last_heard`/`updated_at` stuck at a
value strictly older than the most recent direct-reception `signal_history`
entry for that node (`signal_history` is written only from `hops===0`
packets — unambiguous real reception) — up to 4.4 days stale.

The gate is on `upsertNode` alone (all 7 call sites in `persist.js` funnel
through it), so every caller is protected uniformly regardless of whether
the stale source was a typed `node_info`/`node_update` replay or a raw
`packet` event carrying mesh-gw's own `_replay:true` flag (also found during
investigation — `handlePacket`'s NODEINFO_APP/POSITION_APP/TELEMETRY_APP
branches never checked that flag before this fix). Callers passing fresh
wall-clock `last_heard` (direct reception, telemetry) are unaffected — the
gate only ever rejects an incoming value that is *older* than what's stored.

`nodeinfo` (below) has no `last_heard` column and cannot self-gate the same
way — deliberately not given one (see `nodeinfo`'s own note) to avoid an
`ALTER TABLE` migration, which this codebase has a documented incident with
(see memory: sqlite-generated-column-migration-guard). It borrows the
sibling `nodes` row's value instead, from `persist.js`'s `_upsertCache`.

**Frozen direct-only `rssi`/`snr`, no timestamp of their own (task
`node-signal-freeze`, 2026-07-25 — mt-transport chat report,
mcpp-chat `mt-transport--node-dash`#13/#17).** `nodes.rssi`/`nodes.snr` are
written only from genuinely-direct reception (`persist.js`'s `isDirect`
gate feeding `pktRssi`/`pktSnr`/`evRssi`/`evSnr`); a relayed packet passes
`null` for both, and the COALESCE upsert above then keeps whatever was
there. So once a node goes relay-only, `nodes.rssi`/`nodes.snr` freeze at
their last direct value **forever** with nothing recording when that was —
a node 2.5km away and relayed could display a bench-proximity reading as
if current, indefinitely. Rather than add a `rssi_ts` column (same
migration-avoidance reasoning as `nodeinfo.last_heard` above), the fix
reuses `signal_history` — already the direct-only-gated ground truth table
— via the new `latestSignalTs` statement: its most recent row's `ts` for a
node IS the age of that node's currently-displayed `rssi`/`snr`, with no
schema change. Consumed by `node-status.js`'s `buildSignal` (see
`docs/modules/node-status.md`).

### `nodeinfo` — persists

Permanent node registry. Survives restarts. Primary key is `node_id` (string, e.g. `"!3f172791"`).
Key columns beyond identity: lat, lon, alt, first_heard, updated_at, address (geocode cache),
last_traceroute (JSON), yagi_last_targeted, yagi_target_count, yagi_last_contact, yagi_contact_count,
yagi_best_rssi, yagi_best_snr, yagi_last_rssi, yagi_last_snr.

**No `last_heard` column, deliberately (task `nodeinfo-replay-regression`,
2026-07-25).** This table has the identical stale-nodedb-replay regression
`nodes` had (same COALESCE-only `upsertNodeinfo`, same `_upsertCache`
caller feeding it from replay data) — but adding a `last_heard` column here
to self-gate would be a schema migration, which this codebase has a
documented crash-loop incident with (memory:
sqlite-generated-column-migration-guard). Instead, `_upsertCache`
(`persist.js`) borrows the sibling `nodes` row's `last_heard` — which by
construction was just written (or correctly rejected) by the caller's own
`upsertNode.run()` moments earlier in the same function — and skips the
`upsertNodeinfo` write when the incoming data is older than that.

### `config` — persists

Key/value store. `key TEXT PRIMARY KEY`, `value TEXT` (always JSON-serialised).

### `events` — persists

Raw event log. id, ts, type, device, data (JSON).

### `range_test_log` — persists

id, ts, from_num, rssi, snr, hops, seq, rx_device, via_mqtt.

### `tilt_history` — persists

id, ts, node_id, pitch, roll, x_g, y_g, z_g, ncal (0=valid, 1=exclude from cal window).

### `environment_history` — persists

id, ts, num, temperature, relative_humidity, barometric_pressure.

### `alert_rules` — persists

type (PK), enabled, threshold, cooldown_minutes, last_sent.
Seeded on startup with: node_offline, ble_disconnect, temp_high, condensation, dm_received, broadcast_direct, tilt_high.

### `reply_tokens` — persists

token (PK), from_node_id, to_num, reply_id, channel, created_at, expires_at.

### `traceroute_history` — persists

id, ts, from_num, to_num, rx_device, route (JSON), route_back (JSON), snr_towards (JSON),
snr_back (JSON), relay_positions (JSON).

## Invariants

- All SQL executes synchronously via better-sqlite3. No async DB calls exist or are permitted.
- `nodes` table is ephemeral: `clearNodeCache()` (DELETE FROM nodes) is called on every cold start.
- `nodeinfo` is the permanent record. Its primary key is `node_id` (string), not `num`. A node without a known node_id cannot be inserted.
- `message_key` is the dedup key for messages. Format `'r-{packet_id}'` for received, `'t-{packet_id}'` for transmitted. The legacy `(packet_id, device)` unique index is retained for rows that predate message_key.
- `_alertedPacketIds` is session-only. It is not persisted. On restart, `isPacketAlerted` falls back to the DB `alerted_at` column.
- The raw `db` export is a code smell: `alerts.js` and `filters.js` use it directly. Future refactor should replace those usages with exported typed functions.
- All config values are stored as JSON strings. `getConfig` always JSON-parses; `setConfig` always JSON-serialises. Callers must not assume string storage.
- Migrations are idempotent. Running the same migration twice is safe (ALTER TABLE is guarded by `PRAGMA table_info` checks).

## Test notes

- Schema smoke test: open a fresh DB, verify all 11 tables exist with expected columns via `PRAGMA table_info`.
- Config round-trip: `setConfig('x', {a:1})` → `getConfig('x')` returns `{a:1}`.
- `insertRxMessage` dedup: insert same message_key twice → second insert updates SNR/RSSI if better, accumulates rx_devices.
- `message_key` format: received packet with id=123 → key is `'r-123'`; sent message with id=123 → key is `'t-123'`.
- `nodes` vs `nodeinfo`: `clearNodeCache()` empties `nodes` but `nodeinfo` rows survive.
- Alert dedup: `markPacketAlerted(id)` → `isPacketAlerted(id)` returns true without hitting DB (Set hit).
- Yagi contact tracking: `recordYagiContact(num, rssi=-80, snr=5)` twice with improving signal → best values updated.
- Reply token expiry: `createReplyToken(…, ttlSeconds=1)` → sleep 2s → `getReplyToken` returns null.
- Tilt NCAL: `markTiltNcal(nodeId, t1, t2)` → rows in window have ncal=1 → excluded from `queryTiltHistory`.
- Migration idempotency: run schema block twice against same DB → no error.

## Out of scope

- Business logic — db.js stores and retrieves; it does not decide what to store or when
- Network I/O — no bridge or HTTP calls
- Event routing — callers decide which events map to which storage calls
- `filters.js` message query logic — that module owns its own query; it imports `db` directly (code smell, not db.js's problem to fix)

## traceroute_history additions (task `perf-per-device`)

Columns `tx_device TEXT`, `rotator_az REAL` (+ ALTER migration). One-shot
startup backfill attributes pre-migration rows to the primary radio (the
only historical dispatcher), guarded by config flag
`migrations.traceroute_tx_device` so later unattributed rows stay null.

## traceroute_history failure recording (task `perf-honesty`, step 2)

Column `status TEXT NOT NULL DEFAULT 'ok'` (ALTER migration; SQLite
backfills the pre-existing success rows to `'ok'`). Values: `'ok'`,
`'timeout'`, `'send_failed'`. New stmt `insertTracerouteFailure` inserts
(ts, from_num, to_num, tx_device, rotator_az, status) with payload columns
NULL; `insertTracerouteHistory` gains the `status` param (success callers
pass `'ok'`). One-shot config stamp `perf.failure_epoch` (unix seconds,
set once in index.js when unset) marks when failure recording began —
success-rate consumers must treat pre-epoch windows as "n/a", never as
100% (no failure rows existed to count).

## nodes.device vocabulary migration (task `node-source-attribution`)

`migrateNodeDeviceMac(pairs)` — `pairs: [{ nodeId: '!hex', mac: 'AA:BB:…' }]`.
Rewrites legacy `nodes.device` values stored as `node_id` (`!hex`) to the
device's BLE MAC (`UPDATE nodes SET device = @mac WHERE device = @nodeId`
per pair) and returns total rows changed. Called once from `index.js` at
startup guarded by config flag `migrations.node_device_mac`, with pairs
resolved from the live MAC↔node_id registry (never MAC-suffix arithmetic).
Rationale: `nodes.device` feeds `restoreDeviceAttribution` and must use the
same MAC vocabulary the `node_source` filter compares against.

## Device-vocabulary migration (task `identity-phase-b`)

`migrateDeviceColumnsToMac(pairs)` — one-shot, config-guarded
(`migrations.device_vocab_mac` in index.js): rewrites `!hex` device ids to
MACs in `traceroute_history.tx_device`, `messages.device`, and inside
`messages.rx_devices` comma-lists (string REPLACE per registry pair).
Unmappable ids are left as-is per IDENTITY.md §7 amnesty.
