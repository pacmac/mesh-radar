---
module: db
source: src/db.js
source_hash: 7ff3aeddaae5a722917a03e5fcee3ece5bd63d88ada65566b959394ab98a67d1
updated: 2026-08-04
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

## `obs_target` — a second flag, never the first

`nodeinfo.obs_target` marks a node as a **discovery target**. It is deliberately
not `favourite`: that flag pins a node to the sidebar and bypasses the node
filters, and the three nodes carrying it are our own local units (TA2m, GARG,
GARG, ~2.5 km away). Wiring discovery to it would spend airtime tracerouting the
garage alarm. Peter: *"that favourite is used for something else. this favourite
only applies to this observer app."*

`setObsTarget()` / `listObsTargets()` mirror the favourite pair.

**Guarded with `PRAGMA table_xinfo`, not `table_info`.** `table_info` omits
generated columns, so a guard reading it can conclude the column is missing on
every boot and re-`ALTER` forever — which took node-dash and DEV1 down once.

`queryFavouriteNodes` also selects `obs_target`, because `node-list._filter()`
synthesises a list entry from that row for a favourite that has not transmitted
this session. Omitting it rendered a targeted node as untargeted — the icon
silently disagreeing with the database.

## Chart series — named queries, not inferences

`attemptsByDay`, `answerRateBySilence`, `answerRateByDistance`. Display
aggregation belongs in the display feed: the catalogue's rule is *small, and one
thing*, and a chart series is something the system **draws** rather than
something it **works out**. Distance banding is done in SQL from stored positions
and the configured home. See `docs/OBSERVATORY_CHARTS.md`.

## `ourChannelUtil(nums)`

The busiest channel utilisation our own radios currently report. Read from
`nodes`, which telemetry keeps current — **not** from the rotator, which has no
such field. Used by the discovery brake; the busiest radio wins, because if
either of ours sees a loaded channel then adding to it is the thing the brake
exists to avoid.

## `relay_observation` — who relayed each packet

Task `packet-provenance-capture`. Full rationale: `docs/modules/relay-observation.md`.

Append-only record of `(ts, from_num, relay_byte, rx_device, hop_start, hop_limit,
transport, decoded)`, written for **every** received packet including encrypted ones.

**Deliberately not part of `signal_history`.** That table is direct-only by design — its
own comment makes the rule auditable ("any row with hops != 0 is a bug") — because relayed
RSSI describes the last hop, not the origin. Relay edges are exactly the relayed packets it
excludes, so storing them there would destroy the one dataset whose meaning is unambiguous.

`relay_byte` is the LOW BYTE of the relaying node, so it resolves to a candidate set rather
than a node (~1 in 256 collide). Stored raw and never resolved here.

Zero-omission defaults are enforced by the writer, not by SQL nullability: `relay_byte`,
`hop_limit` and `transport` are `NOT NULL` with defaults `0`, `0` and `'TRANSPORT_INTERNAL'`,
because proto3 omits zero values and absent must mean zero rather than unknown.

No dedup: two radios hearing one packet is two observations of two different links.

`insertRelayObservation(entry)` / `pruneRelayObservations(days)` — the latter returns the
delete count so callers can log honestly. Retention is driven inline from
`relay-observation.js`, not from `auto-purge` (which purges the radio's NodeDB, not local
tables).

New table via `CREATE TABLE IF NOT EXISTS`, so no migration guard is involved — and in
particular nothing here uses `PRAGMA table_info`, which omits generated columns and
re-`ALTER`s on every boot.

## Chart queries — `rateByBandByDay(days)`

Task `rate-by-band-by-day`. Joins `attemptsByDay`, `answerRateBySilence` and
`answerRateByDistance` as a named display query. Full rationale in
`docs/OBSERVATORY_CHARTS.md`.

Returns one row per `(day, band)` with `attempts`, `answers` and a server-computed `rate`.
Bands are `<25`, `25-100`, `100+`, `no-pos`.

Two deliberate differences from `answerRateByDistance()`, which is left untouched:

- **`LEFT JOIN nodes`, not `JOIN`.** Position-less targets are a third of current attempts
  and answer at 15-21%; the inner join in the older query discards them entirely. They get
  their own `no-pos` bucket and are never folded into a distance band, because they have
  no distance.
