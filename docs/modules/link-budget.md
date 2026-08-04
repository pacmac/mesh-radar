---
module: link-budget
source: src/link-budget.js
source_hash: 8fa86a47cba51802c6b6a496fea99fb0ebf7423557c7d230c2ae01bb16f012a0
updated: 2026-08-04
---

# Module: link-budget

## Purpose

LoRa RF physics — Friis sensitivity, free-space path loss, thermal noise floor,
EIRP, theoretical SNR, margin and excess path loss. **Backend only.**

## Why it exists

All of this ran in `public/app-perf.js`. Peter, 2026-08-04: *"the first thing I
want to do is to bring us back into compliance with the UI rules."* `CLAUDE.md`
Domain 2 — the browser *"owns rendering and user interaction only"* and *"makes
zero decisions"*. A path-loss exponent is not a rendering decision.

Its own module rather than folded into core, for the same reason as `src/snr.js`:
`src/utils.js` is served to the browser verbatim as `GET /utils.js`, so anything
placed there ships straight back into the layer this is leaving.

## Public interface

| function | returns |
|---|---|
| `noiseFloorDbm(lora)` | kTB + NF — the reference the chip's own SNR is measured against |
| `rxSensitivityDbm(lora)` | Friis: noise floor + SF limit, +1.5 dB if boosted gain |
| `eirpDbm(lora, devCfg)` | tx power + antenna gain − cable loss |
| `fsplDb(distKm, mhz)` | free-space path loss |
| `theoreticalSnrDb(distKm, lora, devCfg)` | EIRP − FSPL − noise floor |
| `maxRangeKm(lora, devCfg, n=3)` | inverted log-distance budget |
| `marginDb(snrDb, lora)` | headroom above the demodulation floor |
| `snrGapDb(snrDb, distKm, lora, devCfg)` | excess path loss over free space |
| `budget(lora, devCfg)` | the whole per-radio theory as one object |

Constants — `REGION_FREQ_MHZ`, `SF_SNR_LIMIT`, `RX_NOISE_FIGURE_DB` (6 dB),
`BOOST_GAIN_DB` (1.5), `KT_DBM_HZ` (−174) — are properties of the chip and the
band, not of any install, and are no longer duplicated in the browser.

## Applied per ROW, against the radio that sent it

`ws-relay.js` `withLinkBudget()` enriches every traceroute row with `snr_tx_db`,
`snr_rx_db`, `margin_tx_db`, `gap_tx_db`, `theo_snr_db`, `metric_dist_km` and
`valid_tx`, attributed to that row's **own `tx_device`**.

That is a correctness gain, not just a relocation. The browser applied whichever
radio the user had *selected* to every row; `docs/modules/app-perf.md` already
states that `marginTx` *"measures the DISPATCHING radio's TX chain"* — now it
actually does.

`device_list` additionally carries `link_budget` per radio for the theory panel.

## Distance comes from the STORE

The first implementation read positions from `nodeList._cache`, which is a display
projection and returned entries without `lat` — every distance came back null and
`valid_tx` was false for all 500 rows. It now queries `nodes` directly.

## Verified

Parity against the values the browser produced before removal:

```
snr_tx 5.75  -> margin 23.25, gap 41.54, dist 5.3 km    (browser: margin 23.25)
snr_tx -17   -> margin  0.50, gap 68.94, dist 3.1 km    (browser: margin  0.50)
24 of 25 rows carrying an SNR reading are valid_tx
```

Per-radio budgets served: EIRP 36/39 dBm, sensitivity −130.02 dBm, max range
311/392 km for the two radios.

## Out of scope

- Anything the radio reports directly (`rx_snr`, `rx_rssi`) — already dB
- Quarter-dB decoding — `src/snr.js`


## `referenceCurve()` — the theory lines, served as points

The perf page draws "ideal (free space)" and "rural" reference lines against its
scatter. It built them by calling `perfTheoChipSnr(km)` in a loop — 80 evaluations
of Friis in the browser.

The **shape is physics**; only the x-range the page chooses to show is display. So
the curve is served over a generous fixed domain (250 km, 80 points) as
`{km, ideal_db, rural_db}` and the browser clips it to whatever axis it is
drawing. `rural_db` applies the usual `10·log10(km)` excess over free space.

It rides on `link_budget`, so a page that has the budget already has the lines.


## `expectedRssiDbm()` / `excessLossDb()` — the range-test derivation

The range-test page computed its own expected RSSI: FSPL, both ends' EIRP, and
the excess over free space (B80). It is served now.

`expectedRssiDbm(distKm, region, txCfg, rxCfg)` takes the region from the
**receiving** radio, as the page did, and defaults tx power 22 dBm / gain 2 dBi
where a device config is absent — preserving the page's prior behaviour rather
than silently changing numbers during a move.

Verified: 500 of 500 range rows served with `dist_km`, `expected_rssi` and
`excess_loss_db`; `-50 dBm actual` against `-53 expected` at 0.43 km reads as
`-3` excess.
