---
module: tab-node
source: public/partials/tab-node.html
source_hash: 01cf337ee391e6bd65ac4ef679f5be4d546608706da295ae2e7d06c686b9a049
updated: 2026-07-25
---

# Module: tab-node

## Purpose

Node focus page (`/node/:id`). Renders the ordered list of display-ready
sections built server-side by `node-status.js` — pure presentation, no
decisions. Works for any node, not a designated subset.

**Pre-existing spec gap**: this file predates the project's spec-index
convention and had no dedicated spec until task `node-signal-freeze`
(2026-07-25) touched it — `check_specs.py` only validates specs that exist,
so a module with none passes silently (see memory
`check-specs-cannot-detect-missing-specs`). This spec documents the file as
it stands today, not a historical record of every prior change.

## Dependencies

- `public/app-node-status.js` — Alpine state (`nodeStatus`, `nodeWindowHours`, `setNodeWindow`)
- `docs/BROWSER_CONTRACT.md`, `docs/STYLE_GUIDE.md` — both mandatory, both cited inline
- `src/node-status.js` — the sole source of every field/section rendered here (iron rule: presence, order, text, and provenance are server decisions; the browser tests nothing)

## Structure

1. Loading state (`!nodeStatus`) — spinner
2. Empty state (`nodeStatus.found === false`) — "UNKNOWN NODE" card, back-to-nodes button
3. Found state — header card + section cards:
   - **Header card**: identity line (long/short name, node_id, hw_model) + a
     `perf-stats-grid` of stat cards: Last heard, `header.fields[]` (Battery,
     Voltage, Uptime, Hops, Chan util, Air util TX — whichever are present),
     Signal, Position (lat/lon, if present).
   - **Signal stat card**: `.sig-bars` component (bars/cls server-computed),
     `rssi_text` headline, desc line = `label` (Excellent/Good/Fair/Poor) +
     optional `snr_text` + optional `desc` (staleness provenance, see
     Invariants).
   - **Section cards**: one per `nodeStatus.sections[]` entry, `kind` one of
     `value_grid` (key-value rows), `series` (chart + window selector +
     axis endpoints), `event_log` (scrollable list). Two-per-row on `lg+`
     for `series`, full width otherwise.

## Invariants

- Every text value is bound verbatim from the server's `text` field — no
  unit strings, no rounding, no date math, nothing here tests whether a
  section has content (BROWSER_CONTRACT iron rule 1).
- `stat-desc` carries provenance whenever a value has more than one possible
  source or a staleness risk — e.g. Hops shows "verified {ts}" vs "reported
  — not verified" (`node-status.js` `hopsField`); Signal shows "direct
  {age}" (task `node-signal-freeze`, 2026-07-25) so a frozen direct-only
  RSSI/SNR reading is never mistaken for a live current one once a node
  goes relay-only — see `docs/modules/node-status.md` and `docs/modules/db.md`
  for the write-path/query side of this fix.
- `flex-1 min-h-0 overflow-y-auto` on the root: the parent is a flex column
  with `overflow-hidden`; without `min-h-0` this content clips instead of
  scrolling and lower sections become unreachable.
- Window selector (`1/4/24/72 HR`) is user input only — the server slices
  history and computes axis labels for the selected window; the browser
  never re-filters cached points.

## Test notes

- Verified live 2026-07-25 (task `node-signal-freeze`): Signal stat card
  now shows a third desc segment ("direct Xs/m/h/d ago") sourced from
  `signal_history`'s most recent row for the node, alongside the existing
  label/SNR text.

## Out of scope

- Section content decisions (which sections exist, in what order) — entirely `node-status.js`
- Chart rendering internals — `public/app-node-status.js` / `app-perf.js` chart helpers
