---
module: style-css
source: public/style.css
source_hash: 259c40486b01d07bb56c2016cad28747ad21c2ec96932c38aac1511c51b74a9c
updated: 2026-07-08
---

# Module: style-css

## Purpose

The application stylesheet. Implements the design system defined in
`docs/STYLE_GUIDE.md` — that document is normative; this spec records what the
file contains so `check_specs.py` catches drift. Any edit to `public/style.css`
must comply with the guide and update this spec's hash.

## Contents (in order)

1. **Font import** — Oxanium, DM Sans, JetBrains Mono via Google Fonts
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
