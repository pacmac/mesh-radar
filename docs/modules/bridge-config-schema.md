---
module: bridge-config-schema
source: src/bridge-config-schema.js
source_hash: c9401879e0723f82d9ffed4797bbd10a59db68aae8ec5124f7447d630177f027
updated: 2026-06-30
---

# Module: bridge-config-schema

## Purpose

Static metadata describing the bridge (mesh-gw) configuration fields. Used by
`index.js` to serve a machine-readable schema to the browser so the UI can render
configuration forms without hard-coding field definitions.

## Responsibilities

- Export `BRIDGE_CONFIG_SCHEMA` — a pure data constant; no logic, no imports

## Dependencies

None.

## Exports

```js
export const BRIDGE_CONFIG_SCHEMA  // { fields: [...] }
```

## Schema structure

```js
{
  fields: [
    { name: string, type: 'object', label?: string, fields: FieldDef[] }
  ]
}
```

Each `FieldDef`:

```js
{ name: string, type: 'bool'|'int'|'string', label?: string, hint?: string }
```

## Fields

### `message_cache` (object)

| Field | Type |
|---|---|
| `enabled` | bool |
| `max_messages` | int |
| `max_age_seconds` | int |

### `mqtt_publish` (object)

| Field | Type |
|---|---|
| `enabled` | bool |
| `broker` | string |
| `port` | int |
| `username` | string |
| `password` | string |
| `use_tls` | bool |
| `topic_prefix` | string |
| `ha_discovery` | bool |
| `ha_discovery_prefix` | string |

### `claude_chat` (object, label: "Claude AI Chat")

| Field | Type | Label | Hint |
|---|---|---|---|
| `enabled` | bool | Enable | — |
| `trigger_word` | string | Trigger word | e.g. @claude |
| `system_prompt` | string | System prompt | — |
| `max_history` | int | Max history (messages) | — |
| `max_reply_length` | int | Max reply length (chars) | — |
| `whitelist` | string | Whitelist (comma-separated !hex IDs) | Empty = my_nodes only |
| `my_nodes` | string | My nodes (comma-separated !hex IDs) | Always allowed |

## Callers

| Caller | Usage |
|---|---|
| `index.js` | `GET /schema/bridge_config` → `res.json(BRIDGE_CONFIG_SCHEMA)` |

## Invariants

- Pure data — no functions, no imports, no side effects.
- The schema describes bridge-side config fields; actual values are stored and retrieved through mesh-gw's own config API, proxied by `index.js`.
- Adding or removing fields here changes what the browser renders but does not affect the underlying config storage.

## Out of scope

- Config validation — this is metadata only
- Config read/write — mesh-gw's REST API and `index.js` proxy own that
