# Node focus header — show all we have, reuse the signal bars

Backlog #10. Peter: *"we have the data why are you selectively choosing to hide
certain parts? and we already have code and frontend bars for signal quality.
use that"*.

Names `docs/STYLE_GUIDE.md` (§8.6). Companions: `BROWSER_CONTRACT.md`,
`NODE_STATUS_SPEC.md`.

## What was wrong

The header carried a hand-picked five — battery, voltage, uptime, RSSI, SNR
(`node-status.js:178-182`) — while the same `nodes` row also held
`channel_util` and `air_util_tx`, and the 260 cache held `boot`/`rst`. Those
were captured, charted, and then omitted from the one place you look first.

Two separate errors:

1. **Selective display.** Fields were chosen by "what counts as a node vital"
   rather than "what does someone looking at one radio need". Utilisation and
   airtime tell you whether the radio is drowning; boot count is what makes
   uptime interpretable. Withholding them was not a decision worth making.
2. **Reinventing signal.** The app already renders signal as bars
   (`app-components.js:56 sigBars`, `.sig-bars` in `style.css:817`, used by
   messages, devices and nodes). I planned bare `-30 dBm` text instead. The
   established component wins — STYLE_GUIDE §5 says choose the element by the
   shape of the data, and §9's tiebreak is to match the reference implementation.

## Header fields (all of them, when present)

| Field | Source | Role |
|---|---|---|
| Battery | `nodes.battery` | display value |
| Voltage | `nodes.voltage` | display value |
| Uptime | `nodes.uptime_seconds` | display value |
| **Boots** | 260 `type:debug` → `boot` | display value |
| **Chan util** | `nodes.channel_util` | display value |
| **Air util TX** | `nodes.air_util_tx` | display value |
| **Signal** | `nodes.rssi` + `nodes.snr` | **`.sig-bars` component** + `dBm / dB` |

Absent stays absent. `API.md` is explicit that `channel_utilization` is present
only when the device is awake and **absence is not zero** — so a missing value
omits the field and must never render as `0%`. Same existing rule, applied.

`rst` is not promoted: it is already in Diagnostics, and unlike `boot` it does
not change how uptime reads.

## Signal quality — reuse, computed server-side

`signalQuality(rssi, snr)` already lives in `src/utils.js` and is exported, so
**the server calls the same function the browser does** — one algorithm, no
second implementation to drift.

The server emits, alongside the raw values:

```js
signal: {
  rssi, snr,                 // raw
  text: "-30 dBm / 6.0 dB",  // ready to display
  pct: 78, label: "Excellent", cls: "text-success",
  bars: [true, true, true, false],   // which of the 4 bars are lit
}
```

The browser renders `.sig-bars` markup from `bars` and `cls`. It does not call
`signalQuality()`, does not compute thresholds, and does not decide bar heights
— that is iron rule 1, and it is the only reason this differs from how
`sigBars()` is invoked elsewhere in the app.

Tier thresholds (pct ≥76 Excellent, ≥51 Good, ≥26 Fair, else Poor) and the
`text-success`/`warning`/`error` mapping mirror `app-nodes.js:219-226` exactly
so the page looks identical to every other signal indicator.

## Files

| File | Change |
|---|---|
| `src/node-status.js` | header gains boots/chan util/air util; `signal` block via `signalQuality` |
| `public/partials/tab-node.html` | render the new fields; `.sig-bars` markup for signal |
| `docs/modules/node-status.md`, `app-node-status.md` | updated + rehashed |

`utils.js`, `app-components.js` and `style.css` are **not** modified — the
component is reused as-is.

## Invariants

- Every field the backend holds for the header is shown; none is withheld.
- An absent value omits its field — never `0`, never `n/a`.
- The browser computes no signal thresholds, percentages or bar heights.
- `.sig-bars` markup and classes match the existing component exactly.

## Done when

- Header shows battery, voltage, uptime, boots, chan util, air util TX, signal bars
- A node without 260 traffic shows no Boots field; a sleeping node shows no
  Chan util rather than 0%
- Signal bars are visually identical to the nodes/messages pages
- 1440×900, both themes, zero console errors
- `check_specs.py` green
