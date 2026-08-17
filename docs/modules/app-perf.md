---
module: app-perf
source: public/app-perf.js
source_hash: c4d246d0d314326bbf0deaa20ee07a040205bc10116bdd48a01760fced27550c
updated: 2026-08-14
---

# Module: app-perf

> **GUTTED 2026-08-17 — read `traceroute-removal-browser.md` first.**
>
> Peter: *"I want all traces of it removed, browser and backend. it will be
> re-designed with no fragments remaining."*
>
> Everything below describing a MEASUREMENT is history, not current behaviour.
> The success rate, headroom trend, headroom-vs-distance scatter, history table
> and auto-traceroute scheduler were all computed from `traceroute_history`
> rows, and node-dash no longer dispatches a traceroute. They are removed, not
> disabled.
>
> **What the module is now:** `perfBudget()`, `adoptPerfLoraCfg()`, `perfDev()`,
> `perfDevCfg()`, `perfSetDevice()`, `perfSignedDb()`. Radio scope, antenna
> chain, and the SERVED link budget — theory only.
>
> The 37,424 stored rows are kept. The attribution model below (`tx_device` is
> the dispatching radio, SNR already in dB with `null` for unmeasured hops) is
> preserved deliberately: it is what the replacement has to be correct against.

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
- Those SNR values arrive here **already in dB, with `null` for hops the
  firmware could not measure**. This mixin does not decode them. It used to —
  `_perfSnr()` was the only correct quarter-dB decoder of the three consumers
  (B72) — but decoding now happens once at the `app-ws.js` ingest boundary, so
  `_perfSnr` is gone. Re-introducing a `/4` here would double-decode. See
  `docs/modules/app-helpers.md`.
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

- Device selector pills (one per configured radio, the phantom `UNDEFINED`
  device filtered out; **default = the current tracer**, persisted as
  `perfDevice`). **No aggregate view.**
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

- `perfDev()` returns a MAC. An **explicit** persisted `perfDevice` (validated
  against `d.addr`) always wins — even an empty radio, so it can be targeted for
  auto-traceroute; a legacy `!hex` value is converted once via the device list
  and re-persisted (shim). With no explicit pick the default follows dispatch:
  the **current tracer** (the radio with `mode_role.tx`, backend-provided) when
  it has rows, else any radio that has traceroute rows, else the tracer even if
  empty, else the primary, else the first. This is what makes the page follow
  traceroute dispatch to the rotator instead of sitting on an empty primary view
  (task `perf-default-tracer`, 2026-07-09).
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

## Phase C2 — theory constants from WS

`loadPerfLoraCfg` (GET /:dev/config/lora) is DELETED; `adoptPerfLoraCfg()`
copies the selected device's `lora` off `availableDevices` (carried by
device_list). With C1+C2 the perf page performs ZERO GETs.

## Lazy tabs — chart teardown (task `lazy-tabs-xif`, 2026-07-09)

Tabs are lazy-mounted (`x-if` in index.html), so the perf tab's canvases are
destroyed on leave and re-created on return. `_charts` is `let` (not `const`)
so `destroyPerfCharts()` can reset it to `{}`; `app-nav.setNav` calls
`destroyPerfCharts()` when leaving perf, and `initPerfCharts()` (already wired
on enter) rebuilds them against the fresh canvases.


## The RF physics has left this mixin (2026-08-04)

Peter: *"the first thing I want to do is to bring us back into compliance with the
UI rules."*

`perfFreqMHz`, `perfRxSensitivityDbm`, `perfEirpDbm`, `perfFspl`,
`perfNoiseFloorDbm`, `perfSfSnrLimitDb`, `perfTheoChipSnr`, `perfMaxRangeKm`,
`perfSnrGap` and `perfMargin` are **deleted**, along with `REGION_FREQ_MHZ`,
`SF_SNR_LIMIT` and `RX_NOISE_FIGURE_DB`. The Friis equation, free-space path
loss, the thermal noise floor and EIRP now live in `src/link-budget.js`,
backend-only.

