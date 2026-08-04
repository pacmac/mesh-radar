---
module: signal-verdict
source: src/signal-verdict.js
source_hash: a566f0e5b1edff53701a13a845b331e27c860143ab233e0999caefa62f29a4e3
updated: 2026-08-04
---

# Module: signal-verdict

## Purpose

Turn link measurements into words and semantic tones. **Backend only.**

This is the SSOT for every judgement about *how good a link is*. It holds no CSS,
no markup and no rendering — it emits `label` / `tone` / `desc` / `bars`, and the
browser maps those to classes.

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

---

## This change — the same defect, four more times

The RF *maths* moved server-side in `perf-maths-to-backend` (`src/link-budget.js`),
and `src/ws-relay.js:102` now serves `margin_tx_db`. The *verdicts drawn from that
number* stayed in the browser. So the browser receives a correct measurement and
then decides what it means, which is the violation — not a leftover.

Verified in the files 2026-08-04:

| site | decides |
|---|---|
| `app-perf.js:308-315` | margin ≥20/10/3/0 → label + desc + 2 CSS classes |
| `app-perf.js:333-344` | margin → bar count (4 bands) **and** colour (2 bands) |
| `app-perf.js:357-363` | sample count ≥40/12 → high / medium / low |
| `app-perf.js:373-386` | \|delta\|<1 → flat, else better / worse |
| `app-components.js:43-45` | hops 0/1/2 → colour |

### The same two-threshold-sets bug, live again

`perfHealthBars()` picks **bar count** from `20/10/3/0` and **colour** from
`10/0`. Two band tables inside one widget. Under a single table the colour
follows the band's tone, and that is behaviour-preserving — checked at every
boundary:

| margin | old colour | new tone | same? |
|---|---|---|---|
| 25 | success (≥10) | Excellent → success | yes |
| 15 | success (≥10) | Good → success | yes |
| 5 | warning (≥0) | Usable → warning | yes |
| 1 | warning (≥0) | Fragile → warning | yes |
| −1 | error | Failing → error | yes |

So this change must produce **no visible difference**. That is the Phase 4 test.

## Public interface

### `signalVerdict(pct, { hasReading = true })` — unchanged

Returns `{ pct, label, tone, none }`.

### `marginHealth(marginDb)` — NEW

Link-budget headroom in dB → verdict. Replaces `perfHealth()` +
`perfHealthBars()`'s band logic.

| margin dB | label | desc | tone | bars |
|---|---|---|---|---|
| ≥20 | Excellent | Plenty of signal headroom | success | 4 |
| ≥10 | Good | Comfortable margin | success | 3 |
| ≥3 | Usable | Works, but not much spare margin | warning | 2 |
| ≥0 | Fragile | Close to the decode limit | warning | 1 |
| <0 | Failing | Below the reliable decode limit | error | 0 |
| null | No data | Need valid traceroute samples | muted | 0 |

Returns `{ label, desc, tone, bars, none }`. `bars` is a **count 0–4**, not
markup — the browser draws them.

### `sampleConfidence(n)` — NEW

How much the sample count is worth. Replaces `perfConfidence()`.

| n | level |
|---|---|
| ≥40 | high |
| ≥12 | medium |
| >0 | low |
| 0 / null | none |

Returns `{ level, n }`.

### `trendVerdict(deltaDb)` — NEW

Change in median margin between the first and last trend bucket. Replaces
`perfTrendChangeLabel()` + `perfTrendDirection()`.

| delta | direction | label | tone |
|---|---|---|---|
| null | baseline | No baseline yet | muted |
| \|d\| < 1 | flat | `+0.4 dB · little change` | warning |
| > 0 | better | `+2.3 dB · better` | success |
| < 0 | worse | `−2.3 dB · worse` | error |

Returns `{ direction, label, tone, delta }`. The **1 dB dead-band** is the
existing browser rule, preserved: a change under 1 dB is noise, not a trend.

### `hopsTone(hops)` — NEW

| hops | tone |
|---|---|
| 0 | success |
| 1 | info |
| 2 | warning |
| ≥3 | error |
| null | muted |

Returns a tone string. `hopsBadge()`'s *text* (`Direct` / `n hops`, verified /
reported suffix) is display composition and stays in the browser; only the
0/1/2 threshold moves.

## What is NOT in this module, and why

**Answer-rate tone** (`app-observatory.js:300,307`, `≥15/≥5` → colour) is a
judgement about *discovery yield*, not about a link. Putting it here would make
the module a dumping ground for every band table in the app. It goes in
`observatory-ws.js` beside the chart builder that is its only consumer — one
owner each, which is what SSOT actually requires.

**BLE `signal_pct` tone** (`app-components.js:80`) is a *BLE* link percentage
from the gateway, not a LoRa RF measurement, and shares no bands with
`signalVerdict` (`50/25` vs `76/51/26`). It is served from `ws-relay.js`'s
device-state flatten as `signal_pct_tone` using its own two-band rule, and is
documented in `ws-relay.md`.

## Applied — the three emit points

All in `src/ws-relay.js`:

1. `enrichEvent()` node path (line ~449) — already attaches `signal`; gains
   `hops_tone`.
2. `buildMessageFeedRows()` — message rows gain `hops_tone` (`tab-messages.html:132`
   calls `hopsBadge(m.hops)`).
3. device-state flatten (line ~600) — gains `signal_pct_tone`.

