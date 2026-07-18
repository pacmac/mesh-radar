---
module: format
source: src/format.js
source_hash: fda551dca616e3c24813c85b7ac9f43eb3e4aac19a05c3dc09193423e321a1ab
updated: 2026-07-18
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

## Out of scope

- Deciding which fields to show — `node-status.js` owns section composition
- Any judgement of the values being formatted
