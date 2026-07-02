---
module: style-css
source: public/style.css
source_hash: 1fd14040b8ede8ec490b51648e350babfe92cf1230c32eb28e18defa0225d8b6
updated: 2026-07-02
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
8. **Utility classes** — `.font-oxanium`, `.hop-circle`, `.radar-stat-grid`,
   `.sig-bars`, `.perf-*` chart classes

## Known debt — marked in-file

Rules tagged `/* LEGACY(utility-selector, STYLE_GUIDE §7) */` style through
Tailwind utility-class selectors and are scheduled for removal by the page
refactor task named in each tag: `.navbar .text-lg`, `.navbar .text-xs`,
`.overflow-x-auto.max-h-\[70vh\]`, `.badge-primary.badge[x-text*="live"]`.
No new utility-selector rules may be added.

Removed by `overview-refactor`: `.text-base-content\/40` (the global mono
hijack) and the dead `.overflow-y-auto.max-h-\[480px\]` rules.

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
