---
module: client-role
source: src/client-role.js
source_hash: b438e0ab3a068890e4e58fd703566f913f996fcb0dda3630935fb376bc06c725
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

## The rule -- keyed on the DECLARED role

Our alarm firmware (pac-garage-alarm **260720-2** onward) sets **`user.role = 200`
(`PAC_ALARM`)** in its NodeInfo -- a private value in a reserved PAC range 200-255,
deliberately clear of upstream's 0..12 (which grows upward). `DeviceConfig.Role` is
NOT a closed enum: it is extended upstream, and mt-transport generates its own
protobuf and owns the firmware, so a private value is legitimate.

**Verified on live data:** the gw cannot map a private value to an enum name, so it
arrives as a **float-formatted numeric string** -- `role = "200.0"` (in both
`nodeinfo` and `nodes`), not `"200"` and not a name. So the rule parses it
numerically: `Number(role) === 200`.

- `Number(role) === 200` -> `'PAC_ALARM'` (declared, reliable -- the primary rule).
- `role === 'SENSOR'` -> `'PAC_ALARM'` (**legacy fallback**). Pre-260720-2 alarm
  units still report SENSOR; dropping it would silently unflag a real alarm unit.
  **Retire this once every alarm unit runs 260720-2+.** It carries a false-positive
  risk (a stock node may be SENSOR) which the declared role does not.
- anything else -> `null` (a regular public node).

`client_role` is normalised to **`'PAC_ALARM'`** -- what the node *is to us* -- not
the raw `"200.0"`.

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
