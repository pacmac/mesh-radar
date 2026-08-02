---
module: nodes-api
source: src/nodes-api.js
source_hash: 6eece31c5bf09e74142cd88c20262847be42ab76c50cd657da16e9df76ff7bcc
updated: 2026-08-02
---

# Module: nodes-api

## Purpose

Node actions the browser can trigger. Two flags, both per-node, both persisted on
`nodeinfo` so they survive `clearNodeCache()`.

**This spec did not exist until 2026-08-02.** `scripts/check_specs.py` validates
only specs that are present, so a module with no spec passes silently — which is
how this one went unnoticed. Written while adding the second route.

## Routes

| route | flag | meaning |
|---|---|---|
| `PUT /nodes/:num/favourite` | `nodeinfo.favourite` | pin to the sidebar; bypasses every node filter |
| `PUT /nodes/:num/obs_target` | `nodeinfo.obs_target` | **spend airtime pursuing this node** |

## The two flags are never merged

Peter, 2026-08-02: *"that favourite is used for something else. this favourite
only applies to this observer app."*

The three nodes carrying `favourite` today are **TA2m, GARG, GARG** — our own
local units, ~2.5 km away. Wiring discovery to that flag would immediately
traceroute the garage alarm. *"Pin to my sidebar"* and *"spend airtime pursuing
this"* are different intents, so they are different columns, different endpoints
and different icons. See `docs/DISCOVERY_TARGETING.md`.

## Shape, shared by both routes

- A toggle is an **action**, so `PUT` is correct — `BROWSER_CONTRACT`'s transport
  rule restricts `GET` to form flows, not writes.
- `400` on a non-numeric num or a non-boolean value.
- `404` when there is no `nodeinfo` row: the node has never sent identity, so
  there is nothing persistent to attach the flag to. Saying so beats silently
  succeeding.
- The cache is synced afterwards (`syncFavourites` / `syncObsTargets`). Cached
  node objects were enriched when the node was last **heard**, so without the
  sync the flag reads stale until the node next transmits.
- **The response is not the source of truth.** After the write the node list is
  re-broadcast and the browser re-renders from that — no optimistic local state,
  the same rule that fixed the message feed.

## Invariants

- Neither route invents a `nodeinfo` row.
- Neither flag reads or writes the other.
- The browser never holds toggle state of its own.

## Test notes

`PUT /nodes/2469277901/obs_target {obs_target:true}` → `{"num":…,"obs_target":true}`;
the browser's rendered flag went `false → true` via the re-broadcast, not by
local mutation (Playwright, 2026-08-02). `favourite` counts unchanged at 3 with
zero overlap.

## Out of scope

- Node filtering (`node-filter.js`) — `favourite` bypasses it, `obs_target`
  deliberately does not. Recorded as ledger entry **B57** for a decision.
- Anything the Observatory does with the flag; that is `reach.mission`.