- **`rate` is `NULL` below `BAND_MIN_ATTEMPTS` (15).** A day showing 24% on n=21 is noise.
  The threshold lives here rather than in the chart because `BROWSER_CONTRACT` gives the
  browser zero decisions; `attempts`/`answers` are always returned so a suppressed rate is
  still auditable.

The `days` filter is `ts > now - days*86400`, a rolling cut, so the OLDEST day in the
window is always partial — the same convention the other chart queries use.

Measured 35 ms for 108 rows against ~22k `traceroute_history` rows.

## The analysis window — `_windowSql(days, col)`

Task `observatory-window`. Every chart query now takes `days` and applies the same
predicate through one helper.

**`days = 0` means ALL TIME and omits the predicate entirely.** A naive
`ts > now - 0` matches nothing and would render an empty page as though no data existed.

Before this, `attemptsByDay` and `rateByBandByDay` were 30 days while `answerRateBySilence`
and `answerRateByDistance` took no window parameter at all — four series served side by
side, two of them not comparable with the other two, and nothing saying so. Any figure
previously derived from the latter two is an ALL-TIME figure and must be re-derived rather
than carried forward.

`windowBestKm(days)` returns the furthest target ANSWERED inside the window, plus the
count. It is **not** the record: `reach.ladder`'s `record_km` stays all-time because it is
the thing to beat, and a 7-day window would show ~92 km and imply we had gone backwards.
Returns `null` rather than `0` when nothing answered — 0 km would draw as a data point.

## Censored data is never returned as a rate

Task `rate-series-honest-epoch`. `_failureEpoch()` / `_epochSql(col)`.

`perf.failure_epoch` (2026-07-03 07:31 UTC) marks when traceroute FAILURES began being
stored. Before it only successes were written — 617 rows, all `ok` — so any rate spanning
that boundary reads 100%.

- `answerRateBySilence` / `answerRateByDistance` exclude censored rows outright: they are
  rate-only aggregates, so a censored row is simply a guaranteed success in some bucket.
  This moved the all-time figure from 15.0% to 12.6% across all rows.
- `rateByBandByDay` sets `rate: null` and `censored: true` for affected days but KEEPS
  `attempts`/`answers`, so a reader sees why the rate is absent rather than a silent hole.
  A day is censored if `day <= ` the epoch's date — 2026-07-03 straddles the boundary and
  is treated as censored, because a partly-censored day cannot honestly be a rate.
- `attemptsByDay` is NOT filtered: it plots counts, and the rows we hold are the rows we
  hold. Inventing attempts never recorded would be worse than showing few.

**A missing epoch means "nothing known to be censored" and changes nothing.**
`perf.failure_epoch` defaults to `null`, and a naive `ts >= null` would drop every row and
render an empty page.

## `boardVerdicts(days)` — alive / productive / progressing

Task `board-verdicts`. Peter, 2026-08-03: *"at first glance it has been identical since it
was first built, I see no progress and no evidence that anything is even happening."*

Three verdicts, each `ok` | `warn` | `fault`, each with a **server-written basis string** —
BROWSER_CONTRACT gives the browser no decisions, and a coloured light with no stated reason
is a magic number wearing a colour.

Its specification is the five failures invisible on 2026-08-02/03: passive tracing off 9.5 h;
`traceroute.enabled` false 5 days; answer rate 58% → 7%; the beam 148° off; the record flat
30 days.

| verdict | judged against | thresholds |
|---|---|---|
| LOOP | `discovery.interval_sec`, not a fixed number | ok ≤ 3×, warn ≤ 20×, else fault |
| YIELD | the PREVIOUS window of equal length | ok ≥ 80% of prior, warn ≥ 50%, else fault |
| FRONTIER | previous window, plus days since the record moved | ok if higher, fault if flat > 7 days |

First live output at a 7-day window:

```
LOOP      OK      last attempt 82s ago, 48/hour
YIELD     OK      6% of 1299, previous period 7%
FRONTIER  FAULT   92.0 km — record 189.1 km unbeaten 29 days
```

### KNOWN FLAW: YIELD normalises to whatever came before

