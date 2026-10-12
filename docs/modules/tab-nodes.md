---
module: tab-nodes
source: public/partials/tab-nodes.html
source_hash: f6eed3b0b27f38628c827505596f37ce6acd430239949935d9d0afb271771c01
updated: 2026-10-11
---

# Module: tab-nodes

## Purpose

Nodes page HTML template: NodeDB card grid grouped by freshness, sort
selector, filters dropdown. Presentation only.

## Scope

**STYLE_GUIDE.md compliance refactor (task `nodes-refactor`).** Zero logic
changes.

Files in scope:
- `public/partials/tab-nodes.html` — presentation classes only

Files explicitly NOT changed:
- `public/app-nodes.js` — grouping/sort/filter logic untouched
- All other partials and JS

## Changes

| Location | Before | After |
|---|---|---|
| Filters dropdown panel (l.26) | inline `style="background:var(--fallback-b2,…);border:…;min-width:14rem;margin-top:0.25rem"` | `bg-base-200 border border-base-content/15 min-w-56 mt-1` |
| Role sub-dropdown (l.89) | inline `style="margin-left:0.25rem"` | `ml-1` |
| New-node star (l.126–127) | `text-yellow-400` + inline `font-size:0.7rem;transform:translate(30%,30%)` | `text-warning text-xs translate-x-[30%] translate-y-[30%]` |
| Last-heard age (l.133) | `text-[10px]` | `text-xs` (caption role; freshness color ternary unchanged) |
| Group headers (l.112) | `text-xs font-bold uppercase tracking-wide text-base-content/60` | section-label recipe: `text-xs font-display font-semibold uppercase tracking-wider text-base-content/50` |
| "Source" eyebrow (l.29) | `text-xs opacity-60 font-semibold uppercase tracking-wide` | section-label recipe |
| Filter row labels + checkbox labels (l.39–81) | `text-xs` | `text-sm` (body role, matches overview filter dropdown) |
| Filters summary button (l.20) | `btn-xs` | `btn-sm` (page-header action) |
| Sort select (l.10) | `select-xs` | `select-sm` (page-header control) |

Kept as-is (sanctioned):
- Source join `btn-xs`, role sub-dropdown `btn-xs`, "Reset all" `btn-xs`,
  filter `select-xs`/`checkbox-xs` — dense controls inside a fixed-width
  dropdown (guide §5 dense context)
- Device badge `:style` color (l.148) — runtime-computed from data (§7)
- `badge-xs` on card meta badges — dense repeating rows
- "of N" counter `text-xs opacity-50` — caption

## Two icons on a node card, and they mean different things

The gold **star** pins a node to the sidebar and exempts it from every filter.
The **crosshair** beside it marks the node as a discovery target — it spends
airtime. Different icon, different colour, different tooltip, and they are never
merged (`docs/DISCOVERY_TARGETING.md`).

## Invariants

- Zero changes to Alpine expressions and handlers
- No raw palette colors (text-yellow-400 removed), no static inline styles
- Card grid, grouping, and openNodeInfo click behavior identical

## Source filter renders one button per live device — 2026-10-11

Peter: *"nobody ever said there would be 1,2,3 or any number of radios or
that any of them would be directional with a rotator."* idiot entry
`node-source-filter-hardcodes-omni-yagi-browser` (Domain 2 half; Domain 1 —
`node_filters.node_source` becoming `'all'`/a device MAC — is
`docs/modules/node-filter.md`).

The Source row used to be 3 static buttons: `Both`/`YAGI`/`OMNI`, calling
`setNodeSource('both'|'yagi'|'omni')` — wrong words on any deployment without
exactly this dev box's 2 named radios (confirmed wrong on a Pi deployment:
1 radio, no rotator at all).

Now: an `All` button plus `<template x-for="dev in availableDevices...">`,
one button per device the browser actually knows about (the live
`device_list` WS payload), labelled `deviceConfigs[dev.node_id]?.label ||
deviceLabel(dev.addr) || dev.addr.slice(-5)` — the exact same label
resolution already used identically for the per-node device badges just
below in this same template. Zero new logic: this reads what the backend
already serves and renders it, same as everything else here.

On THIS dev box the two live radios are genuinely labelled YAGI/OMNI in
their own config, so the buttons still read "YAGI"/"OMNI" — correctly,
because that is what `deviceLabel()` resolves to here, not because the
template says so. `tests/test_node_source_buttons_dynamic.mjs` asserts the
TEMPLATE carries no hardcoded YAGI/OMNI text or `setNodeSource('yagi'|'omni')`
call; a live Playwright pass (both themes, 1600×1000 and 1280×800) confirmed
button count = live device count + 1, no dropdown-panel cropping, and
clicking a device button filters the list correctly.

## Test notes

Playwright, both themes, 1440×900 (guide §8):
- Grid renders grouped with section-label headers; filters dropdown opens
  with legible labels; sort select works
- **Data verification**: fetch `/nodes` (Accept: application/json), compare
  N sample rendered cards against backend values — name, node count badge,
  distance badge vs position, hops badge, device source badges
- 0 console errors
- Hops badge: `hopsBadge(nodeHops(n), nodeHopsIsVerified(n), nodeHopsFresh(n))`
  — arg 2 adds a dot on the badge's outer ring when traceroute-verified
  (`n.hops_verified != null`); arg 3 colours it green when fresh / amber when
  stale (`n.hops_fresh`). Value, provenance and freshness are all
  backend-decided (`hops_display`/`hops_verified`/`hops_fresh`); the UI renders.
