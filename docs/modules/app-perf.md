---
module: app-perf
source: public/app-perf.js
source_hash: d81b1dae0fb302d42632a77d84c9bba6ead2a5391051511636360391991a95b3
updated: 2026-07-03
---

# Module: app-perf

## Purpose

Performance page mixin: per-device RF-chain tuning instrument. Headroom
(dB above the decode limit), trend, distance analysis, traceroute history
and the auto-traceroute scheduler — all scoped to ONE radio+coax+antenna
chain at a time, scored against that device's own EIRP/sensitivity.

## Design (task `perf-per-device`, approved 2026-07-02)

Peter: "I will change hardware, antenna, antenna location and I need to see
whether those changes are beneficial or not — an aggregate is completely
meaningless." Headroom is a property of one RF chain; every displayed number
must attribute to exactly one device.

### Attribution model (RF-honest)

- `marginTx` (= `snr_towards[0]`) measures the **dispatching** radio's TX
  chain; `snrRx` (= `snr_back[last]`) its RX chain. The device key for all
  performance math is therefore **`tx_device` — the dispatching radio**,
  stamped by `traceroute.js` from the pending dispatch at result time.
- `rx_device` (whichever radio's BLE event delivered the reply — can differ
  with colocated radios) is retained as a diagnostic only. Grouping by it
  would be physically wrong.
- Overheard traceroutes with no pending dispatch: `tx_device = NULL`,
  excluded from per-device stats (honestly unattributable).
- Historic rows: one-shot backfill of `tx_device` with the primary device
  (the only dispatcher that ever existed), guarded by config flag
  `migrations.traceroute_tx_device` so post-migration NULLs stay NULL.
- Rotator dispatches additionally stamp `rotator_az` (live azimuth at
  dispatch) — directional samples are azimuth-qualified from day one.

### Data contract (backend-scoped; UI never filters)

- DB: `traceroute_history` gains `tx_device TEXT`, `rotator_az REAL`
  (migration in db.js); insert via `nodeList.setTraceroute` passes both.
- REST: `GET /traceroute_history?device=!hex&limit=N` (traceroute-api) —
  the page loads scoped history from here; no device param = all (debug).
- Dispatch: `POST /:nodeId/traceroute` accepts optional `{ via: '!hex' }`
  body (default: primary) — this is what makes measuring a second radio
  possible at all. Auto-traceroute posts `via` = the page's device.
- WS: `route_discovered` events carry `tx_device` (+ `rotator_az`); the
  browser prepends only rows matching its subscribed device (scope check,
  not business filtering).

### Page (tab-perf.html / app-perf.js)

- Device selector pills (one per configured radio; default = primary;
  persisted as `perfDevice`). **No aggregate view.**
- All theory constants (EIRP, sensitivity, SNR limit, link budget) read the
  SELECTED device's antenna + lora config — decoupled from the drawer's
  `activeNodeId`.
- Stats/trend/charts/table compute over the scoped rows only.
- Rotator device selected → an AZ column appears in the history table and
  the header shows "directional — samples are azimuth-qualified"; samples
  remain in that device's trend (annotation policy, not gating).
- Auto Traceroute panel dispatches via the selected device.

## Files changed

Backend: `src/db.js` (schema + stmts), `src/traceroute.js` (stamp
tx_device/rotator_az), `src/node-list.js` (setTraceroute signature),
`src/traceroute-api.js` (via param + history endpoint), `src/ws-relay.js`
(route_discovered carries tx_device), `src/index.js` (one-shot backfill at
startup). Browser: `public/app-perf.js`, `public/app-ws.js`
(route_discovered scope check), `public/partials/tab-perf.html`,
`public/app.js` (perfDevice state).

NOT changed: headroom math (perfMargin/perfSnrGap/FSPL), chart rendering,
STYLE_GUIDE-compliant layout from perf-refactor.

## Failure awareness (task `perf-honesty`, step 2)

- `perfEnrich` short-circuits failure rows (`row.status && row.status !==
  'ok'`): returns `{ ...row, failed: true, route: [], direct: false,
  validTx: false, marginTx: null, snrTx: null, snrRx: null }` plus null
  distance fields — they render as em-dashes and are excluded from
  `perfValidRows` (and therefore all medians, charts and trend) via the
  existing `validTx` filter.
- `perfFailureEpoch` loaded once from `GET /config` key
  `perf.failure_epoch` during `initPerf`. Display arithmetic only — the
  browser makes no filtering decisions with it beyond honest labelling.
- `perfSuccessRate()` → `{ n, ok, rate }` over `perfHistory` rows with
  `ts >= perfFailureEpoch` (scoped rows already arrive per-device from the
  backend); returns `null` when the epoch is unknown or no post-epoch rows
  exist. Pre-epoch history MUST NOT be counted — those windows contain no
  failure rows and would fake a 100% rate.

## Test notes

Live: dispatch a traceroute via each radio (OMNI + YAGI) with `via`;
verify rows land with correct `tx_device` (and `rotator_az` for YAGI);
page pills switch scope — stats/table show only that device's rows; EIRP
changes when the selected device's antenna gain differs; auto-traceroute
posts via the selected device. Playwright both themes; 0 console errors.

## Identity Phase B — perf scope key is the BLE MAC

- `perfDev()` returns a MAC: persisted `perfDevice` validated against
  `d.addr`; a persisted legacy `!hex` value is converted once via the
  device list and re-persisted (shim). Fallback: the primary radio's addr,
  else the first device's addr.
- `perfDevCfg()` reads the device's antenna config from
  `_deviceConfigsByMac` (the backend's canonical MAC-keyed store) — the
  node_id-keyed `deviceConfigs` re-key is Phase C demolition material and
  perf no longer depends on it.
- History query `?device=`, lora-config fetch path, auto-traceroute `via`,
  and the `route_discovered` scope gate all carry the same MAC. The gate
  comparison in app-ws.js is unchanged code — both sides flipped together.

## Phase C1 — history is WS-only

`loadPerfHistory` and its `/config` epoch fetch are DELETED. History
arrives exclusively over WS: the `traceroute_history` replay on connect
(all-device rows + `failure_epoch`) fills `_trHistAll`; live
`route_discovered` / `traceroute_failed` events prepend. The page shows
`perfHistorySlice()` — the `tx_device === perfDev()` slice, capped 200 —
presentation scoping like the tilt/env slices. Device switches and tab
entry re-slice; no fetch. The REST GET is browser-blocked
(`WS_ONLY_ROUTES`). Remaining GET: `loadPerfLoraCfg` — page data, to be
WS-carried via device payload enrichment (next C step).
