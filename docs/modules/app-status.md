---
module: app-status
source: public/app-status.js
source_hash: 47625484e3729a6465d1351eb3a7d3e1645113195feab14bc91ec7dfd378f5c7
updated: 2026-07-17
---

# Module: app-status

## Purpose

Browser Node Status page mixin (Domain 2) — NODE_STATUS_SPEC Phase C.
Presentation only: requests the `node_status` WS RPC (Phase B), renders the
generic node view + monitored-device enrichment, manages the page's
Chart.js instances, and drives `/status/:id` navigation.

## State

- `statusNum` — the node number the page shows (null when off-page); seeded
  from the URL by `initStatusNum()`.
- `statusData` — the last `node_status` RPC payload (`{node, monitored,
  heartbeats, env, signal}`), or null while loading.
- `monitoredNodes` — the `monitored_nodes` config, mapped from the settings
  WS event (nav pins + is-monitored checks).

## Identity

`/status/:id` accepts a node **number** (`2558179343`) or `!hexid`
(`!987ab80f`). `!hex` is simply the number in hex — parsed client-side
(`parseInt(hex, 16)`); no gateway round-trip. `statusHex(num)` renders the
canonical `!hexid` for URLs and display.

## Interface

- `initStatusNum()` — parse `/status/:id` from the path → `statusNum`.
- `openNodeStatus(num)` — `setNav('status')` after setting `statusNum`;
  pushes `/status/!hexid`.
- `requestNodeStatus()` — sends `{type:'node_status', num}` over the WS
  (page data stays WS-only, C2). Called on entering the tab, on reconnect
  while on-page, and on a `node_status_update` hint for the current node.
- `_onNodeStatus(ev)` / `_onNodeStatusUpdate(ev)` — WS handlers (wired from
  app-ws.js): store payload + (re)draw charts / re-request on hint.
- `statusAge(ts)` — "2m ago" style; the liveness headline.
- `statusIsMonitored(num)` — `!!monitoredNodes[num]`.
- `statusMasked(field)` — true when the monitored entry's `mask` hides a
  field (first use: `battery_pct`).
- `initStatusCharts()` / `destroyStatusCharts()` — Chart.js lifecycle,
  mirroring the perf-page pattern (destroyed on tab-leave in `setNav`).
  Charts: env (temp + humidity), vbat (from heartbeats), signal (rssi/snr).
- `statusHeartbeat()` — latest heartbeat row (`statusData.heartbeats[0]`).

## Contract notes

- No decisions: the verdict (health "all good") is backend-owned and
  deferred; the page shows raw facts and reserves the slot.
- The heartbeat enrichment section renders whatever typed fields exist —
  robust to the sensor firmware's evolving message format (loose capture).
- Charts follow the lazy-tab lifecycle: built on `$nextTick` after entering
  the tab / receiving data, destroyed on leave to release canvases.

## Test notes

Playwright phone (390×844) first + desktop, both themes; deep links by num
and `!hexid`; hint-driven refresh; battery % hidden under the mask; charts
render; 0 console errors.

## Data-driven env (task `status-env-datadriven`)

`statusEnvLatest()` returns the most recent env-history point (env is ascending
by ts) — the source for "current" pressure. `initStatusCharts` adds
`statusPressChart` (barometric_pressure, own axis) only when any env point has a
non-null pressure, so BME280 pressure auto-appears without a dash change.
