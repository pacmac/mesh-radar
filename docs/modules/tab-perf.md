---
module: tab-perf
source: public/partials/tab-perf.html
source_hash: 44537f2daccc51b82a7c33ab69d4ab3b8981754eeda693b5aaf13e1599a13ac4
updated: 2026-07-03
---

# Module: tab-perf

## Purpose

Performance page: setup-health stat grid (Simple/Expert), headroom trend and
distance charts, traceroute history table, auto-traceroute controls.
Presentation only.

## Scope

**STYLE_GUIDE.md compliance refactor (task `perf-refactor`).** Zero logic
changes. Files in scope: `public/partials/tab-perf.html` only.
NOT changed: `public/app-perf.js`, chart rendering, all other files.

## Changes

| Location | Before | After |
|---|---|---|
| Page title (l.6) | `text-base font-semibold` | page-title recipe `text-lg font-display font-bold tracking-wide` |
| Page subtitle (l.7) | `text-xs text-base-content/70` | `text-sm text-base-content/70` |
| Simple/Expert join (l.10–15) | `btn-xs` | `btn-sm` (page-header control) |
| Chart empty states (l.122, 149) | inline `style="font-family:monospace;font-size:0.75rem"` | `font-mono text-sm text-base-content/40` |
| History table (l.171) | inline `style="white-space:nowrap"` | `whitespace-nowrap` |
| ↺ Refresh (l.167) | `btn-xs` | `btn-sm` |
| Auto-traceroute interval + Start/Stop (l.228, 238) | `select-xs` / `btn-xs` | `select-sm` / `btn-sm` |
| Stat values ×3 (l.39, 47, 55, 87) | dead `text-lg` (component rule overrides) | removed |

Kept as-is (sanctioned): chart-window `btn-xs` joins and node-selection
`btn-xs` chips (dense repeating groups); table `table-xs`/`badge-xs`/mono
captions; chart-header subtitles at caption size under their titles.

## Invariants

Zero Alpine/logic changes; canvas refs and chart mount points untouched;
no inline styles remain.

## Test notes

Playwright both themes (guide §8): stat grid, charts render, history table
populated; data check — table rows match perfHistory state; 0 errors.

## Via column (task perf-honesty, step 1)

History table shows the first-hop node (short name or !id fallback) and its
distance — the hop the Headroom column actually measures. Direct rows show
an em-dash. Added after the distance-laundering finding: first-hop rows
displayed the far target distance while measuring the nearby relay.

## Success rate lead stat + failure rows (task perf-honesty, step 2)

- New FIRST stat in the grid: **Success Rate** — `perfSuccessRate()` as a
  percentage, desc "ok of n attempts". When no post-epoch attempts exist
  for the selected device it reads "n/a — no attempts since <epoch date>";
  it must never show 100% derived from pre-epoch (failure-blind) windows.
- History table renders failure rows (status ≠ 'ok'): row dimmed
  (`opacity-50`), Headroom cell shows an error badge (`TIMEOUT` /
  `SEND FAIL`), value cells fall through to their existing null renderings
  (em-dash). Failures are the point of the page — hiding them re-creates
  the survivorship bias this task exists to kill.
