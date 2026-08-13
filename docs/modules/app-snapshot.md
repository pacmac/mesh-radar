---
module: app-snapshot
source: public/app-snapshot.js
source_hash: cf5d3c5c2c1a3d32358efd5c342d43ad1ccbadf0255dce2a80000e8d1a731586
updated: 2026-08-05
---

# Module: app-snapshot

## Purpose

Domain 2 mixin for the Snapshot board. Fetches and renders; derives nothing
(`BROWSER_CONTRACT`). Every figure, tone, ranking and reason is computed by
`snapshot-api`.

## Why this file exists

The window buttons shipped as static markup — a control that looked live and did
nothing, hours after the same defect was fixed on the callout transmit toggle.
Peter: *"the date range selector does not work. so much for your tests."* A dead
control is worse than no control, because it is trusted.

## One window, four bands

`loadSnapshot()` fetches `frontier`, `distribution`, `new-ground` and
`productivity` with the **same** `days`, plus `health` (which is not
window-scoped). The board previously mixed all-time, 30-day and today in one
view, which is how an all-time 189.1 km appeared under a 7D badge.

`snapWindowLabel` derives from the **served** `window_days`, not the local one, so
a caption cannot claim "24h" while the numbers are all-time.

## Failure is visible

On error every payload is set to `null` — a gap, never a stale number under a new
window — `snapError` is set, and the partial renders a banner with the reason and
a Retry. Before this, a dead backend showed `—` everywhere and was
indistinguishable from a quiet mesh.

## Null is not zero

`snapKm()` renders `—` for null. The cards render a served `reason` when a value
is null (`new_clusters`: "cluster anchors carry no creation timestamp"). Zero
means measured-and-none; null means cannot-measure. Rendering null as 0 is how
five hard-coded zeros survived review.

## Geometry only

`snapSparkPoints` maps the served daily series to an SVG polyline; it performs no
smoothing, no thresholds, no analysis. The previous chart was a hand-plotted
polyline that looked exactly like data.

## Test notes

`scripts/check_snapshot.mjs` — 54 assertions, 9 fields x 6 windows.
In-browser, before any binding change: every `[x-text]` in the panel renders
non-empty; vary the window and assert the render CHANGES (a value identical
across all six windows is not window-derived).