It reads OK at 6% because 6% against a prior 7% is a ratio of 0.86. **A sustained bad rate
becomes the new baseline and goes green.** It would have caught 58% → 7% while it was
falling, and reports nothing once it has settled.

That is recorded, not fixed. Two candidate remedies, neither chosen: an absolute floor
alongside the ratio, or comparison against a longer baseline than the window. The second
interacts with the global window and should be decided with it.

FRONTIER does not share the flaw — `flat_days` is measured against the all-time record, so
it cannot be normalised away by a poor recent period.

### Sparklines

Per-day buckets. A day under 15 attempts yields `null` and BREAKS the line, reusing the rule
proven in `rateByBandByDay`: a gap reads as "not known", a zero reads as "nothing
happened", and those are different claims. The loop series shows the 5-day blackout plainly
— `468 1 4 1 8 306 511`.

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

## signal_history per-radio attribution (task `signal-provenance-mixed-source`)

`signal_history` was written as ONE row per `(num, packet_id)`, enforced by
`idx_sig_dedup UNIQUE(num, packet_id) WHERE packet_id IS NOT NULL` plus
`INSERT OR IGNORE`. `persist.js` stated the intent outright: *"Deduped by
(num, packet_id) so N gateway radios hearing one broadcast yield one row."*

That is wrong for a two-radio gateway. When OMNI and YAGI both hear the same
broadcast, their two RSSI/SNR readings are an A/B comparison of the two
antennas on an identical packet — the single most useful measurement the
deployment produces, and exactly what antenna work needs. The old shape threw
the second one away, and *which* survived was arbitrary (arrival order). The
table also carried no radio column, so the surviving row could not say which
antenna measured it.

`messages` already solved this problem the other way: `upsertMessage`
accumulates a comma-separated `rx_devices` list on conflict rather than
discarding (`db.js:339-343`). Same repo, same situation, opposite answer.
Signal needs per-radio *values*, not just a list of which radios heard it, so
the fix here is one row per radio rather than a concatenated column.

### Change

- Migration (guarded `PRAGMA table_info(signal_history)` block, same pattern as
  the `traceroute_history` / `environment_history` ALTERs above):
  `ALTER TABLE signal_history ADD COLUMN rx_device TEXT`.
- Drop `idx_sig_dedup`; recreate as
  `UNIQUE(num, packet_id, rx_device) WHERE packet_id IS NOT NULL`.
  Dedup still suppresses a genuine duplicate from the *same* radio; it no
  longer suppresses a second radio's independent reading.
- `insertSignalHistory` gains `@rx_device`.
- `querySignalHistory` returns `rx_device` alongside `ts, rssi, snr`. Purely
  additive — `node-status.js`'s `buildSignalSection` reads `r.rssi`/`r.snr` by
  key and is unaffected.

### Deliberately NOT changed here

- `latestSignalTs` — still "most recent capture for this node, any radio". It
  age-stamps `nodes.rssi`/`nodes.snr`, which remain single per-node scalars.
  De-scalarising those is a follow-up task; doing it here would drag the read
  path and then the browser into a single change, and the browser half is
  Domain 2 (CLAUDE.md: no fix may span domains).
- The `isDirect` hop-arithmetic gate in `persist.js`. It is separately broken —
  1014 of GARG's `hops=0` rows average −39.7 dBm on a 2.5 km link whose
  physical best case is ~−59 dBm — but the fix depends on mesh-gw's answer to
  xsession item [inbound-relay-attribution]. Not guessed at here. Existing rows
  are therefore NOT backfilled or purged: they are a mix of true direct and
  mis-gated relay traffic, and nothing currently distinguishes them.


## `boardVerdicts` — LAST HIT, and the frontier's location

Task `last-hit-card`. Peter, 2026-08-03: *"why is there no last hit card at the
top with the other cards, giving the location, bearing, km and age?"* Then:
*"we need a last hit and a last frontier hit — or maybe the frontier card
already there needs the location?"*

**The second reading won, and the data settled it.** The furthest answered target
IS the number the frontier card already prints. A separate "last frontier hit"
card would have shown `176.2 km` twice and cost a fifth column for nothing. So
the frontier hit does not become a card — it gives the existing frontier card the
three facts it lacked: **who, which way, when**. `176.2 km` alone cannot be acted
on; you cannot re-point an antenna at a scalar.

