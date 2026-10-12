---
module: node-filter
source: src/node-filter.js
source_hash: 4c25bb75c326eb17a247bb048ff494ba1b8ebb26e628608996d28769fb737b12
updated: 2026-10-11
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
| `node_filters.node_source` | `'all'` | `'all'`, or a device MAC — filter to nodes heard by that one device. **No hardcoded role names** — see the dated section below |

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
10. **roles** — `(node.user?.role ?? node.role ?? 'CLIENT')` not in whitelist (skipped if roles is empty). A null role means protobuf-default `CLIENT` — the firmware omits default enum values on the wire, so unknown-role nodes are CLIENTs and are filtered as such.
11. **node_source** — when `source` is set and ≠ `'all'`: node must have `source`
    (a device MAC) in `_devices`. `source` is the live rotator MAC during a
    scan, or the stored config value otherwise — see the dated section below.
12. **scan active contact check** — when `scanActive`: node must have `_scanAz` or `_scanSnr` set

## Invariants

- Own-device nodes are always excluded from the public list, regardless of all other filters. This check runs first.
- `ownDeviceNums` returns an empty `Set` when the resolver has not been registered. This is safe because no bridge events arrive before `registerMacToNumResolver` is called at startup.
- No MAC-to-num identity inference from MAC suffix arithmetic is permitted. `ownDeviceNums` resolves only through the live resolver.
- When `scanActive` is true, `node_source` is forced to the LIVE rotator MAC
  (`getRotatorAddress()`), regardless of the `node_filters.node_source` config
  value — `null` when no device is configured as the rotator, which correctly
  imposes no device filtering during a scan rather than matching nothing.
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
- **roles null = CLIENT**: roles = `['ROUTER']`, role absent → `false`; roles = `['CLIENT']`, role absent → passes
- **node_source by MAC**: `node_source = RADIO_B`, `_devices` does not include `RADIO_B` → `false`; does include it → passes
- **node_source stale token**: `node_source = 'yagi'` (a pre-2026-10-11 value) matches no real device MAC → excludes everything, same as any other non-matching MAC would. db.js's migration is what prevents this from ever being the live value; the filter itself does not special-case the string.
- **scan active gate**: `scanActive = true`, `_scanAz = null`, `_scanSnr = null` → `false`
- **scan forces the live rotator**: `scanActive = true` overrides the stored `node_source` with `getRotatorAddress()`; with no rotator configured, imposes no device filtering at all
- **ownDeviceNums before registration**: resolver not set → returns `new Set()` (empty)
- **ownDeviceNums after registration**: resolver returns num for each device MAC → Set contains those nums

## Out of scope

- Message query filters — `filters.js` owns those
- Node list state — `node-list.js` calls `passesFilter` inside `_filter()`
- Broadcasting results — `ws-relay.js` receives the filtered list from `node-list`'s `'change'` event
- Config persistence — `db.js` / `config-api.js` own reading and writing filter settings

## V2 field paths (tasks `node-filter-fix`, `node-source-attribution`)

The role filter reads `node.user?.role ?? node.role ?? 'CLIENT'` — node
records carry role inside `user` (DB-enriched) rather than top-level, and a
missing role is the protobuf default `CLIENT`, not "unknown". Nodes with no
role field are therefore included/excluded exactly as CLIENTs.

The `node_source` filter compares device identity by **BLE MAC only**
(`_devices` entries are MACs stamped from `__ble_addr`). `_devices` must
contain only radios that actually HEARD the node — see node-list.md "Device
attribution invariant".

## `node_source` stopped hardcoding `'yagi'`/`'omni'` — 2026-10-11

Peter: *"nobody ever said there would be 1,2,3 or any number of radios or
that any of them would be directional with a rotator."* idiot entry
`node-source-filter-hardcodes-omni-yagi`.

Before: `node_filters.node_source` was `'both'`/`'yagi'`/`'omni'`, and
`scanActive` hardcoded the literal string `'yagi'`. This assumed exactly two
radios, one of them always on a rotator — wrong for a single-radio
deployment (e.g. a Pi running one BLE gateway) and wrong for any deployment
with a different radio count.

After: `node_filters.node_source` is `'all'` (no device filtering) or a
**device MAC**, taken literally. `scanActive` forces the filter onto
`getRotatorAddress()` — the LIVE rotator device, if one is configured — never
a role name. With no rotator configured, `getRotatorAddress()` returns
`null` and a scan imposes no device filtering at all, which is correct: there
is nothing to force the filter onto.

A stale `'both'`/`'omni'`/`'yagi'` value left over from before this change is
migrated to `'all'` once, at boot (`db.js`, `migrations.node_source_device_agnostic_v1`)
— none of those three tokens is a real device MAC, so leaving one in place
would silently filter the node list to nothing rather than "no filter",
which is what every one of them meant under the old scheme.

This is Domain 1 only. The Nodes/Radar page buttons that write this config
key still show hardcoded "YAGI"/"OMNI"/"Both" text and call
`setNodeSource('yagi'|'omni'|'both')` — tracked separately as a Domain 2 task
(one button per live device, labelled from its own config, plus "All") once
this contract is proven.
