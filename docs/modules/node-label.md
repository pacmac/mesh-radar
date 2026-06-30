---
module: node-label
source: src/node-label.js
source_hash: cd4ed7b6cf169a1915512398154d602800b24a53a8ead7021ae3145b503df9bd
updated: 2026-06-30
---

# Module: node-label

## Purpose

Display name resolver for mesh nodes. Applies a three-step priority rule to
produce a human-readable label from a node number, falling back from user-set
aliases to mesh short names to a hex suffix.

## Responsibilities

- Register a live MAC lookup resolver (injected at startup via `registerMacResolver`)
- Resolve a node num to its best available display label (`resolveNodeLabel`)
- Provide a convenience wrapper that accepts a `!hexid` string (`resolveDeviceLabel`)

## Dependencies

- `node-list.js` — `nodeList._cache` (private field — encapsulation leak; see Invariants)
- `device-config.js` — `getAllDeviceCfgs`

## Exports

```js
export function registerMacResolver(fn)       // fn(!hexid) → MAC|null — register live lookup; call once at startup
export function resolveNodeLabel(num)          // → string|null — display name for a node num
export function resolveDeviceLabel(nodeId)     // → string|null — display name for a !hexid string
```

## Resolution priority (`resolveNodeLabel(num)`)

```
1. device_cfg label (user alias)
   → _nodeIdToMac(nodeId) → MAC
   → getAllDeviceCfgs()[MAC].label   (if non-null)

2. mesh short_name
   → nodeList._cache.get(num).user.short_name   (if present)

3. hex fallback
   → '?' + last 3 hex chars of node num (uppercase)
   e.g. num 0xfa39f7b4 → '?7B4'
```

Returns `null` if `num` is null or undefined.

**Note:** The code comment says "last 4 hex chars" but the implementation uses `hex.slice(-3)` — 3 characters. The spec reflects the actual code behaviour.

## `resolveDeviceLabel(nodeId)`

Convenience wrapper for `!hexid` strings:
1. If `nodeId` is falsy → returns null
2. Strips the `!` prefix, parses as hex integer
3. If `NaN` (invalid hex) → returns `nodeId` as-is
4. Otherwise → `resolveNodeLabel(num)`

## Callers

| Caller | Usage |
|---|---|
| `index.js` | `resolveNodeLabel` for message rows; `resolveDeviceLabel` for traceroute rx_name; `registerMacResolver` at startup |
| `ws-relay.js` | `resolveNodeLabel` to add `display_name` to nodes, messages, traceroute results; `resolveDeviceLabel` for device events |

## Invariants

- `resolveNodeLabel` returns `null` only when `num` is null/undefined. All other inputs produce a string (even unknown nodes get the hex fallback).
- `resolveDeviceLabel` returns the raw `nodeId` string if hex parsing fails — it does not return null for unparseable input.
- `_nodeIdToMac` is null until `registerMacResolver` is called. Before registration, step 1 is skipped and resolution falls through to step 2 or 3.
- **Encapsulation leak**: `resolveNodeLabel` reads `nodeList._cache` directly (private Map). This should be replaced with a public `nodeList.getShortName(num)` accessor when node-list.js is refactored.
- The fallback is the last **3** uppercase hex characters of the 8-digit zero-padded node number (not 4 as stated in the source comment).
- `getAllDeviceCfgs()` is called on every `resolveNodeLabel` invocation — no cache. Resolution cost is proportional to the number of configured devices.

## Test notes

- **priority 1 (device label)**: device has `label: 'YAGI'` → `resolveNodeLabel(num) === 'YAGI'`
- **priority 2 (short_name)**: no device label, cache has `user.short_name: 'Alice'` → returns `'Alice'`
- **priority 3 (hex fallback)**: nothing in device_cfg or cache → `num = 0xfa39f7b4` → `'?7B4'`
- **null input**: `resolveNodeLabel(null) === null`
- **resolveDeviceLabel**:
  - `'!fa39f7b4'` → `resolveNodeLabel(0xfa39f7b4)`
  - `'!gggg'` (invalid hex) → `'!gggg'` (returned as-is)
  - `null` → `null`
- **resolver not registered**: `_nodeIdToMac` null → step 1 skipped; resolution proceeds to step 2/3

## Out of scope

- Storing or modifying display names — this module is read-only
- Long name resolution — `long_name` is not used; `short_name` is the mesh name source
- Per-node aliases beyond the device config label — only `device_cfg.label` is used
