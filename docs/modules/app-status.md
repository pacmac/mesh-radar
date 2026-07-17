---
module: app-status
source: public/app-status.js
source_hash: ad5c8de6d5d919dd9278d413863fa969823943bce542a1c57c7a4db286b6b2b4
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

## Freshness-aware precedence (task `status-fresh-precedence`)

The custom `{type:status}` JSON heartbeat is a separate, firmware-under-
development stream that can go quiet while the node stays alive on standard
Meshtastic telemetry (`nodes` row: `last_heard`, `voltage`, `battery`,
`uptime_seconds`, `temperature`, `relative_humidity`). Bug (node `!987ab80f`,
2026-07-17): the page preferred `statusHeartbeat()` (a snapshot ~6.5 h old)
over the live `nodes` values, so Uptime showed 1h 27m vs a real 7h 50m,
Environment 35.1 °C/25 %rh vs 27.5/39.9, Power 4.18 V/97 % vs 4.15/94.

For any value that exists in **both** the live `nodes` telemetry and the
heartbeat snapshot, prefer the **fresher** source:

- `statusVal(nodeVal, hbVal)` — returns whichever was observed more recently.
  Live timestamp is `statusData.node.last_heard`; snapshot timestamp is
  `statusHeartbeat()?.ts`. If one side is null, returns the other; when both
  present, picks `hbTs > nodeTs ? hbVal : nodeVal`. So a device actively
  custom-heartbeating still shows the fresher heartbeat voltage, while a quiet
  stream correctly yields to live telemetry.
- `statusHbAge()` — `statusAge(statusHeartbeat()?.ts)`: formatted age of the
  latest custom heartbeat, for the staleness caption.
- `statusHbStale()` — true when a heartbeat exists and the node has been heard
  more than `HB_STALE_GRACE` (300 s) more recently than that heartbeat
  (`last_heard - hb.ts > 300`), i.e. the custom stream lags the node's
  liveness. Drives the warning tint on heartbeat-only fields.

Heartbeat-only fields with no live equivalent — `boot`/`rst`, `trig`, `fw`,
`env_err` — keep their heartbeat source but the template shows `statusHbAge()`
so they never masquerade as current.

Not changed: the vbat chart plots heartbeat samples only (node-dash stores no
device-metrics history — established design); it legitimately ends where the
samples end and is *history*, not a lying current-value. `statusEnvLatest()`
stays the pressure source (no heartbeat equivalent — no precedence conflict).

## SSOT unit formatters (task `status-fmt-ssot`)

Conversion/rounding must not be duplicated across the page. `uiMixin`
(`app-ui.js`) is the formatter home (`fmtUptime`/`fmtBytes`/`fmtAge`); all
mixins merge into one Alpine object (`app.js`), so its methods are callable
both from templates and from `this.*` inside this mixin. Added there, each
returning `'–'` on null/non-finite:

- `fmtVolts(v)` → `2dp + 'V'`; `fmtTemp(c)` → `1dp + ' °C'`;
  `fmtRh(h)` → `round + ' %rh'`; `fmtPressure(p)` → `1dp + ' hPa'`.
- `fmtClock(ts)` → `toLocaleTimeString` (chart axis/tooltip; `''` when no ts);
  `fmtDateTime(ts)` → `toLocaleString` (heartbeat-log timestamp).

`initStatusCharts` labels every dataset with `this.fmtClock(r.ts)` instead of
the raw epoch `r.ts`, so chart tooltips read as clock times, not `1784298962`.
The unused `persistSet` import is dropped. Chart series still return raw
numbers; formatting happens only at the display edge.
