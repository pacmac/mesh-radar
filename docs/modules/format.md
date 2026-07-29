---
module: format
source: src/format.js
source_hash: b2b92bfa7f5c834bb8a9ccca13e6a370bbc1ae9659e4b8af3c822c56ffdd2370
updated: 2026-07-29
---

# Module: format

## Purpose

Display formatting, single source of truth. NODE_STATUS_SPEC iron rule 1 puts
every conversion, rounding and formatting server-side, so the browser binds
`text` verbatim and every consumer (page, export, script) reads identical
strings.

## Responsibilities

- Format each unit the node focus page displays
- Return `null` for absent input, so callers omit the field

## Dependencies

- None. Pure functions, no I/O, no state.

## Public interface

```js
fmtVoltage(v)    // 4.296 → "4.30 V"
fmtPercent(p)    // 100   → "100%"
fmtUtil(p)       // 3.53  → "3.5%"
fmtTemp(c)       // 28.5  → "28.5 °C"
fmtHumidity(h)   // 38    → "38 %RH"
fmtPressure(hpa) // 1013  → "1013 hPa"
fmtGas(m)        // 12.4  → "12.4 MΩ"
fmtRssi(d)       // -85.4 → "-85 dBm"
fmtSnr(d)        // 7.53  → "7.5 dB"
fmtCount(c)      // 7     → "7"
fmtUptime(sec)   // 190000 → "2d 4h"   (largest two units only)
fmtTimestamp(ts) // → "2026-07-18 08:41:26"  (local, seconds precision)
fmtAgo(ts, now?) // → "3m ago"
```

## Invariants

- **Null/undefined in → null out.** Never the string "null", never "n/a", never
  a zero standing in for missing data. An absent value is absent; the caller
  drops the field rather than rendering a placeholder.
- **VALUES, NOT VERDICTS** (iron rule 2). Nothing here grades, judges or
  editorialises — no "healthy", no "battery low", no signal-quality bands.
  `utils.js signalQuality()` returns a judgement and is deliberately NOT used
  by the node-status path.
- `fmtUptime` shows the largest two units; the raw value always travels beside
  the text.
- `fmtAgo` is correct at emission only. The browser re-requests on
  `node_status_update` rather than ticking it locally — recomputing in the
  browser would be the browser deciding.

## Test notes

- Every formatter with `null`/`undefined`/`NaN` → `null`
- `fmtUptime`: 190000 → "2d 4h"; 4000 → "1h 6m"; 40 → "40s"; -1 → null
- `fmtVoltage(4.296702)` → "4.30 V" (2 dp, rounded not truncated)
- `fmtTimestamp(0)` → null (0 is not a valid observation time)
- `fmtUntil` (task `node-page-reachability`, 2026-07-29): future → `"in 4m 12s"`;
  past or now → `"overdue"`; null/0/negative → `null`. Verified live on the node
  page's Reachability section against pac-host's `nextWake` for GARG, counting
  down 55s → 36s across two renders.

### Why `fmtUntil` is a separate function and not a flag on `fmtAgo`

`fmtAgo` clamps with `Math.max(0, nowSec - ts)`, so **a future timestamp silently
returns `"0s ago"`** — not null, not an error. For pac-host's `nextWake` that
reads as *"the unit is awake right now"*, the exact opposite of the truth and
unfalsifiable from the page (bug ledger step 41). A flag would have let every
existing caller change meaning; all of them pass historical instants and want the
clamp, so the two cases are two functions.

`'overdue'`, never `'now'`, for a passed instant: the predicted window having
elapsed is a fact; the window being open is a claim we cannot make.

## Out of scope

- Deciding which fields to show — `node-status.js` owns section composition
- Any judgement of the values being formatted