Perf rows are enriched where `margin_tx_db` is already computed (line ~102),
gaining `health { label, desc, tone, bars, none }`.

## Invariants

- No CSS class, colour literal or HTML string in this module. `tone` only.
- A band table appears **once**. If a second site needs the same judgement it
  imports it; it does not restate the numbers.
- `bars` is a count. The module never emits markup.
- `none`/`muted` is distinct from the worst band, everywhere. No data is not
  bad data.

## Test notes

- Boundary values for every band: `marginHealth` at 20 / 19.9 / 10 / 9.9 / 3 /
  2.9 / 0 / −0.1 / null.
- `trendVerdict` at exactly ±1.0 (flat is `< 1`, so ±1.0 is better/worse).
- Behaviour-preservation: the old browser colour rule and the new tone must
  agree at every boundary in the table above.

## Out of scope

- Deleting the browser-side thresholds. That is Domain 2 and a separate task —
  CLAUDE.md forbids one task spanning domains. Until it lands, the browser
  ignores these fields and its own thresholds remain live; behaviour is
  unchanged either way, which is why the split is safe.
- The answer-rate and BLE tones' *implementations* (see above) — specified in
  `observatory-ws.md` and `ws-relay.md`.

## Verified

**Behaviour preservation — the test that matters.** The old browser rules were
transcribed verbatim and run against the new functions at every band boundary,
including `±0.999` / `±1.0` for the trend dead-band:

```
behaviour preserved: 67/67 identical to the old browser rules
```

Nothing on screen may move when Domain 2 switches to the served fields. If it
does, a band is wrong.

**Served live** (service restarted 2026-08-04 09:10, WS `/events`):

| feed | evidence |
|---|---|
| `device_list` | `pct=98 → success`, `pct=64 → success` |
| `node_list` | `hops 3 → error`, `1 → info`, `4 → error` |
| `message_history` | `6 → error`, `3 → error`, `0 → success` |
| `traceroute_history` | `24.25 → Excellent/success/4`, `19.75 → Good/success/3`, `5.75 → Usable/warning/2`, `null → No data/muted/0/none` |
| observatory `charts` | silence `direct RF 9%/warning … silent 7d+ 0.7%/error`; distance `0 18.8%/success … 150 0%/error` |

**Domain separation:** `git status public/` empty — no browser file touched.

---

## Serving the band tables (task `serve-verdict-bands`, 2026-08-04)

Starting the Domain 2 deletion exposed a gap the per-row `health` field does not
close.

`public/app-perf.js:276-296` computes the page's headline figures **client-side**:
`perfSummary()` runs `_perfMedian()` over the served rows, filtered by the radio
and kind the user has selected in the browser, and `perfScore()` is the median of
those. That median exists **only in the browser** — there is no row to carry a
served verdict for it, so deleting `perfHealth()` would leave the lead statistic
with no band at all.

### Why the median may stay in the browser

A median is **arithmetic over served values**, not a decision. It introduces no
threshold and no judgement — the same class as the auto-range computation
`docs/modules/app-radar.md` already sanctions. The filtering it does reads
**served** `direct` / `valid_tx` / `route_kind`; the browser does not decide what
"direct" means.

What the browser may not do is decide that 12 dB is "Good". That is the
threshold, and thresholds are what has to leave.

### The fix, and its precedent

`verdictBands()` serves the band table itself. The browser performs a mechanical
lookup — *first band whose `min` I am at or above* — and holds no numbers.

`docs/SPLIT_READINESS.md` §4 recommends exactly this shape for the radar scale:

> the backend emit the control points and the browser interpolate — small
> change, removes the ambiguity.

The server owns where the lines fall; the browser owns pixels.

### The event

`verdict_bands`, sent once on connect beside `traceroute_history` — static
config, not live state:

```jsonc
{ "type": "verdict_bands",
  "margin":      [ { "min": 20, "label": "Excellent", "desc": "…", "tone": "success", "bars": 4 }, … ],
  "margin_none": { "label": "No data", "tone": "muted", "bars": 0, "none": true },
  "confidence":  [ { "min": 40, "level": "high" }, … ],
  "trend_dead_band_db": 1 }
```

**`min: null` is the catch-all band.** `-Infinity` does not survive
`JSON.stringify` — it serialises as `null` — so the sentinel is explicit rather
than accidental, and the browser treats `min == null` as "always matches".

### The drift risk this creates, and how it is closed

A served table and `marginHealth()` could disagree. They cannot here: **both read
the same exported constants** — `MARGIN_BANDS`, `CONFIDENCE_BANDS`,
`TREND_DEAD_BAND_DB`. The functions use them, `verdictBands()` serialises them,
and there is no second copy to fall out of step.

Re-introducing a second copy while fixing the `76/51/26`-vs-`75/50/25` defect
would have been absurd, so the constants are the SSOT and the wire format is a
projection of them.

### Verified

The served table, applied by the browser's lookup rule, reproduces
`marginHealth()` / `sampleConfidence()` / `trendVerdict()` at every boundary
including the nulls and the ±1.0 trend edge:

```
served table reproduces the server: 54/54
catch-all band min -> null (must be null, not -Infinity)
```

Live on WS `/events` after restart: 5 margin bands, `margin_none` No data/muted,
confidence `40→high 12→medium 1→low 0→none`, `trend_dead_band_db: 1`.