`last_hit` stays separate because it answers a genuinely different question:

| card | question |
|---|---|
| `last_hit` | did we reach **anything**, and when |
| `frontier` | did we reach **far**, where, and how long ago |

On 2026-08-03 the last hit was 67.5 km 24 minutes earlier while the frontier had
not moved in **29 days**. A board showing only the first reads as healthy while
the goal is static.

### A hit we cannot place is still a hit

`km` and `bearing` are **null**, never `0`, when the answering node has no
position — and `basis` says so. Verified live in production: LAST HIT rendered

```
—
Mid Dorset
7s ago · position unknown, distance unmeasurable
```

Not hypothetical. The only mission answer of that day was Pokey Hollow, a
HELTEC_V3 with no GPS that has never sent a position.

### Two lines, one job each

`where` locates, `basis` judges. They were one string first, which produced a
110-character run that overflowed the card and repeated the value printed above
it. Each verdict string also used to open with its own `curKm` — removed, because
the card prints the number itself.

`locality()` takes the **second** address field: Nominatim returns
`"Clos des Mielles, Castel, GY5 7FX, Guernsey"` and a stat card has room for one
word of it. The first field is the street, which locates nothing at 176 km; the
tail is a postcode, which is precise and tells you nothing.

### Shared helpers, not a fourth copy

Distance and bearing come from `utils.js` (`haversine`, `bearing`) — the SSOT
served to the browser as well, so server and page agree by construction. I first
wrote calls to `greatCircleKm`/`bearingDegrees`, which do not exist in this
codebase; checking rather than assuming is what caught it.

Everything is computed server-side. The browser receives numbers and finished
strings and decides nothing (`BROWSER_CONTRACT`).


## B67 — the one-time backfill of positions we already held

`stranded-positions` found **15** nodes (11 of them heard within
`max_silence_days`) with a valid lat/lon in `nodeinfo` and `NULL` in `nodes`.
Discovery filters on `nodes.lat`, so those nodes were excluded as "no position"
while their position sat in the next table.

### The mechanism was NOT established

Stated plainly rather than papered over. Every current call site passes lat/lon
to both tables — the nodedb path feeds the same `pos` object to `upsertNode` and
`_upsertCache` — and `upsertNode` has carried them on that path since the first
commit (`2ec310f`).

A monotonic-guard explanation was formed and **disproved by the data**: 10 of the
11 had identical `nodes.last_heard` and `nodeinfo.updated_at`, so both writes
happened in the same call and the guard passed. Most likely legacy residue from
an earlier code shape — not proven, and not asserted.

The fix does not depend on knowing: filling a `NULL` with a position we already
hold cannot roll anything backward.

### Why it runs exactly once

Guarded by `migrations.backfill_stranded_positions_v1` in `config`.

A repair that ran on every boot would keep `stranded-positions` reading zero
forever and **destroy the only detector we have** for a recurrence. If the
divergence is still live, the worker will say so again — and that is the signal
that this was a symptom rather than a fix.

Only `lat IS NULL` is filled. A stored `0` is deliberately left alone: it is a
different defect with a different cause (ledger **B69**) and must not be swept
into this one.

### Verified

| check | result |
|---|---|
| copy with the guard key pre-set | 15 → **15**, migration skipped |
| copy without it | `filled 15`, stranded 15 → **0**, positions 610 → 625 |
| same copy re-opened | 0 / 625 — no double-run |
| live after deploy | stranded **0**, positions **625** |
| worker afterwards | *"nodeinfo and nodes agree on every recently-heard position"*, severity `info` |
| selector | `rows_in` 607 → **622**, `unpositioned` 331 → **316**, balance still closes |

## `message_status_event` — outbound status, append-only (task `capture-message-status-from-num`, 2026-08-03)

```sql
CREATE TABLE IF NOT EXISTS message_status_event (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  packet_id INTEGER NOT NULL,
  status    TEXT    NOT NULL,
  from_num  INTEGER,          -- NULL = the event carried no identity; NOT zero
  device    TEXT              -- __ble_addr of the radio that reported it
);
CREATE INDEX idx_msg_status_pkt  ON message_status_event(packet_id, ts);
CREATE INDEX idx_msg_status_from ON message_status_event(from_num, ts DESC);
```

