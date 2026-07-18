# Node focus charts — dual Y axis + single-series hover

Backlog #11. Peter: *"the env graph is broken. it needs 2 Y Axis you cannot
combine pressure and temp / humid on same scale. and why when I hover over a
line do I get 3 or 4 stats on the same line hovered?"*

Names `docs/STYLE_GUIDE.md` (§8.6). Companion: `BROWSER_CONTRACT.md`.

## 1. One Y axis for incompatible magnitudes

Measured on live data (24 HR window):

| Chart | Series | min | max |
|---|---|---|---|
| environment | Temperature °C | 26.0 | 26.7 |
| environment | Humidity %RH | 38.5 | 42.0 |
| environment | **Pressure hPa** | **1017.4** | **1017.6** |
| device_vitals | **Voltage V** | **4.1** | **4.3** |
| device_vitals | Battery % | 85.0 | 100.0 |
| device_vitals | Channel util % | 11.8 | 46.5 |
| device_vitals | Air util TX % | 2.4 | 28.0 |

Pressure is ~25× temperature, so temp and humidity collapse onto the baseline.
The identical fault hits `device_vitals` from the other direction: voltage is
~25× smaller than battery, so voltage is a flat line. **Both charts are
affected** — this is not environment-specific.

## 2. Hover reports every series

`app-node-status.js` sets `interaction: { mode: 'nearest', intersect: false }`
with no `axis` constraint, so proximity is judged on **x only** — every series
has a point at that x, so all of them tie and the tooltip lists all four.

## The fix

### Axis assignment is a decision → the server makes it

Per iron rule 1, which axis a series belongs on is a presentation decision and
belongs server-side. `buildSeriesSection` assigns each series `axis: 'y' | 'y1'`
and emits a label per axis.

Algorithm (deterministic, no hardcoded unit list — a new metric is handled
without a code change):

1. Take each series' max absolute value.
2. Sort ascending; find the largest ratio between consecutive maxes.
3. If that ratio **≥ 10**, split there; otherwise every series stays on `y`.
4. The group with **more series** takes the left axis `y`; the smaller group
   takes the right axis `y1`. Ties go to the larger-magnitude group on the left.

Applied to live data:
- environment → temp + humidity on `y`, **pressure on `y1`**
- device_vitals → battery + chan util + air util on `y`, **voltage on `y1`**

Each axis carries a `label` built from the units it holds (`"°C · %RH"`,
`"hPa"`), so the reader can tell which scale is which.

### Hover

`interaction: { mode: 'nearest', axis: 'xy', intersect: false }` — nearest point
in **two** dimensions, so hovering a line reports **that line only**. The
tooltip inherits it.

Tooltip labels show the series name and its already-formatted value; the title
stays suppressed (no browser date formatting — the axis carries time).

## Files

| File | Change |
|---|---|
| `src/node-status.js` | `buildSeriesSection` assigns `axis` per series; emits `axes: {y:{label}, y1:{label}\|null}` |
| `public/app-node-status.js` | build `y` and `y1` scales from `axes`; map each dataset to `yAxisID`; fix `interaction` |
| `docs/modules/node-status.md`, `app-node-status.md` | updated + rehashed |

## Invariants

- The browser assigns no axis and computes no scale — it renders `axis` as given.
- `y1` is only created when the server actually sends a `y1` group; a
  single-magnitude chart keeps one axis and no empty right-hand gutter.
- Hovering reports exactly one series.
- No `px` sizes, no raw colours (STYLE_GUIDE §2/§4) — axis colours keep coming
  from the theme's `--bc`.

## Done when

- Pressure reads on its own right-hand axis while temp/humidity use the left,
  all three legible
- Voltage likewise on `device_vitals`
- Hover over any line reports that line only
- 1440×900, both themes, zero console errors
- `check_specs.py` green
