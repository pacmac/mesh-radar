---
module: db
source: src/db.js
source_hash: d5ef5a2a551a6e5ba4ed34d477c72ab2bc382e39a2ba01b8e4dc51acd12a8cb9
updated: 2026-06-30
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
insertTilt(entry)                   // → void  — { ts, node_id, pitch, roll, x_g, y_g, z_g }
queryTiltHistory(nodeId, sinceTs)   // → row[]  — ncal=0 only, ASC by ts
queryAllTiltHistory(sinceTs)        // → row[]  — all node_ids, ncal=0 only
markTiltNcal(nodeId, tsFrom, tsTo)  // → number — rows changed
getTiltCal()                        // → { zero: number|null, north_angle: number|null }
saveTiltCal({ zero, north_angle })  // → void  — undefined fields are not written
```

### Environment history

```js
insertEnvHistory(entry)             // → void  — { ts, num, temperature, relative_humidity, barometric_pressure }
queryEnvHistory(num, sinceTs)       // → row[]
queryAllEnvHistory(sinceTs)         // → row[]
```

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
| `insertTxMessage` | INSERT OR IGNORE into messages (sent messages, message_key = 't-{id}') |
| `updateMessageStatus` | UPDATE messages SET status WHERE packet_id (TX rows only) |
| `upsertNodeinfo` | INSERT … ON CONFLICT(node_id) — COALESCE merge into persistent nodeinfo |
| `upsertNode` | INSERT … ON CONFLICT(num) — COALESCE merge into ephemeral nodes |
| `insertEvent` | INSERT into events log |
| `insertRangeTest` | INSERT into range_test_log |
| `queryRangeTest` | SELECT … ORDER BY ts DESC LIMIT ? |
| `clearRangeTest` | DELETE FROM range_test_log |
| `clearNodes` | DELETE FROM nodes |
| `getNodeinfoByNum` | SELECT * FROM nodeinfo WHERE num = ? |
| `upsertTraceroute` | UPDATE nodeinfo SET last_traceroute WHERE num |
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
| `insertEnvHistory` | INSERT into environment_history |
| `queryEnvHistory` | SELECT from environment_history WHERE num AND ts >= |
| `queryAllEnvHistory` | SELECT from environment_history WHERE ts >= |

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

Unique index on `(packet_id, device)` WHERE packet_id IS NOT NULL (legacy).
Unique index on `message_key` WHERE message_key IS NOT NULL (current dedup).

### `nodes` — ephemeral (cleared on restart)

Live node state from the bridge. COALESCE upsert — existing non-null values are never overwritten with null.
Columns: num (PK), node_id, short_name, long_name, hw_model, role, last_heard, snr, rssi, hops, lat, lon, alt, battery, voltage, channel_util, air_util_tx, uptime_seconds, device, temperature, relative_humidity, barometric_pressure, updated_at.

### `nodeinfo` — persists

Permanent node registry. Survives restarts. Primary key is `node_id` (string, e.g. `"!3f172791"`).
Key columns beyond identity: lat, lon, alt, first_heard, updated_at, address (geocode cache),
last_traceroute (JSON), yagi_last_targeted, yagi_target_count, yagi_last_contact, yagi_contact_count,
yagi_best_rssi, yagi_best_snr, yagi_last_rssi, yagi_last_snr.

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
