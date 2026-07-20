---
module: client-role
source: src/client-role.js
source_hash: 2ac97a8a2aa2dba1351ab97a4a24ce2ca59a45f7b15cae9870703e1d59426a84
updated: 2026-07-20
---

# Module: client-role

## Purpose

The **single derivation rule** for a node's `client_role` — node-dash's own answer
to "is this node **ours** (a custom/PAC node) and what kind," as distinct from the
Meshtastic `role` ("how it behaves on the mesh"). This is a **CORE** SSOT: the value
is stored in the DB and carried in the node WS feed; plugins and custom-node
surfaces (Control picker, chunk-fetch eligibility, badges) **consume** it but never
re-derive it.

Custom device types cannot be Meshtastic roles — `DeviceConfig.Role` is a closed
protobuf enum (`CLIENT/ROUTER/SENSOR/…`), so a custom value can't be added without
forking firmware **and** the gw. So `client_role` is our own field, mirroring the
role *shape* (a text value), derived here.

## Public interface

```js
export const OUR_ROLES;              // MT roles that currently mark our nodes: ['SENSOR']
export function clientRole(role)     // → the role string when it is one of ours, else null
```

`clientRole('SENSOR')` → `'SENSOR'`; `clientRole('CLIENT_BASE')` → `null`.

## The interim rule

Our alarm firmware doesn't yet declare a clean type; today our custom nodes
**repurpose the MT `SENSOR` role**, so `SENSOR` is the interim marker. `clientRole`
returns the MT role verbatim when it's in `OUR_ROLES`, else `null` (a regular
public node).

**Future (firmware-declared):** when the firmware advertises a real type (e.g.
`PAC_ALARM`) over our own protocol, only this function changes — either `OUR_ROLES`
gains the value, or the function reads the declared type instead of the MT role.
Everything downstream (DB column, WS field, consumers) is unaffected.

## Where it is applied (SSOT — two mirrors of this one rule)

- **DB:** `nodes.client_role` is a **generated** column
  (`CASE WHEN role='SENSOR' THEN role END`), so it stays in sync with `role`
  automatically with no ingest-path changes, and is queryable/filterable
  (`client_role IN (...)`, the same shape as `node_filters.roles`). The generated
  expression mirrors `clientRole`; the two change together.
- **WS feed:** `node-list.js` `enrichFromCache` adds `client_role` to every node it
  emits, via `clientRole(node.user?.role ?? cached.role)` — so the browser receives
  it and never classifies (BROWSER_CONTRACT).

## Invariants

- **One rule.** The membership set (`OUR_ROLES`) and the SQL generated column both
  express the same interim `SENSOR` rule and are documented to change together.
- **Regular nodes → `null`.** Absence of `client_role` means "not ours."
- **Core, not plugin.** The field is core node data; plugins consume it.

## Test notes

- `clientRole('SENSOR')` → `'SENSOR'`; `clientRole('CLIENT')` / `clientRole(null)` → `null`.
- A `SENSOR` node's `nodes.client_role` reads `'SENSOR'`; a `CLIENT_BASE` node's is `null`.
- The node WS feed carries `client_role` on every node; our SENSOR units are
  flagged, regular nodes are `null`.

## Out of scope

- The firmware type declaration — a coordination item with the mt-transport/firmware
  side (raise separately).
- Consumers (Control picker filter, badges) — their own modules; they read this.
