---
module: signal-verdict
source: src/signal-verdict.js
source_hash: 7614629c2d55e8f899bf24190209f69265c84bf4b687952863ea86c294ff4d04
updated: 2026-08-04
---

# Module: signal-verdict

## Purpose

Turn a link-quality percentage into words. **Backend only.**

## Why it exists

`public/app-nodes.js` did this, applying thresholds and choosing CSS classes.
`BROWSER_CONTRACT` is explicit: *"if a display differs based on a condition, that
condition is evaluated in Node.js"*.

## The bug it exposed

The labels used `>=76 / 51 / 26`; the colour ramp beside them (`sigQualColor`)
used `>=75 / 50 / 25`. **A node at 75% read "Good" while painted the excellent
colour.** Two threshold sets, one screen, both live — the same failure as the
region-frequency table (B80), at smaller scale.

One set of bands now, here.

| pct | label | tone |
|---|---|---|
| ≥76 | Excellent | success |
| ≥51 | Good | success |
| ≥26 | Fair | warning |
| ≥0 | Poor | error |
| no reading | No signal | muted |

`tone` is a **semantic** name. Mapping it to CSS is the browser's job and stays
there; deciding what counts as "Good" is not.

## `none` is not zero

`none: true` means we have **no reading at all**, which must never render as
"Poor". A node with `rssi == null && snr == null` gets it.

## Applied

`ws-relay.js` `enrichEvent()` attaches `signal { pct, label, tone, none }` to
every node on `node_list` — the same single enrichment point that already
resolves labels, hops and the via-relay bundle.

## Verified

23 nodes, 22 with a verdict and 1 correctly `none`. Rendered labels match served
labels for **all 23, zero mismatches**. Thresholds `76/51/26` no longer appear
anywhere in `public/`.
