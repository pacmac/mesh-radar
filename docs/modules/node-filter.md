---
module: node-filter
source: src/node-filter.js
source_hash: 55a5d066a78b12c52b6acc8adf06932acc07c2866f657a2c737397a356a41f45
updated: 2026-06-30
---

# Module: node-filter

## Purpose

Single source of truth for node visibility decisions. `passesFilter` determines
whether a node entry should appear in the public node list given the current user
configuration. `ownDeviceNums` returns the set of node nums for all locally
configured BLE devices so callers can exclude them from public lists.

No node visibility logic lives anywhere else.

## Responsibilities

- Evaluate all user-configured node filters in one function (`passesFilter`)
- Return the set of own-device node nums (`ownDeviceNums`) for exclusion by callers
- Accept a late-bound MAC→num resolver to avoid a circular dependency on ws-relay.js

## Dependencies

- `db.js` — `getConfig` (reads all `node_filters.*` keys on every call)
- `device-config.js` — `getRotatorAddress`, `getAllDeviceCfgs`
- `utils.js` — `nodeIdToNum`

## Public interface

```js
// Register the MAC → node_num resolver. Must be called once at startup
// before any bridge events arrive.
registerMacToNumResolver(fn: (mac: string) => number | null)

// Returns the Set of node nums for all configured BLE devices.
// Returns an empty Set before the resolver is registered.
ownDeviceNums()  // → Set<number>

// Returns true if node should appear in the public node list.
passesFilter(node, opts?)  // → boolean
// opts: { scanActive?: boolean, ownNums?: Set<number> }
```

## State

| Field | Type | Description |
|---|---|---|
| `_macToNum` | function\|null | MAC→num resolver registered by `index.js` at startup |

## Events emitted

_N/A_

## Config keys read by `passesFilter`

All keys are read from the `config` table on every call via `getConfig`.

| Key | Default | Effect when active |
|---|---|---|
| `node_filters.max_age` | `0` | Exclude nodes not heard within this many seconds (0 = disabled) |
| `node_filters.max_hops` | `99` | Exclude nodes with hops_away > this value |
| `node_filters.named_only` | `false` | Require `user.long_name` |
| `node_filters.has_pos` | `false` | Require `position.latitude_i` |
| `node_filters.hide_mqtt` | `false` | Exclude `via_mqtt === true` nodes |
| `node_filters.has_signal` | `false` | Require `snr` or `rssi` to be non-null |
| `node_filters.has_telem` | `false` | Require `device_metrics` to be present |
| `node_filters.msg_only` | `false` | Exclude `user.is_unmessagable === true` nodes |
| `node_filters.roles` | `[]` | Role whitelist; empty = all roles pass |
| `node_filters.node_source` | `'both'` | `'both'` / `'yagi'` / `'omni'` — filter by receiving radio |

## Filter evaluation order

`passesFilter` applies filters in this order; the first `false` short-circuits:

1. **Own device exclusion** — `ownNums.has(node.num)` → always excluded
2. **max_age** — `(now - node.last_heard) > max_age` (skipped if max_age = 0 or last_heard null)
3. **max_hops** — `node.hops_away ?? node.hops ?? 0 > max_hops`
4. **named_only** — no `user.long_name`
5. **has_pos** — no `position.latitude_i`
6. **hide_mqtt** — `node.via_mqtt` is truthy
7. **has_signal** — both `snr` and `rssi` are null
8. **has_telem** — no `device_metrics`
9. **msg_only** — `user.is_unmessagable` is truthy
10. **roles** — `node.role` not in whitelist (skipped if roles is empty or node.role is null)
11. **node_source** — when rotatorId is known and source ≠ 'both':
    - `'yagi'`: node must have rotator MAC in `_devices`
    - `'omni'`: node must have at least one non-rotator MAC in `_devices`
12. **scan active contact check** — when `scanActive`: node must have `_scanAz` or `_scanSnr` set

## Invariants

- Own-device nodes are always excluded from the public list, regardless of all other filters. This check runs first.
- `ownDeviceNums` returns an empty `Set` when the resolver has not been registered. This is safe because no bridge events arrive before `registerMacToNumResolver` is called at startup.
- No MAC-to-num identity inference from MAC suffix arithmetic is permitted. `ownDeviceNums` resolves only through the live resolver.
- When `scanActive` is true, `node_source` is forced to `'yagi'` regardless of the `node_filters.node_source` config value.
- Config is read fresh on every `passesFilter` call — no caching. This ensures filter changes take effect immediately on the next `refilter()` cycle without requiring a restart.
- `passesFilter` is pure with respect to its inputs plus the config table. It has no other side effects.

## Test notes

- **own device exclusion**: `ownNums` contains `node.num` → returns `false` regardless of other fields
- **max_age**: `last_heard = now - 601`, `max_age = 600` → `false`; `max_age = 0` → skipped
- **max_hops**: `hops_away = 3`, `max_hops = 2` → `false`; falls back to `node.hops` if `hops_away` absent
- **named_only**: `user.long_name` absent → `false`
- **has_pos**: `position.latitude_i` absent or falsy → `false`
- **hide_mqtt**: `via_mqtt = true` → `false`
- **has_signal**: both `snr` and `rssi` null → `false`; either present → passes
- **roles whitelist**: roles = `['ROUTER']`, node.role = `'CLIENT'` → `false`; roles = [] → passes
- **node_source yagi**: rotatorId set, source = `'yagi'`, `_devices` does not include rotatorId → `false`
- **node_source omni**: all `_devices` entries are rotatorId → `false`
- **scan active gate**: `scanActive = true`, `_scanAz = null`, `_scanSnr = null` → `false`
- **scan forces yagi**: `scanActive = true`, config `node_source = 'omni'` is ignored → yagi check applied
- **ownDeviceNums before registration**: resolver not set → returns `new Set()` (empty)
- **ownDeviceNums after registration**: resolver returns num for each device MAC → Set contains those nums

## Out of scope

- Message query filters — `filters.js` owns those
- Node list state — `node-list.js` calls `passesFilter` inside `_filter()`
- Broadcasting results — `ws-relay.js` receives the filtered list from `node-list`'s `'change'` event
- Config persistence — `db.js` / `config-api.js` own reading and writing filter settings

## V2 field paths (task `node-filter-fix`)

The role filter reads `node.user?.role ?? node.role` — node records carry
role inside `user` (DB-enriched) rather than top-level. Nodes with unknown
role pass any roles filter by design.
