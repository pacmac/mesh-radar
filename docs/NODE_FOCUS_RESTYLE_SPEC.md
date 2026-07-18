# Node focus page — style-guide compliance + chart fix

Backlog #7. Fixes the page shipped in `ed7f5a8`, which Peter reported as
"TINY fonts disproportionate to the card size, I see no charts at all".

**This spec names `docs/STYLE_GUIDE.md` (canonical) as required by its §8.6.**
Companion: `docs/BROWSER_CONTRACT.md`.

## Diagnosis

The page was not designed against the project's own design system. The app has a
canonical identity — a **radio operator's console**: Oxanium display type,
JetBrains Mono for every mesh-produced value, signal teal as the single accent
(STYLE_GUIDE §1). I reached for stock DaisyUI cards and ad-hoc pixel sizes
instead, so the page reads as generic *and* violates the guide.

The "tiny fonts" complaint is not taste. It is a documented violation: §2 bans
`px` font sizes in partials and defines exactly one absolute size
(`html { font-size: 17px }`) that everything else scales from. `text-[10px]`
fights that knob directly.

### Violations being fixed

| # | Violation | Rule |
|---|---|---|
| 1 | `text-[10px]` / `text-[11px]` in the partial | §2 banned |
| 2 | `style="height:190px"`; Chart.js `font:{size:10}` | §2 / §7 banned inline size |
| 3 | No §3 type roles — ad-hoc `text-xs` as body text | §3 (the defect the guide exists to eliminate) |
| 4 | Raw hex chart colors (`#22d3ee`…) | §4 no raw hex |
| 5 | `rgba(0,255,80,…)` phosphor on the NODE INFO button | §4 + §6 — phosphor is instrument-screens ONLY |
| 6 | Card anatomy `border-base-200`, plain `h3` heading | §5 card anatomy + section-label role |
| 7 | Verified at 780×493 | §8.3 requires **1440×900**, both themes |
| 8 | Bare "No record of this node" | §8.5 empty states must be designed |

## Type roles applied (§3)

| Element | Role | Recipe |
|---|---|---|
| Node name | Page title | `text-lg font-display font-bold tracking-wide` |
| Section headings | Section label | `text-xs font-display font-semibold uppercase tracking-wider text-base-content/50` |
| Header vitals (battery, voltage, uptime, RSSI, SNR) | **Display value** | `text-2xl font-mono font-bold tabular-nums` |
| Vital captions, kv keys, timestamps | Caption | `text-xs text-base-content/50` |
| kv values, event text | Data | `text-sm font-mono tabular-nums` |

The header vitals becoming display-value (26px mono) is the direct answer to
"tiny fonts": on a page whose job is *what is this node doing right now*, the now
values are the headline metric and get the stat-block treatment (§5).

De-emphasis uses opacity tiers, never a smaller size (§3).

## Layout fix — label/value separation

At 1600px the old `repeat(auto-fill,minmax(190px,1fr))` produced 6+ stretched
columns, flinging each key to the far left of its cell and its value to the far
right (`ver · · · · · · 1`). §5 defines the sanctioned shape for *properties of
one thing*: **key-value rows, caption-role key left, data-role value right** —
but the pair must stay visually associated.

Fix: bound the column so a pair never stretches —
`repeat(auto-fill,minmax(15rem,22rem))`, rem-based per §2, justified `start`.

## Color (§4)

Partials use DaisyUI semantic classes only. No raw hex, no `rgba()`.

Chart series colors come from `themeColor()` (`app-helpers.js`), which reads the
per-theme DaisyUI custom properties — so charts re-color correctly in both
themes instead of carrying hardcoded hex. Order: `primary`, `success`,
`warning`, `info`, `secondary`.

The NODE INFO button becomes `btn btn-sm btn-primary` (§5: page-level primary
action). Its phosphor green was a §6 violation — phosphor is reserved for
`.instrument` screens.

## Chart fix — the real bug behind "no charts at all"

`Uncaught TypeError: Cannot read properties of null (reading 'save')` in
Chart.js `_drawDataset`: destroy-during-animation. `applyNodeStatus()` destroyed
and rebuilt every chart on each `node_status_update`, and an active node hints
~1/second (the ws-relay throttle floor), so charts were torn down mid-animation
continuously and never survived to render.

Fix — stop destroying on refresh:

1. Build a chart once per section id.
2. On refresh, **update in place**: assign `chart.data.datasets`, then
   `chart.update('none')`. This is Chart.js's intended path.
3. `animation: false` — removes the draw-after-teardown window entirely, and a
   live-updating instrument should not re-animate every second anyway.
4. Destroy only on tab leave (`navMixin`) and when the section set changes.

The earlier `Chart.getChart(el)?.destroy()` fix treated a symptom of this same
root cause; update-in-place removes the class of bug.

Chart tick/legend fonts drop their `size:10` overrides and inherit, per §2.

## Empty + error states (§8.5)

- Unknown node: a designed state — heading, one line of explanation, and a
  "Back to nodes" action. An empty screen is an invitation to act.
- Loading: existing spinner, caption role.

## Files

| File | Change |
|---|---|
| `public/partials/tab-node.html` | type roles, card anatomy, bounded kv columns, designed empty state |
| `public/app-node-status.js` | update-in-place charts, `animation:false`, `themeColor()` series, no font sizes |
| `public/partials/tab-shared.html` | NODE INFO → `btn btn-sm btn-primary` |
| `docs/modules/app-node-status.md` | updated + rehashed |

## NOT in this task

- **Favourites / nav entry** (backlog #7 item 3). It needs a config key, a
  backend route and nav wiring — a feature, not a restyle. Tracked separately;
  the page stays reachable via the modal meanwhile.
- The 260 config **editor** (read-only panel is by design).

## Done when (STYLE_GUIDE §8)

1. Every text element maps to a §3 role — no ad-hoc sizes
2. No raw colors, no inline styles beyond §7 exceptions
3. **Both themes screenshot-verified at 1440×900**
4. Controls use §5 defaults
5. Empty/error states designed
6. This spec names STYLE_GUIDE.md ✓
7. Charts render and *keep* rendering across ≥10 live update cycles, asserted on
   drawn output and sustained absence of Chart.js errors — not on element count
8. `python scripts/check_specs.py` green
