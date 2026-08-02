---
module: tab-nodes
source: public/partials/tab-nodes.html
source_hash: 90d32ed8f89ac39dc97802da11dba0018252c826481c96eb41ba1d8419b08e3c
updated: 2026-07-08
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
