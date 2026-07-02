---
module: tab-perf
source: public/partials/tab-perf.html
source_hash: a4b980b25625c82f7ae58a4ff16669cc3d7235887b4c2a011826a15590be91bb
updated: 2026-07-02
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
