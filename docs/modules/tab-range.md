---
module: tab-range
source: public/partials/tab-range.html
source_hash: c18fba074a308fdf5c109ed30ee37c8dc9699a513bc453fbf45914da931dea4c
updated: 2026-07-02
---

# Module: tab-range

## Purpose

Range Test page: RX/sender filters, TX-active strip, stats, polar
range-bearing and signal-by-bearing SVG charts, log table. Presentation only.

## Scope

**STYLE_GUIDE.md compliance refactor (task `range-refactor`).** Zero logic
changes.

Files in scope:
- `public/partials/tab-range.html` — presentation classes
- `public/style.css` — add `.rssi-scale` (chart color-scale legend, moved
  from a static inline gradient)
- `docs/modules/style-css.md` — hash update

NOT changed: `public/app-range.js`, all other files.

## Changes

| Location | Before | After |
|---|---|---|
| RX filter join, Refresh/CSV/Clear, Stop TX (l.9–41) | `btn-xs` | `btn-sm` (page-level control bar) |
| Sender filter select (l.20) | `select-xs` | `select-sm` |
| Chart titles ×2 (l.75, 100) | `text-xs font-semibold opacity-50 uppercase tracking-wide` | section-label recipe |
| Card title (l.134) | `card-title text-base` | `card-title` |
| Stat values ×5 (l.60–64) | dead `text-lg` | removed |
| RSSI scale bar (l.123) | static inline gradient style | `class="rssi-scale"` in style.css |

Kept as-is (sanctioned): SVG `font-size:10px/12px` chart internals (§2
exception, at the 10px floor); `table-xs` log table with mono `text-xs`
cells (dense rows).

## Invariants

Zero Alpine/logic changes; `rangeRingsSvg`/`rangePointsSvg`/`rangeArcsSvg`
mount points untouched; no non-SVG inline styles remain.

## Test notes

Playwright both themes (guide §8): control bar sm buttons, charts render,
log empty-state or rows, 0 errors.
