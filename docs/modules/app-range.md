---
module: app-range
source: public/app-range.js
source_hash: 0ae7e868292c9e5c0e68b38a115d1fb9878b30f20d8e84f506b86df2ff7af0bd
updated: 2026-08-04
---

# Module: app-range

## Purpose

Range-test page mixin: start/stop a test, render the received log, and draw the
polar plot. **Presentation only** — it renders values it is given.

Created 2026-08-04 during task `range-maths-audit`. The module had **no spec at
all**, which is why nothing flagged the RF derivation living in it:
`scripts/check_specs.py` validates the specs that exist and cannot see a module
that has none.

## Responsibilities

- Start / stop / clear a range test and render the countdown
- Filter the served log and render it
- Polar plot geometry — rings, points, arcs
- Aggregate stats over served values (median RSSI, excess loss, best SNR)
- CSV export

## What it must NOT do

**No RF derivation.** `rangeEnrich()` renders `dist_km`, `expected_rssi` and
`excess_loss_db` computed in `src/link-budget.js` and delivered by `ws-relay.js`.

Until 2026-08-04 it computed them itself, and held a **third** copy of the
region-frequency table after `src/link-budget.js` and the one deleted from
`app-perf.js`. The copies had drifted:

```
JP  920 vs 923      KR  920 vs 921      IN  865 vs 866
FSPL constant   32.4   vs   32.45
```

The same formula giving two answers, both live, in a project whose entire output
is a distance (B80). `_loraFreqMHz` is deleted and the maths with it — deleted
rather than reconciled, because reconciling leaves two copies that merely agree
today.

## What is legitimately here

- `_rssiColor` — a colour ramp over a served value
- `rangeRingsSvg` / `rangePointsSvg` / `rangeArcsSvg` — plot geometry
- `rangeFmtCountdown` — formatting
- `rangeStats` — median/best/worst over served fields

All display arithmetic: they map given numbers to screen, and decide nothing
about the mesh.

## Verified

After the strip: `_loraFreqMHz` undefined, 500 of 500 rows carrying
`expectedRssi`, stats unchanged — median RSSI −56, median excess loss 3, best SNR
7.5, 0 console errors.
