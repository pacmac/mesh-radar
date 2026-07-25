---
module: node-chart-readability
source: src/node-status.js
source_hash: d68af2c565bee1e6664012c564ecf53856e88057258d78eaf4637ce25f7f80d8
updated: 2026-07-24
---

# Node chart readability

## Purpose

Make node telemetry charts readable without hiding raw observations.

## Scope

- `src/node-status.js`: bucket history rows, emit smoothed series and min/max
  envelopes, and assign axes by compatible units.
- `public/app-node-status.js`: render the smoothed line and a subtle envelope.
- `docs/modules/node-status.md`: document the response additions.

## Contract

- The selected 1/4/24/72-hour window remains server-controlled.
- Each series is reduced to no more than 200 time buckets, with at least three
  adjacent samples combined whenever a series has more than three readings.
- The displayed line is the arithmetic mean of finite samples in each bucket.
- Each bucket may include `min` and `max` values for a low-contrast envelope.
- Different units never share an axis. Compatible percentage units may share one.
- Raw timestamps remain available in tooltips through the bucket timestamp.
- No browser-side smoothing, unit conversion, or window slicing is introduced.

## Explicit non-changes

- No ingestion/schema changes.
- No changes to telemetry persistence or sampling frequency.
- No changes to non-node charts.

## Validation

- Static: inspect emitted series for bucket, mean, min, and max fields.
- Functional: request node status over WebSocket for all supported windows.
- Regression: run the structured Playwright audit at desktop and iPhone sizes;
  verify no overflow, console errors, or blank charts.