**Why a table and not a column.** `stmts.updateMessageStatus` writes
`messages.status` last-writer-wins, and mesh-gw's `relayed` status is explicitly
non-terminal — it "may arrive zero or more times before the terminal state". The
terminal `no_ack` / `delivered` therefore always destroyed the `relayed` that
preceded it, along with the `from_num` it carried. The sequence is the data, so
it is appended rather than overwritten.

`updateMessageStatus` is unchanged and still maintains the summary column; this
is additive capture only.

Measured on insertion day, one broadcast with `want_ack: true`:

| +s | status | from_num |
|---|---|---|
| 0.1 | `sent` | — |
| 0.5 | `queued` | — |
| 5.8 | `relayed` | 646426545 |
| 30.1 | `no_ack` | — |

**Do not read `from_num` as "the door" without checking the packet was a
unicast.** On a broadcast the value observed was our own sending radio, because
`FloodingRouter.cpp` generates the implicit ack locally and delivers it to the
sender. Whether a unicast DM yields a genuine intermediate node is the open
question this table exists to answer, from traceroute traffic already dispatched.

New table via plain `CREATE TABLE IF NOT EXISTS`, so the `table_xinfo` /
`table_info` migration hazard documented above does not apply — there is no
repeated `ALTER` to guard.

## `frontier.strip` — the frontier card stops being two numbers (task `frontier-strip-payload`, 2026-08-03)

Peter, 2026-08-03: *"I want the top frontier card to be formatted to show the
current window, and the nodes heard and their distance and maybe signal strength
in each bar as a colour."*

The card spent full page width carrying two scalars. It now carries the
distribution: one entry per positioned node on a distance axis, so the shape of
our reach is visible rather than just its maximum.

### Emitted per node

```js
strip: [ { km, hit_rate, attempts, direct, snr_db, tone, label } ]
```

`hit_rate` is `ok/attempts` or **null when never tried** — null is "unknown",
which is not zero, and a never-tried node must not render as a failure.

### `direct` and `snr_db` — the honesty constraint

**`snr_db` is populated ONLY for nodes in `signal_history`, which records DIRECT
receptions.** Measured 2026-08-03: of 503 positioned nodes within 250 km, 189
have been heard at all and only **27** have ever been heard directly.

For the other 476 the RSSI/SNR we hold describes **the last relay hop, not the
node**. Colouring a 180 km bar with it would assert we hear that node strongly
when we are actually hearing a relay 13 km away. So `direct: false` carries
`snr_db: null`, and the renderer must use a flat tone for those rather than
inventing a colour. A chart that implies reach we do not have is worse than no
chart — see the 4x SNR overstatement (B72) and the direct-gate definition change
that briefly looked like an RF collapse.

### Naming — `best_km` supersedes `window_km`

`frontier.window_km` never meant a window in kilometres; it is the **best
distance achieved within the time window**. Discovery's `window_km` *is* a
distance — the 50 km ladder band. Two different meanings, one name, and the card
printed one under a label meaning the other.

`best_km` is added as the correct name. **`window_km` stays, unchanged, as an
alias** — the browser still reads it, and Domain 1 may not change Domain 2 in the
same task. It is removed once the board renders `best_km`.

### `window_days` on the frontier

The card said "this period" without ever naming the period. `window_days` is now
published on `frontier` itself (`0` = all time) so the card can say "last 7
days". The selector already exists on the Charts tab over `[0,1,7,30,60]` and
writes `observatory.window_days`, which is server state — one value, every
viewer sees the same board.

### The default that disagreed with the stored value

`getConfig('observatory.window_days', 30)` and `boardVerdicts(days = 30)` both
defaulted to **30** while the stored value was **7**. If that key ever went
missing, every board figure would silently switch to a 30-day basis with nothing
on screen saying so — the same silent-default class as B74. Both defaults are now
**7**, matching what is actually configured, and `window_days` is published so a
disagreement is visible rather than silent.

### `frontier.reach` — TIME on x, DISTANCE on y

Peter, 2026-08-03, after I built the axes the wrong way round twice: *"i already
told you the x axis is time not istance. the y axis is distance."*

