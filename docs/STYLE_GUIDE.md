# Style Guide — the dashboard design system

**Status: canonical.** Every UI change — bug fix, new section, new page — must comply
with this document. A change that cannot be expressed within these rules requires a
written exception in its task spec, approved by Peter before implementation, exactly
as `BROWSER_CONTRACT.md` handles logic exceptions.

Companion documents: `BROWSER_CONTRACT.md` (the browser makes zero decisions),
`BROWSER_ARCH.md` (state ownership). This document owns everything visual.

---

## 1. Identity

The dashboard is a **radio operator's console**: an instrumentation aesthetic for a
Meshtastic mesh radar. Its character comes from three things, applied consistently:

1. **Oxanium** display type for names and labels — squared, technical
2. **JetBrains Mono** for every value the mesh produces — data is monospace, always
3. **Signal teal** as the single interactive accent, with amber reserved for warnings

The radar page is exempt from layout and component rules (it is a full-screen
instrument), but it still draws colors from the same token set.

## 2. The global size knob

There is exactly **one absolute font size** in the application:

```css
/* style.css — THE knob. Change legibility here and nowhere else. */
html { font-size: 17px; }
```

Everything else is rem-based (Tailwind and DaisyUI both are), so the entire UI —
text, buttons, inputs, spacing — scales from this single declaration.

**Banned:** `font-size` in inline `style=` attributes, `px` font sizes anywhere in
partials, and any new absolute size in CSS. SVG chart internals (axis labels, tick
text) are the sole exception and must use ≥10px equivalents.

## 3. Type roles

Text never picks a size — it picks a **role**. Each role maps to exactly one class
recipe. Sizes below assume the 17px root.

| Role | Recipe | Effective | Use for |
|---|---|---|---|
| **Page title** | `text-lg font-display font-bold tracking-wide` | 19px | One per page, optional |
| **Section label** | `text-xs font-display font-semibold uppercase tracking-wider text-base-content/50` | 13px | Card/section eyebrows ("DEVICE CONFIG") |
| **Body** | `text-sm` | 15px | **Default for all UI text** — labels, descriptions, table cells, list items |
| **Data** | `text-sm font-mono tabular-nums` | 15px | Every mesh-produced value: IDs, addresses, dBm, counts, timestamps in tables |
| **Caption** | `text-xs text-base-content/50` | 13px | Metadata, hints, last-seen times. Never primary content |
| **Display value** | `text-2xl font-mono font-bold tabular-nums` | 26px | Hero stats (headroom dB, temperature) |

Font utilities `font-display` (Oxanium), `font-body` (DM Sans), `font-mono`
(JetBrains Mono) are defined in the inline `tailwind.config` in `index.html`.

Rules:
- `text-xs` outside the Section-label and Caption roles is a violation.
- The old pattern of `text-xs` body text (60 instances on the Config page) is the
  primary legibility defect this guide exists to eliminate.
- De-emphasis is expressed with opacity tiers of `base-content` — `/70` secondary,
  `/50` tertiary, `/30` disabled/faint — never with a smaller size.

## 4. Color

**Partials use DaisyUI semantic classes only.** `base-100/200/300`, `base-content`
(with opacity tiers), `primary`, `secondary`, `accent`, `info`, `success`,
`warning`, `error`. No raw hex, no `rgba()`, no named CSS colors in any partial.

The identity palette, for reference (these live only in `style.css` tokens):

| Token | Dark | Light | Meaning |
|---|---|---|---|
| Signal teal | `#00d4c8` | `#00857d` | Interactive accent, live indicators |
| Amber | `#f5a623` | `#996607` | Warnings, degraded states |
| Alert red | `#f87171` | `#dc2626` | Errors, destructive actions |
| Phosphor | `#00ff50` | `#00ff50` | Instrument screens ONLY (see §6) |

Every custom property in `style.css` is defined **per theme**:

```css
[data-theme="business"]  { --sig: #00d4c8; --panel-border: rgba(255,255,255,.07); … }
[data-theme="corporate"] { --sig: #00857d; --panel-border: rgba(0,0,0,.10);      … }
```

A custom property with a single, theme-blind definition is a violation — this is
what made the current light theme derelict.

