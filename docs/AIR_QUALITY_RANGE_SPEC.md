# Air quality % — normalise across the observed range

Backlog #15. Peter: *"we can measure the lowest point cant we and use that as a
ref!"* — correct. The current code uses only the observed maximum as a ceiling,
so everything reads near 100%.

Names `docs/STYLE_GUIDE.md` (§8.6).

## What the live data showed (Phase 1)

```
13:56  DEV1  0.054594      ← oldest
14:01  DEV1  0.055724
14:06  DEV1  0.056747
14:11  DEV1  0.057970
14:16  DEV1  0.059584
14:17  esp3  1115.736800   ← different node, ~20,000x scale
14:21  DEV1  0.060623
14:26  DEV1  0.061928      ← newest
```

Two things this proves:

1. **Devices disagree on scale.** `esp3` reports 1115 MΩ where DEV1 reports
   0.055. Per-node scoping (already in `queryGasBaseline`) is essential, and raw
   min/max is fragile — one sample can define the entire range.
2. **DEV1 is in burn-in.** The readings rise monotonically: 0.0546 → 0.0619 over
   30 minutes. That is the BME680 heater stabilising, not air improving. Naive
   min–max would render warm-up drift as air quality climbing 0% → 100%, which
   is actively misleading — worse than showing nothing.

## The change

Normalise across the observed range, per node, over the trailing 7 days, using
**percentiles rather than raw extremes**:

```
floor   = 5th percentile      (dirtiest air seen, outliers excluded)
ceiling = 95th percentile     (cleanest air seen, outliers excluded)
pct     = clamp(100 * (v - floor) / (ceiling - floor), 0, 100)
```

Percentiles, not `MIN()`/`MAX()`, because a single spurious reading — an `esp3`
at 1115, or a cold-start artefact — would otherwise flatten every real reading
to 0%.

Gates kept and made explicit:
- `samples >= 12`, else no percentage is quoted at all
- `ceiling > floor`, else no percentage (a flat range cannot be normalised)

**The note prints the actual reference range**, e.g.
`0% = 0.055 MΩ · 100% = 0.062 MΩ (this node, last 7 days, 24 samples)`.
That is what makes a narrow range honest rather than hidden: a reader can see
the scale spans 7 thousandths of a megaohm and judge the percentage accordingly.

## Files

| File | Change |
|---|---|
| `src/db.js` | `queryGasBaseline` → returns the node's ordered gas values for percentile computation |
| `src/node-status.js` | percentile floor/ceiling; normalise across the range; note names both ends |
| `docs/modules/db.md`, `node-status.md` | updated + rehashed |

## NOT changed

- Per-node scoping — already correct, and the `esp3` reading proves why.
- The raw MΩ series — stays on the second axis, so the underlying value is never
  hidden behind a derived percentage.
- Warm-up drift is **not** filtered out. Detecting burn-in reliably needs
  device-side state we do not have, and silently discarding early readings would
  be node-dash editorialising device data (iron rule 2). The printed range makes
  the effect visible instead.

## Invariants

- Percentages are per node; no cross-node scale is ever assumed.
- A single outlier cannot define the scale.
- Below the sample gate, or with a flat range, no percentage is shown at all.
- The reference range is always printed alongside the percentage.

## Done when

- The percentage spans the observed range instead of pinning near 100%
- A synthetic outlier does not collapse the scale
- The note names both ends of the range in MΩ
- `check_specs.py` green
