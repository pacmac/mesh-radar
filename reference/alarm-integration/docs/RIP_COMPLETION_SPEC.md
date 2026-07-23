# Rip completion — spec

Step 2 of `status-rebuild-rip`. Finishes the excision that commit `6e72a1a`
started, so step 3 (ingestion) is built on a tree with no surviving status-page
state.

## Why this step exists

`6e72a1a` deleted by **file list**, not by symbol sweep: it removed the files it
knew about and never opened the files that merely *referenced* them. Its
"0 dangling refs" claim was not verified against the browser partials or
`config-api.js`, both of which still carry live status-page code.

A symbol sweep over `src/` and `public/` for
`heartbeat|node_status|monitored_?nodes|openNodeStatus|statusNum|tab-status|app-status`
produced the inventory below.

## Inventory

### A. Dangling browser references (broken today)

`public/partials/drawer-sidebar.html:92-100` renders monitored-node nav pins
that call `openNodeStatus()` and read `statusNum`. **Neither symbol is defined
anywhere in the codebase** — verified by grep across `public/` and `src/`. The
`:class` also tests `tab==='status'`, a tab removed in `6e72a1a`. Clicking a pin
throws.

### B. Live backend for the deleted page

`src/config-api.js`
- `:29` — `'monitored_nodes': {}` in `DEFAULTS`
- `:123-148` — `GET`/`PUT /monitored_nodes` routes, including
  `expected_heartbeat_s` validation, commented "the status page's
  monitored-device designation"

### C. Browser state feeding B

- `public/app.js:33` — `monitoredNodes: {}` root state
- `public/app-ws.js:79` — `this.monitoredNodes = cfg['monitored_nodes'] ?? {}`

### D. Orphaned DB state (live `data/node-dash.db`)

- **Table `sensor_heartbeats`** — 16 rows, 2 nodes, span
  `1784282290`–`1784320619`. No longer created or referenced by `src/db.js`;
  survives only because `CREATE TABLE IF NOT EXISTS` removal does not drop.
  Its `raw` column holds literal heartbeat text
  (`v=trial-fw-v1 up=40s boot=3 rst=0x0 vbat=4.23V/100% ...`) from
  `trial-fw-v1`/`v2` — **the exact parsing `NODE_STATUS_SPEC.md` forbids.**
- **Config keys**: `monitored_nodes`, `migrations.sensor_heartbeats_backfill`,
  `migrations.sensor_heartbeats_backfill_v2`

### E. Stale doc prose

`docs/modules/`: `persist.md` (6 hits), `db.md` (6), `config-api.md` (9),
`ws-relay.md` (6), `drawer-sidebar.md` (1). Hashes were bumped during the rip;
prose was never trimmed.

## Changes

| File | Change |
|---|---|
| `public/partials/drawer-sidebar.html` | delete lines 92–100 (comment + `<template>` pin block) |
| `src/config-api.js` | delete `:29` DEFAULTS entry; delete `:123-148` route block |
| `public/app.js` | delete `:33` `monitoredNodes: {}` |
| `public/app-ws.js` | delete `:79` `monitoredNodes` assignment |
| `docs/modules/config-api.md` | remove monitored_nodes/heartbeat prose; update `source_hash` |
| `docs/modules/drawer-sidebar.md` | remove status-pin prose; update `source_hash` |
| `docs/modules/app-ws.md` | remove monitored_nodes prose; update `source_hash` |
| `docs/modules/persist.md` | remove dead node_status/heartbeat prose (hash unchanged — source untouched) |
| `docs/modules/db.md` | remove dead node_status/heartbeat prose (hash unchanged) |
| `docs/modules/ws-relay.md` | remove dead node_status/heartbeat prose (hash unchanged) |

After removing the `DEFAULTS` entry, `GET /monitored_nodes` falls through to the
catch-all `router.get('/:key')` at `:150`, which returns 404 for unknown keys.
That is the correct post-rip behaviour, not a regression.

## DB cleanup — method

**Not** a migration in `src/db.js`. Adding heartbeat-named cleanup code to
`db.js` would leave the taint permanently in the source the rip was meant to
clear. This is a one-time operation on one live database, executed directly:

1. Back up to the session scratchpad first — `sensor_heartbeats` rows and the
   three config key/value pairs — so the drop is reversible.
2. `DROP TABLE sensor_heartbeats;`
3. `DELETE FROM config WHERE key IN ('monitored_nodes',
   'migrations.sensor_heartbeats_backfill',
   'migrations.sensor_heartbeats_backfill_v2');`

No code residue.

## Explicitly NOT in scope

- **`environment_history` triple-writer, 13,571 duplicate rows, 2,607 bogus
  timestamps.** Pre-existing, predates the status page (the `bridge-events.js`
  writer dates to `77dea64`), and rebuilding that ingestion **is** step 3's
  deliverable. Fixing it here would be step 3 under another name.
- **`ws-relay.js:466` PRIVATE_APP string-match collision risk.** Real, but it is
  portnum-260 routing — step 3.
- **`public/app-helpers.js:78` `DETECTION_SENSOR_APP` label.** Not a leftover;
  it is a generic portnum display label that step 3 will use.

## Done when

- The sweep regex returns zero hits across `src/` and `public/`
- `sensor_heartbeats` absent from `.tables`; the three config keys gone
- App boots; sidebar renders with no console error
- `python scripts/check_specs.py` prints `All specs current.`