What the page reads instead:

| | field |
|---|---|
| per row | `margin_tx_db`, `gap_tx_db`, `theo_snr_db`, `metric_dist_km`, `valid_tx` |
| per radio | `link_budget { freq_mhz, sf_snr_limit_db, noise_floor_dbm, rx_sensitivity_dbm, eirp_dbm, max_range_km, reference_curve[] }` via `perfBudget()` |

**More correct, not merely moved.** The backend attributes each row to its own
`tx_device`; this mixin applied whichever radio was *selected* to every row, while
this very spec claimed `marginTx` "measures the DISPATCHING radio's TX chain".

`_perfScatterRefDatasets` no longer evaluates Friis 80 times — it **clips** the
served `reference_curve` to its axis, which is the only display decision left.

Verified after the strip: all five physics functions `undefined` on the mixin,
budget served (EIRP 39 dBm, sensitivity −130.02 dBm, range 392 km, 80 curve
points), and margins unchanged — `snrTx 5.75 → 23.25`, exactly as before.

**Nothing in `public/` may compute a link budget again.** One instance remains
elsewhere and is filed as B80: `app-range.js:93` still computes FSPL, with
`32.4` where `link-budget.js` uses `32.45`.


## Verdicts are served too (task `verdict-strings-to-backend`, 2026-08-04)

`confidence` (`low`/`medium`/`high`), `route_kind`, `dist_label` and `valid_tx`
are decided in `ws-relay.js` from the same `direct` / `validTx` facts and arrive
on the row. `perfEnrich` reads them.

`BROWSER_CONTRACT`: *"if a display differs based on a condition, that condition is
evaluated in Node.js"*. Whether a hop counts as `high` confidence is such a
condition.

Each read keeps a `??` fallback so a row predating the enrichment still renders
rather than going blank.

### Verified

497 rows served (confidence low 472 / medium 22 / high 3). On the page: 200 rows,
of which **190 are timeouts** that `perfEnrich` short-circuits by design — those
still agree with the served value — and **zero mismatches** across the 10 real
rows. Headroom renders +16.1 dB, 0 console errors.

A first measurement reported 190 mismatches; the test was wrong, not the code. It
compared enriched output against served fields on failure rows, which never reach
that code path.

## Verdicts removed (task `strip-browser-verdicts`, 2026-08-04)

Every threshold that decided what a number MEANS is gone. What remains is
arithmetic over served values (medians, filtering on served `direct`/`valid_tx`)
and the tone→CSS map, which is this layer's job.

| was | now |
|---|---|
| `perfHealth` — 5 bands (20/10/3/0) → label, desc, 2 classes | `bandFor(margin, verdictBands.margin)` |
| `perfHealthBars` — bar count from 20/10/3/0, **colour from 10/0** | both from the one band |
| `perfConfidence` — 40/12 | `verdictBands.confidence` |
| `perfTrendDirection` — `\|d\|<1` | `verdictBands.trend_dead_band_db` |
| `tab-perf.html:42-43` — 90/60 | `perfSuccessRateClass()` |
| `tab-perf.html:85` — `delta >= 0` | `perfTrendChangeClass()` |

### One real behaviour change, and it is a fix

`tab-perf.html:85` coloured Recent Change on `delta >= 0`, while the badge
beside it used the 1 dB dead-band. **A change of +0.3 dB read "flat" on the
badge and green on the number.** Both now come from the one served rule, so a
sub-1 dB change is amber in both places.

`perfHealth`'s no-data class was `text-base-content/40` while `perfHealthBars`
used `/30`. Unified to `/30`.

### Verified in the browser

1600×1000, `business` and `corporate`, 0 console errors:
`perfScore 24.25 → Excellent / text-success / 4 bars`; success rate `8% →
text-error` (correct, <60); `+1.5 dB → BETTER`, confidence `low`;
traceroute table 201 rows with served HEALTH bars.
