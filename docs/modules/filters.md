---
module: filters
source: src/filters.js
source_hash: 623fb1eedb859a9fa9092ae52b13cccea3da2efac963c2fd77a99a01f7ed53f0
updated: 2026-08-18
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
```

`queryNodes()` was **removed 2026-08-18** — see "Removed: queryNodes and the
mqtt_nodeinfo filters" below.

## `queryMessages(limit)`

### Config keys read

| Key | Default | Effect |
|---|---|---|
| `message_filter.channels` | `[]` | If non-empty, `WHERE channel IN (...)` |
| ~~`message_filter.hide_mqtt`~~ | — | **REMOVED 2026-08-18.** Queried `mqtt_nodeinfo`, a table that has never existed |

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
  MAX(m.category)                                   AS category,
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
- `category` — `MAX(m.category)`: the non-null outbound tag if any row has one
- `short_name`/`long_name` — `COALESCE(MIN(m.*), MIN(n.*))`: message-stored name wins; falls back to live `nodes` table

### `channel_name` (post-query, resolved per-row before aggregation)

Each returned row gains `channel_name` — the **logical channel name** (Primary /
Private / mqtt / …), resolved from the raw per-gateway index that `channel` holds.
The stored `channel` is a per-gateway INDEX in both directions, and the *same number
is a different channel on different radios* (`(OMNI,1)=mqtt` vs `(YAGI,1)=Private`),
so resolution must be per-device and must happen **before** the `packet_id`
collapse — a packet heard by OMNI(idx2) and YAGI(idx1) must resolve each row to
`Private` and then agree.

Mechanism: the SELECT emits `GROUP_CONCAT(DISTINCT m.device || '@' || m.channel) AS
_dev_chans` (`@` separator — a MAC already contains `:`). Post-query, JS splits the
pairs and calls `getChannelNameByMac(mac, index)` (`ws-relay.js`) for each, taking
the first non-null name. `_dev_chans` is stripped from the output; `channel_name`
is added to the row. Resolution is a pure read of the in-memory
`lastDeviceChannels` cache — no network, no new table, no migration. If no pair
resolves (gateway not cached yet, or an unconfigured overhearing radio),
`channel_name` is `null` and the browser falls back to the raw `channel`.

The raw `channel` int is still emitted unchanged (the interim raw-number filter,
commit e774fac, keeps working); `channel_name` is purely additive.

### Import cycle note

`filters.js` imports `getChannelNameByMac` from `ws-relay.js`, which imports
`queryMessages` from `filters.js`. This ESM cycle is **call-time only** — neither
binding is used during module initialisation, only when a query runs — so live
bindings resolve correctly. Not an init-order hazard.

### Limit

`min(limit, 1000)` — hard cap at 1000 rows regardless of caller input.

### Callers

- `index.js` — `GET /messages?limit=N`
- `ws-relay.js` — pushed as `message_history` on WS connect (limit 50)

---

## Removed: `queryNodes()` and the `mqtt_nodeinfo` filters

**Both deleted 2026-08-18, task `filters-dead-mqtt-sql`.** They filtered on a
table — `mqtt_nodeinfo` — that has never existed in `data/node-dash.db`.

| what | state when removed |
|---|---|
| `queryNodes()` | **zero callers** in `src/` or `public/`, and it **threw**: `node_filters.hide_mqtt` is `true` in config, so the branch was reached and SQLite answered `no such table: mqtt_nodeinfo` |
| `message_filter.hide_mqtt` branch in `queryMessages()` | `queryMessages` **is** live (`index.js`, `ws-relay.js`); the branch was unreachable only because the key is unset and defaults `false` |

A dead function is housekeeping. A dead function that throws the moment someone
wires it up is a trap for whoever wires it up, which is why it was deleted rather
than left.

**Nothing was lost.** The live node list is filtered in `node-filter.js` against
the in-memory cache, not by SQL here. MQTT-only nodes are excluded by
`node_filters.hide_mqtt_only` (default `true`), which tests `rf_last_heard` — our
own RF evidence — and works.

**Not replaced by creating an empty `mqtt_nodeinfo`.** A filter that silently
matches nothing is worse than one that throws: the page looks filtered and is not.

### Still outstanding, Domain 2

`node_filters.hide_mqtt` remains a live UI toggle (`app-forms.js`,
`app-nodes.js`, `app-ws.js`) and is currently **on**. In `node-filter.js:82` it
tests `node.via_mqtt`, which nothing populates — a permanent no-op, but plain JS,
so it cannot throw. It is misleading rather than dangerous: it reads as though it
hides MQTT nodes while `hide_mqtt_only` is what actually does. Removing the
control, or reinstating MQTT provenance properly (`relay_observation` and
`ev.via_mqtt` both exist), is a browser-side task and Peter's call.

---

## Invariants

- `queryMessages` reads config on every call — no caching. Filter changes take effect on the next call without a restart.
- **Code smell**: `queryMessages` uses the raw `db` export from `db.js` and call `db.prepare()` directly at query time. This bypasses the prepared-statement cache in `db.js` (`stmts`). Queries are re-prepared on every call. This is not a correctness issue with better-sqlite3 (it caches internally) but it is an encapsulation leak — these queries should be in `db.js` as named exports.
- `queryMessages` parameters (channel values, limit) are fully parameterised — no interpolation into SQL.

## Test notes

- **queryMessages — no filter**: no channel config, hide_mqtt=false → no WHERE clause; returns all messages grouped by packet_id, ordered newest first
- **queryMessages — channel filter**: `message_filter.channels = [0, 1]` → `WHERE channel IN (0, 1)`
- **queryMessages — dedup**: two rows with same packet_id → single output row; MAX(snr) from best reception
- **queryMessages — limit cap**: `queryMessages(5000)` → at most 1000 rows returned

## Out of scope

- Traceroute queries — `stmts.queryTracerouteHistory` in `db.js` owns that
- Node full-text or range queries — `db.js` `stmts` handle those
- Writing messages or nodes — `persist.js` owns all writes
- **no `mqtt_nodeinfo` anywhere**: `grep -rn mqtt_nodeinfo src/` returns comments only
