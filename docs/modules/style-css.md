---
module: style-css
source: public/style.css
source_hash: da405c833d102b09a47c6caf2c0d2f66cb500f73c13bd264cb479a33a55a1e03
updated: 2026-07-29
---

# Module: style-css

## Purpose

The application stylesheet. Implements the design system defined in
`docs/STYLE_GUIDE.md` — that document is normative; this spec records what the
file contains so `check_specs.py` catches drift. Any edit to `public/style.css`
must comply with the guide and update this spec's hash.

## Contents (in order)

1. **Local font faces** — Oxanium, DM Sans, JetBrains Mono from
   `/vendor/fonts/*.woff2`; no runtime font CDN
2. **The global size knob** — `html { font-size: 17px }`. The only absolute
   font size in the app (STYLE_GUIDE §2)
3. **Dark tokens** — `:root` block: signal teal (`--sig*`), amber, red, grid,
   borders, overlays, skeletons, transitions; plus theme-invariant instrument
   screen tokens (`--screen`, `--phos*`, `--trace-amber`, `--trace-red`)
4. **Typography base** — body font, display-face and mono-face assignments
5. **Component styling** — navbar, badges, sidebar menu, tabs, cards, stats,
   collapse, tables, scrollbars, form controls, buttons, alerts, dividers,
   chat bubbles, footer, skeleton, tooltip, entrance animations, radar layout
6. **Light theme** — `[data-theme="corporate"]` token block plus per-component
   light adjustments, all scoped to the theme attribute (not the media query)
7. **Instrument panels** — `.instrument`, `.instrument-label`,
   `.instrument-value` (+ `--amber`, `--red`), `.instrument-faint`,
   `.instrument-header`, `.instrument-screen`, `.instrument-btn`
   (+ `--active`, `--amber`, `--red`), `.instrument-divider` (STYLE_GUIDE §6)
8. **Utility classes** — `.font-oxanium`, `.hop-circle` (hop-count badge;
   border+text colour = hop count via `text-*`) + `.hop-dot` (traceroute-
   VERIFIED marker — a small green dot riding the circle's OUTER ring at
   ~2 o'clock (body outside the interior so it never covers the hop number);
   base-bg ring for separation; green when fresh / amber via `.hop-dot.stale`
   when the traceroute is stale (backend `hops_fresh`); absence = reported;
   task `hops-badge-verified-dot`, superseded the illegible 5-point-star
   `.hop-star` which wasted the tiny interior on its points),
   `.radar-stat-grid`, `.sig-bars`, `.perf-*` chart classes

## Known debt — marked in-file

All LEGACY utility-class-selector rules have been removed (`overview-refactor`
removed the `.text-base-content\/40` mono hijack and dead feed rules;
`navbar-drawer-refactor` removed `.navbar .text-lg`, `.navbar .text-xs`,
`.badge-primary.badge[x-text*="live"]`, `.overflow-x-auto.max-h-\[70vh\]`).
No new utility-selector rules may be added.

## Invariants

- Exactly one `html { font-size }` declaration exists, at the top
- Every custom property outside the instrument-screen group has both a `:root`
  (dark) and a `[data-theme="corporate"]` (light) definition
- Phosphor/trace colors appear only in the `.instrument*` rules
- Light-theme overrides are scoped to `[data-theme="corporate"]`, never to
  `@media (prefers-color-scheme: …)`
- New CSS hooks are semantic class names, not utility-class selectors

## Test notes

Visual validation via Playwright (STYLE_GUIDE §8): every page screenshot in
both themes at 1440×900; dark theme retains visual parity, light theme shows
correct inverted tokens; no console errors.

## `.perf-stats-grid .stat-desc` wraps (task `stat-desc-clipped`, 2026-07-29)

The rule was `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`,
which silently truncated the provenance a `desc` exists to carry. Measured at
1600×1000 against a ~171 px box:

| desc | needs | was |
|---|---|---|
| `OMNI · 434 of 464 direct` | 171 | fitted |
| `traceroute 14 Jul 17:51 · 886 failed since` | **228** | **clipped** |
| `Poor · -9.0 dB · best of 2 · YAGI · direct 24m ago` | **275** | **clipped** |

The clipped remainders were `886 failed since` — the words saying a verified-hops
value is FROZEN — and `direct 24m ago` — the words saying how old a signal
reading is. **A qualifier that appears only when it happens to be short is worse
than none, because it reads as complete.**

Fixed here rather than with a Tailwind utility on the element: this selector is
specificity 0,2,0 and beats `.whitespace-normal` (0,1,0), so
`class="stat-desc whitespace-normal"` had no effect at all — verified in the
browser before changing approach.

`.stat-value` keeps `nowrap`: it is one short figure by construction and wrapping
it would break the tile rhythm. Only the desc is prose.

**Shared with the Performance page, and it improved there too.** Of its 10
descs, 9 were unchanged and the 10th (`above the decode limit · first hop`) had
been silently truncated and now wraps to two lines. Same latent defect, same fix.
Tiles stay uniform: all grew 77 px → 93 px together, so the grid alignment holds.
