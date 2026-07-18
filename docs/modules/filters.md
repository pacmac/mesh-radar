---
module: filters
source: src/filters.js
source_hash: 1d0f6b5970eb7ab4cd604e73114dd876192d89df7ee949920afe472415193a40
updated: 2026-06-30
---

# Module: filters

## Purpose

Dynamic DB query functions for messages and nodes. Builds SQL at runtime from
config-table filter settings so the result set reflects user preferences without
a restart.

## Responsibilities

- Query the `messages` table with per-channel filtering and MQTT-hide option, grouping multi-received packets by `packet_id`
- Query the `nodes` table with up to 8 configurable filter conditions and a whitelisted sort order

## Dependencies

- `db.js` — raw `db` export (direct `db.prepare()` calls — see Invariants) and `getConfig`

## Exports

```js
export function queryMessages(limit = 100)  // → message row[]
export function queryNodes()                 // → node row[]
```

## `queryMessages(limit)`

### Config keys read

| Key | Default | Effect |
|---|---|---|
| `message_filter.channels` | `[]` | If non-empty, `WHERE channel IN (...)` |
| `message_filter.hide_mqtt` | `false` | If true, `WHERE from_num NOT IN (SELECT num FROM mqtt_nodeinfo)` |

### SQL structure

```sql
SELECT
  MIN(m.id)                                         AS id,
  MIN(m.ts)                                         AS ts,
  MIN(m.from_num)                                   AS from_num,
  MIN(m.to_num)                                     AS to_num,
  MIN(m.text)                                       AS text,
  MIN(m.channel)                                    AS channel,
  MIN(m.is_dm)                                      AS is_dm,
  MIN(m.hop_limit)                                  AS hop_limit,
  MAX(m.snr)                                        AS snr,
  MAX(m.rssi)                                       AS rssi,
  MAX(m.hops)                                       AS hops,
  m.packet_id, m.reply_id,
  COALESCE(MAX(m.rx_devices), GROUP_CONCAT(m.device)) AS rx_devices,
  MAX(m.replay)                                     AS replay,
  COALESCE(MIN(m.short_name), MIN(n.short_name))   AS short_name,
  COALESCE(MIN(m.long_name),  MIN(n.long_name))    AS long_name,
  MIN(m.status)                                     AS status
FROM messages m
LEFT JOIN nodes n ON n.num = m.from_num
[WHERE ...]
GROUP BY CASE WHEN m.packet_id IS NOT NULL THEN m.packet_id ELSE m.id END
ORDER BY MAX(m.ts) DESC LIMIT ?
```

### Grouping and deduplication

Rows in the `messages` table may contain multiple entries for the same logical message
(one per receiving radio). They are grouped by `packet_id` when present, or by `id`
(unique per row) for messages without a packet ID — producing one output row per
logical message.

### Aggregation rules

- `snr`, `rssi`, `hops`, `replay` — `MAX` (best reception wins)
- `ts`, `id`, `from_num`, `to_num`, `text`, `channel`, `is_dm`, `hop_limit`, `status` — `MIN` (first reception wins)
- `rx_devices` — `COALESCE(MAX(rx_devices), GROUP_CONCAT(device))`: prefers the stored `rx_devices` JSON array; falls back to concatenating the `device` field across rows
- `short_name`/`long_name` — `COALESCE(MIN(m.*), MIN(n.*))`: message-stored name wins; falls back to live `nodes` table

### Limit

`min(limit, 1000)` — hard cap at 1000 rows regardless of caller input.

### Callers

- `index.js` — `GET /messages?limit=N`
- `ws-relay.js` — pushed as `message_history` on WS connect (limit 50)

---

## `queryNodes()`

### Config keys read

| Key | Default | SQL condition added |
|---|---|---|
| `node_filters.max_age` | `0` | `last_heard >= (unixepoch() - max_age)` (skipped if 0) |
| `node_filters.max_hops` | `99` | `hops <= max_hops` (skipped if ≥ 99) |
| `node_filters.named_only` | `false` | `long_name IS NOT NULL` |
| `node_filters.has_pos` | `false` | `lat IS NOT NULL AND lon IS NOT NULL` |
| `node_filters.hide_mqtt` | `false` | `num NOT IN (SELECT num FROM mqtt_nodeinfo WHERE num IS NOT NULL)` |
| `node_filters.has_signal` | `false` | `snr IS NOT NULL` |
| `node_filters.has_telem` | `false` | `battery IS NOT NULL` |
| `node_filters.roles` | `[]` | `role IN (...)` (skipped if empty) |
| `node_sort.field` | `'last_heard'` | `ORDER BY <field>` (whitelist-validated) |
| `node_sort.dir` | `-1` | `ASC` if ≥ 0, `DESC` if < 0 |

### Sort field whitelist

`SAFE_FIELDS = { 'last_heard', 'snr', 'hops', 'long_name', 'updated_at' }`

Any `node_sort.field` value not in this set falls back to `'last_heard'`. This prevents SQL injection via the config table.

### SQL structure

```sql
SELECT * FROM nodes [WHERE ...] ORDER BY <field> <dir>
```

No LIMIT. Returns all matching rows.

### Callers

`queryNodes` is **not imported by any module**. It is defined but currently unused externally. It may be called directly from the browser via a future REST endpoint, or is dead code pending removal.

---

## Invariants

- Both functions read config on every call — no caching. Filter changes take effect on the next call without a restart.
- **Code smell**: both functions use the raw `db` export from `db.js` and call `db.prepare()` directly at query time. This bypasses the prepared-statement cache in `db.js` (`stmts`). Queries are re-prepared on every call. This is not a correctness issue with better-sqlite3 (it caches internally) but it is an encapsulation leak — these queries should be in `db.js` as named exports.
- `queryMessages` parameters (channel values, limit) are fully parameterised — no interpolation into SQL.
- `queryNodes` filter values are all parameterised. The sort field is whitelist-validated; the sort direction is a ternary, not interpolated from config directly.
- `queryNodes` has no LIMIT. On large databases it returns all matching rows.

## Test notes

- **queryMessages — no filter**: no channel config, hide_mqtt=false → no WHERE clause; returns all messages grouped by packet_id, ordered newest first
- **queryMessages — channel filter**: `message_filter.channels = [0, 1]` → `WHERE channel IN (0, 1)`
- **queryMessages — hide_mqtt**: `message_filter.hide_mqtt = true` → MQTT senders excluded
- **queryMessages — dedup**: two rows with same packet_id → single output row; MAX(snr) from best reception
- **queryMessages — limit cap**: `queryMessages(5000)` → at most 1000 rows returned
- **queryNodes — max_age=0**: condition skipped; all nodes regardless of last_heard
- **queryNodes — sort whitelist**: `node_sort.field = 'injected; DROP TABLE'` → falls back to `last_heard`
- **queryNodes — roles filter**: `node_filters.roles = ['CLIENT', 'ROUTER']` → `role IN ('CLIENT', 'ROUTER')`
- **queryNodes unused**: no module imports `queryNodes` — verify no callers before assuming it's live

## Out of scope

- Traceroute queries — `stmts.queryTracerouteHistory` in `db.js` owns that
- Node full-text or range queries — `db.js` `stmts` handle those
- Writing messages or nodes — `persist.js` owns all writes