Status color semantics (fixed vocabulary): `success` = connected/ready/verified ·
`warning` = in-progress/degraded/attention · `error` = failed/disconnected/destructive
· `info` = neutral notification. Never decorate with status colors.

## 5. Component grammar

Choose the element by the shape of the data, not by habit:

| Data shape | Element |
|---|---|
| Entities the user browses/selects (nodes, devices) | Card grid |
| Comparable rows, ≥4 aligned columns (logs, traceroutes) | `table table-sm`, mono data cells |
| Properties of one thing (MQTT status, node identity) | Key-value rows: caption-role key left, data-role value right |
| One headline metric with context | Stat block (display-value + caption) |
| Status enum (READY, ACTIVE, DM) | `badge badge-sm` — badges are for enums, never for data values |
| Long-running operation | `loading loading-spinner` + progress badge, per existing `ops[key]` pattern |

**Card anatomy** (the only card pattern):

```html
<div class="card bg-base-100 shadow-sm border border-base-300">
  <div class="card-body py-4 gap-3">
    <h2 class="…section-label recipe…">SECTION NAME</h2>
    …content…
  </div>
</div>
```

Sub-sections inside a card: `bg-base-200 rounded-xl p-3` with a section-label
eyebrow (the Devices page panel is the reference implementation).

**Controls:** `btn-sm`, `input-sm input-bordered`, `select-sm select-bordered`,
`checkbox-sm` are the **defaults**. The `-xs` variants are permitted only inside
dense repeating rows (table rows, file lists). Page-level primary actions:
`btn-primary`; destructive: `btn-error` (outline unless confirm-gated).
A button states its action: "Save changes", "Start TX" — never "Submit" or "OK".

**Spacing scale:** page stack `gap-4`; inside cards `gap-3`; dense rows `gap-2`;
page padding `p-4`. No other gap values without a reason stated in the task spec.

## 6. Instrument panels

The CRT-look panels (Enclosure Environment, Mast Tilt) are the design's signature
and become an **official component**, `.instrument`, defined once in `style.css`:

- The screen face is dark in **both** themes — a hardware LCD is dark in a lit room.
  This is the one sanctioned dark-on-light element.
- Phosphor green / trace amber are used **only** inside `.instrument` screens.
- The panel's chrome — outer border, containing card, header label — uses standard
  theme tokens and the section-label type role like any other card.
- All text inside follows the type roles (§3). The current 9px inline labels are
  violations and get re-set at caption size minimum.
- No inline `style=` — the look lives in `.instrument` classes.

## 7. CSS architecture rules

- `style.css` defines: the knob (§2), per-theme tokens (§4), and **semantic
  component classes** (`.instrument`, etc.). Nothing else.
- **Banned:** styling through utility-class selectors (`.navbar .text-xs { … }`).
  CSS hooks are semantic class names; utilities stay in markup.
- **Banned:** inline `style=` in partials, except values genuinely computed from
  data at runtime (chart geometry, avatar hue, progress width).
- Fonts load once from local `/vendor/fonts/*.woff2` faces declared in
  `style.css`; `tailwind.config` in `index.html` maps them to `font-display` /
  `font-body` / `font-mono`. Runtime font CDNs are forbidden.
- Transitional note: legacy utility-selector rules remain in a marked
  `/* LEGACY */` block until each page's refactor task removes its dependents.

## 8. Definition of done — every UI task

A UI task (new feature or fix) is complete only when:

1. Every text element maps to a §3 role — no ad-hoc sizes
2. No raw colors, no inline styles beyond the §7 exceptions
3. Both themes screenshot-verified in Playwright at 1440×900 — dark **and** light
4. Controls use §5 defaults; `-xs` only in sanctioned dense contexts
5. Empty/error states designed (an empty screen is an invitation to act, not a blank)
6. The task spec names this document

## 9. Adoption sequence

1. **Foundations** (task `style-guide`, this spec): knob, per-theme tokens,
   `tailwind.config` font mapping, `.instrument` component, legacy block marked
2. **Page refactors**, one /idiot task each, each attaching this guide:
   overview (worst offender) → config → nodes → messages → performance → range →
   devices (consistency pass) → drawer/navbar
3. Radar: token alignment only

---

*Any question this guide does not answer is answered by: pick the plainer option,
match the Devices page reference implementation, and record the decision here in
the same task.*