He had said so in his first message on this card and I argued with it. The
distance-ruler (`strip[]`) cannot answer the question the card exists for — **is
the frontier rising?** — and it puts the all-time record near the right edge
purely because the record is a large *number*, which reads as *recent*. That is
why 189.1 kept looking like "the end" however the axis was rescaled: the axis was
the wrong dimension, not the wrong scale.

Plotted against time, a record set on 4 July sits on the **left** at height
189.1, and the gap between the point cloud and that line is the work remaining.

```js
frontier.reach = [ { ts, km, direct, snr_db, label } ]   // one per ANSWERED traceroute
frontier.from_ts, frontier.to_ts                          // x bounds, server-decided
```

`snr_db` non-null only where `direct` — the same honesty rule as the rest of the
card. Live at time of writing: 63 points over a 7-day window, km 0.4 → 176.4,
13 carrying a direct signal, 0 violations.

**A duplicate key that silently won.** `frontier` already carries a `series`
(the daily sparkline, `{day, v}`) later in the same object literal, so the first
version of this — named `series` — was overwritten by it, and the field measured
`NaN` km before the collision was spotted. In a JS object literal the **last**
duplicate key wins, silently. Hence `reach`.

`strip[]` remains only until the card stops reading it.

### `reach[].kind` — colour carries FIRST-EVER CONTACT

Colour was spent on direct-vs-relayed, which is the least interesting thing on
the chart. It now carries the one question no other panel answers: **is the mesh
still yielding nodes we have never reached, or are we re-tracing the same few?**

`kind` is `new` | `direct` | `relay`, decided here so the browser only maps it to
a colour. `first_ever` is also published for the tooltip.

**`new` is computed against ALL history, not the window.** A node first reached
last month is not a discovery today, and computing it from the window alone would
relabel every returning node as new each time the window rolled.

Live at time of writing, 7-day window: relay 48, direct 13, **new 4** —
`TM89 65.4 km`, `24f0 22 km`, `59a7 175.7 km`, `Luke 176.4 km`.

`Luke` is the window's best distance **and** a first-ever contact, which is the
argument for this encoding in one bar: the frontier moved because we reached new
ground, not because we re-traced known nodes.

**Do not read the bar count as mesh activity.** Attempts went 1, 4, 1, 0, 8, 306,
1140 per day across this window — the dense right-hand side is OUR attempt volume
resuming, not the mesh waking up. Successes without their denominator will always
tell that story; the `new` colour is what separates genuine discovery from it.

## `DIRECT_GATE_TS` — direct-ness before 27 Jul is unverified (B76, 2026-08-04)

Before commit `4340f56` (**1785178885**, 2026-07-27 20:01:25 +0100)
`isDirectPacket` tested hop arithmetic **alone**, so a relayed packet could
satisfy it and be written to `signal_history` as a direct reception. Split on
that timestamp:

```
before   26 positioned nodes, furthest 143.2 km (JBS)
after     3 positioned nodes, furthest   2.5 km (GARG)
```

Our verified direct reach is **GARG at 2.5 km and the bench unit**. The 143 km
"direct" contacts are artefacts of the old test.

**Rows are not deleted.** The old test could not distinguish direct from relayed —
that is why it was replaced — but it does not follow that every old row is false.
They are *unverified*, not *wrong*.

### Claiming versus candidacy

The distinction that makes this workable:

- **Claiming** — anything that tells a human "we heard this node directly" filters
  on the epoch. `frontierSeries()` and `frontierStrip()` both do, which drops the
  card's green "heard direct" bars from **27 to 3**. That is the honest number and
  it is deliberately unflattering.
- **Candidacy** — `doors.js` may still use pre-gate rows as weak evidence that a
  node is audible, ranked strictly **below** verified receptions. Excluding them
  would remove 16 of 36 candidates and cost byte `176` its only resolution (`S2`
  has four pre-gate rows and has never once arrived unrelayed), undoing the
  bootstrap fix for no gain. Verified after the split: **297 of 297** targets
  still resolve, byte 4 still `!2d4cd04`.

Caveat: the epoch is the **commit** time. Deployment may have lagged it, so rows
in the minutes immediately after are marginally less certain.
