---
module: tab-cfg
source: public/partials/tab-cfg.html
source_hash: 82bd66849ddfd2e10226b987eacab0a828e4ea9bba759b8d9996fd29662a6855
updated: 2026-09-04
---

# Module: tab-cfg

## Purpose

Config page HTML template: six sub-tabs (Bridge, Modes, Radar, Discovery,
Callout, Alerts). Per-radio section/channel/owner forms and rotator
configuration are both gone — mesh-gw owns device configuration now. All
zero-decision presentation.

## Rotator sub-tab removed (2026-09-04, task `rotator-config-tab-removed-meshgw-owns-it`)

Superseding every section below that describes it (Rotator device selector,
Variant-aware rotator config, v5 config built from the device schema): the
whole Rotator sub-tab — Device switch, Status telemetry, Motor & Scan schema
form, Calibration — is deleted. It was already **entirely dead** before
deletion, not merely redundant:

- No `/rotator/*` backend route has existed since 2026-09-03 (task
  `rotator-command-via-meshgw-aim` deleted them all — commanding moved to
  mesh-gw's `aim` plugin).
- `src/ws-relay.js` itself documents removing rotator status/target-list/
  schema WS broadcasting the same day — so `rotatorTargets`, `rotatorSchema`,
  and every `rotatorStatus.*` telemetry field this sub-tab displayed (`az`,
  `pwmMin`, `pwmRun`, `state`, `curMa`, `holdPct`, `sps`, `usteps`, …) could
  never populate again regardless of this deletion.
- mesh-gw confirmed (`mesh-gw--node-dash`#103) `GET /schema/rotator_config`
  is not coming back under that name: rotator **configuration** (host, port,
  API dialect) moved into their per-radio `install.antenna.rotator` object,
  served on `GET /devices` — already flowing through this app's own
  `device_data`/`device_snapshot` handling — and is device configuration
  they own, the same ruling already applied to Devices/BLE/OTA
  (`devices-management-removed-meshgw-owns-it`, 2026-09-03).

**Commanding is unaffected and stays.** `moveRotator`, `_checkRotatorStatus`,
`_onRotatorEvent` (for `point_target`/mode, not telemetry), `setRotatorMode`,
`startScan`/`abortScan` all still work exactly as before — none of them ever
went through `/rotator/*`; they use `aim-client.js`/mesh-gw's `aim` plugin
directly and live entirely on the Radar page, not Config.

**`scanStep`/`scanDwell`/`actvDwell` are NOT changed by this task.** They are
node-dash's own settings (not device config), displayed read-only on
`tab-radar.html`. They were already frozen at their `app.js` hardcoded
defaults before this deletion — the only thing that ever loaded or saved them
(`loadRotatorCfg`/`saveRotatorConfig`, via the also-dead
`/rotator/firmware_config`) was already non-functional. This deletion changes
nothing about their behaviour; giving them a real, editable home is a
separate, not-yet-filed gap.

**Two live bugs caught only by looking, not by any check** — the same
sidebar Config submenu that still offered "Rotator" (which would have opened
a blank pane the moment this landed) also lacked "Discovery", which
`tab-cfg.html`'s own tab strip has had for a while. See
`docs/modules/drawer-sidebar.md`. Also dropped, in the same pass: `app.js`'s
dead `antennaSaved`/`antennaError` state (zero references — leftover from
`saveAntennaCfg`, deleted in the earlier Devices removal and never cleaned
up).

## Mobile containment (2026-07-23)

The five tabs use a full-width five-column grid below `sm`, compact type and
padding, then return to their intrinsic desktop tab width. All labels remain
visible at 390px.

## Modes sub-tab (task `modes-config-ui-browser`, 2026-07-09)

Per-mode radio-role editor. Three cards (PASV/ACTV/SCAN), each with a
**Listener (RX)** and **Transmitter (TX)** `<select>` bound to `modesCfg.<mode>.rx`
/ `.tx`. Options come from static `rxRoleOptions` / `txRoleOptions` (role
enums: rotator / non-rotator / primary / all, plus `rx` "whichever heard it"
for TX). `switchCfgTab('modes')` → `loadModesCfg()` (`GET /config/modes`, a
sanctioned config-editor form read); **Save all** → `saveModesCfg()`
(`PUT /config/modes`). Pure presentation — the browser renders the roles it is
given and submits the user's selection; the backend (`dash-mode` +
`config-api`) owns validation and the effect on reception/dispatch, and the
Devices-page RX/TX badges reflect the resulting live roles (BROWSER_CONTRACT).
State + handlers live in `app.js` / `app-config.js` (unspecced mixins).

## History — describes the deleted Rotator sub-tab, kept for the reasoning

The three sections below (Rotator device selector, Variant-aware rotator
config, v5 config built from the DEVICE schema) are not a current spec — see
"Rotator sub-tab removed" above. Preserved because the reasoning (why v4/v5
needed separate schemas, why the device's own schema was used over a
hardcoded one) may matter again if mesh-gw ever needs to know what this used
to do.

## Rotator device selector (task `rotator-switch-ui`, 2026-07-07)

The Rotator sub-tab leads with a **Device** card that switches the active
rotator between the co-existing v4/v5 firmwares (see
`docs/ROTATOR_API_V5.md`, module `rotator`). Data-driven — the browser makes
zero decisions:
- `x-for` over `rotatorTargets` — a dedicated stable state (app.js) updated
  by `_onRotatorEvent` only when the list content changes, so the loop doesn't
  churn on every per-frame `rotatorStatus` replacement (which threw Alpine
  `_x_effects` errors). `btn-primary` when `t.name === rotatorStatus.active_target`.
- `@click="selectRotatorTarget(t.name)"` (app-rotator.js) → `POST /rotator/active`.
- Indicator shows `API <rotatorStatus.api ?? '4 (legacy)'>` + `· offline`
  when `!rotatorConnected`, and the active target's URL (which carries the IP).
  The highlighted button already conveys the variant.
This replaced the stale `alert-info` that claimed the URL comes only from the
`ROTATOR_WS_URL` env var.

## Variant-aware rotator config (task `rotator-config-variant-aware`, 2026-07-07)

The v4/v5 rotators are different hardware, so the config surface follows the
active variant (`rotatorStatus.variant`):
- **Motor & Scan form** — schema-driven. `loadRotatorCfg`/`saveRotatorConfig`
  (app-rotator.js) select `schema.variants[variant].fields` (v4 PWM
  `pwm_min/pwm_run/pulses_per_deg` ↔ v5 stepper `run_ma/hold_pct/sps/usteps`),
  falling back to the legacy top-level `fields` (= v4). A `$watch` on
  `rotatorStatus.variant` (app.js) clears `#rotator_cfg_form`'s dirty flag and
  rebuilds when the device switches while the tab is open. The backend
  `/rotator/firmware_config` GET/POST are already per-variant.
- **Status card** — v4 PWM rows and v5 stepper rows (`state`, `northOffset`,
  `curMa`, `holdPct`, `sps`, `usteps`) each `x-show` on their own field, so
  only the active firmware's telemetry appears.
- **Calibration** — v4 compass/PWM routines (`qmcCali`, `calPwmMin`, `calMotor`,
  `qmcOs*`) are `x-show`-gated to v4; a v5 block offers `dirtest`. The offset
  Set maps per-variant server-side (`setOffset`/`caloffset`). Arg-taking v5
  north-set (`caltrue <bearing>`) is a later task (needs backend arg passing).

## v5 config built from the DEVICE schema (task rotator-config-device-schema-ui)

For v5 the Motor & Scan form (`#rotator_cfg_form`) is built from the device's
own config schema (pushed over WS as `rotatorSchema`), not the hardcoded
`rotator-config-schema.js`. The DRY win: it reuses the **same** `buildForm`/
`collectForm` as the radio config — no second form builder or validator.

- `_deviceSchemaGroups(schema)` (app-rotator.js) buckets the flat device fields
  by their `group` (`display`/`motor`/`tracking`) into `buildForm`
  `type:'object'` group boxes; `num`→`int`, `bool`→toggle; `min`/`max` become
  input bounds (`buildForm` now honors `field.max`, added alongside `field.min`).
- The node-owned `scan`/`actv` dwell groups (not device settings) are appended
  from the hardcoded schema; the form is `[device groups…, scan, actv]`.
- **Save** (`el.dataset.device==='1'`): each *changed* device field is set via
  `POST /rotator/config {id,value}` — the **device validates** and returns
  `{ok,msg,value}`; any `ERR` is surfaced in `rotatorCfgError`. `scan`/`actv`
  still go to `/rotator/firmware_config`.
- v4 (or before the schema arrives) keeps the hardcoded per-variant path
  unchanged. A `$watch('rotatorSchema')` rebuilds the form when the schema
  (re)arrives while the tab is open.

## Scope

**STYLE_GUIDE.md compliance refactor (task `config-refactor`).** Zero logic
changes — every Alpine binding, handler, `x-ref`, and generated-form mount
point is preserved verbatim.

Files in scope:
- `public/partials/tab-cfg.html` — presentation classes only
- `public/app-forms.js` — ONE class-string constant (group-title eyebrow);
  no logic
- `public/style.css` — `.label-text` font-size 0.68rem → 0.75rem
- `docs/modules/style-css.md` — hash update

Files explicitly NOT changed:
- `public/app-config.js` — form build/collect logic untouched
- All other partials and JS

## Changes

### Global (style.css)
- `.label-text` font-size `0.68rem` → `0.75rem` (caption floor, 12.75px
  effective). Cross-page effect: all form labels app-wide (incl. 2 sites in
  tab-devices, all generated forms) rise ~1.2px — the intended caption floor.

### tab-cfg.html
| Location | Before | After |
|---|---|---|
| Page container (l.2), radio tab stack (l.12) | `gap-3` | `gap-4` |
| Card titles ×8 (Antenna, Status, Motor & Scan, Calibration, Home Position, Display, PASV, ACTV, SCAN, Email) | `card-title text-base` | `card-title` (global rule governs) |
| Collapse titles ×2 (l.105, 178) | `text-md font-semibold` | `font-semibold` (text-md is not a Tailwind class) |
| Descriptions ×6 (l.335, 365, 394, 417, 444, 464) | `text-xs opacity-50`/`text-base-content/40` | `text-sm text-base-content/60` |
| Section eyebrows ×3 (l.134, 325, 342) | `text-xs font-semibold uppercase text-base-content/50` | + `font-display tracking-wider` |
| Reboot warnings ×2 (l.131, 217) | `text-warning/70 text-xs` | `text-warning/70 text-sm` |
| Section-notes alert (l.113) | `text-xs` | `text-sm` |
| Scan estimate (l.477) | `text-xs opacity-60 font-mono` | `text-sm opacity-60 font-mono` |
| Tilt cal buttons ×4 (l.82–93) | `btn-xs` | `btn-sm` |
| Rotator PWM rows (l.293–307) | `input-xs` + `btn-xs` | `input-sm` + `btn-sm` |
| Compass cal buttons ×2 (l.337–338) | `btn btn-sm btn-outline btn-xs` | `btn btn-sm btn-outline` |
| Tilt cal grid (l.78) | `style="grid-template-columns:auto 1fr auto auto"` | `grid-cols-[auto_1fr_auto_auto]` |
| Alert rules last-triggered (l.607) | `text-xs opacity-60 font-mono` | `opacity-60 font-mono` (inherits table-sm size) |

Kept as-is (sanctioned):
- `label-text text-xs` on all labels — agrees exactly with the bumped global
  rule (both 0.75rem); caption tier per guide §3
- `label-text-alt text-xs opacity-50` unit hints — caption tier
- Alert-rules table `input-xs` — dense repeating rows (guide §5)
- PWM `(pwmRun n)` echo and unit suffixes `text-xs` — captions
- Alert rule descriptions `text-xs opacity-50` — captions under a text-sm label
- "Tilt Calibration" divider — global `.divider` component sizing

### app-forms.js
- Group/box title class (l.37):
  `'text-xs font-semibold uppercase text-base-content/50 mb-2'` →
  `'text-xs font-display font-semibold uppercase tracking-wider text-base-content/50 mb-2'`

## Discovery sub-tab

How the discovery runner chooses and pursues targets — strategy, window,
attempts per target, cooldown, interval, enabled. Same shape as the Radar
section: loaded on first view via `x-effect`, saved through the
`discovery_config` op.

The `min`/`max` on the inputs are a **courtesy, not the validation** — every
value is clamped server-side (`docs/modules/config-api.md`).

States plainly that selection changes take effect at the next recompute (up to
15 min) while rate and on/off take effect on the next mission, because the two
have genuinely different latencies and a silent delay reads as a broken form.

## Mode sits above strategy in the Discovery section

`mode` decides whether auto picks targets at all (`auto` / `targets first` /
`manual`); `strategy` decides how it picks when it does. Orthogonal, and the
helper text says so — two selects that look alike need to explain how they
differ.

## The two beam timings sit together

`hold_sec` ("Hold the beam after aiming") and `aim_patience_sec` ("Wait for a
held beam") are adjacent, because they are two halves of the same conversation
with a shared antenna: how long we keep the beam, and how long we wait for it
when someone else has it. Reading either alone gives the wrong picture of how
courteous the runner is.

`aim_patience_sec` bounds `0–60`, mirroring the server (`DISCOVERY_LIMITS`). The
helper text carries the trade rather than just the units — the number is
meaningless without knowing that waiting longer starves the garage alarm, and
that `0` gives up the whole 180 s tick on any hold at all.

The label is deliberately short ("Wait for a held beam", not "Wait for a beam
someone else holds"): the longer version wrapped to two lines and made its grid
row taller than the field beside it. Caught in the screenshot, not in the markup.

## The silence cutoff is on the Discovery section

`max_silence_days`, with the measured rates in its helper text: a node heard
today answers 16–26% of the time, one silent over a week 1.8%. A number without
that context reads as arbitrary.

## Invariants

- Zero changes to Alpine expressions, handlers, `x-ref` names, and the
  `sec_*`/`ch_*`/`owner_form`/`bridge_cfg_form` mount IDs (historical — several
  of these mount points, including `rotator_cfg_form`, no longer exist; see
  the removal notes above and in `app-devices.md`/`app-config.md`)
- No raw colors introduced; no inline styles remain
- `buildForm`/`collectForm` behavior byte-identical apart from the one class
  string

## Test notes

Playwright, both themes, 1440×900 (guide §8):
- All five sub-tabs render; Radio sub-tabs (Device/Channels/Owner) switch
- Open one protobuf section — generated labels at caption size, eyebrow style
  on group boxes
- (Rotator sub-tab test — historical, section deleted 2026-09-04)
- Alerts: SMTP grid labels legible; rules table intact with input-xs rows
- Devices spot-check (label-text bump)
- 0 console errors

## Radio tab removed (task `radio-config-into-devices`, 2026-07-16)

The Radio tab (radio selector + Device/Channels/Owner sub-tabs: antenna card,
tilt calibration, schema section collapses with the fixed-position panel,
channel collapses, owner form) moved into the Devices page strips — per-radio
configuration belongs with the radio, and expanding a strip replaces the
selector. Config kept the system-level tabs at the time: Bridge / Rotator /
Modes / Radar / Alerts (Discovery joined later; Rotator itself left
2026-09-04 — see "Rotator sub-tab removed" above).

Related non-partial edits in the same task (modules unspecced): `app.js`
sanitizes the persisted `cfgTab` (`'radio'` → `'bridge'`, new default
`'bridge'`) so users who last visited the removed tab don't land on a blank
page; `app-config.js` `switchCfgTab` drops its dead `'radio'` branch
(`resetRadioCfg` and the loaders stay — the Devices page calls them now).


## Callout tab — and the label wrap that misaligned the row

Task `broadcast-callout-instrument` (Domain 2 half). Peter: *"i dont see anything
in the dashboard configs for the token based ping messages?"*

Enable switch, four knobs, quiet hours, the templates with per-template TTL and
add/remove, and a **live preview** rendered against a real node (JRSY, 219 km,
159°) so the tokens do not have to be imagined.

The page shows the **effective** config — `GET /config/callout` returns it already
clamped — so the hard ceilings are visible rather than implied. Asking for 9999
sends/day displays 12 on return.

### Labels too long for a 228 px column

Peter: *"there are alignment settings (labels too long) causing field alignment
offsets."* Measured, four-across grid at 1600×1000:

| label | wrapped | input top |
|---|---|---|
| Only nodes further than | yes | 318 |
| At most per day | no | **301** |
| Same node not again for | yes | 318 |
| Only if heard within | no | **301** |

A **17 px** step across a single row, because a two-line label pushes its own
input down.

**Both causes fixed, not just the visible one.** The labels were shortened —
`Minimum distance` / `Max per day` / `Repeat after` / `Heard within`, since the
unit chip already carries km/days/hours — *and* the label div gained
`min-h-[1.75rem] items-start`, so a future label, a translation, or a narrower
viewport cannot reintroduce the offset. Shortening alone would have fixed today
and broken again later.

Verified after: all four inputs at top **305**, spread **0**.

The Discovery tab was checked for the same fault and is clean — 12 number inputs,
zero wrapped labels — so this was specific to the new four-across grid.

## The callout switch is not a form field

"Send public callouts" carries `@change="setCalloutEnabled($event.target.checked)"`
and applies on the spot, unlike every other control on the page, which waits for
Save. That asymmetry is deliberate: it transmits on the **public mesh**, and it
was previously `x-model` only — so it showed "off" while broadcasting (see
`app-config.md`). The helper text states the difference so the inconsistency is
explained rather than surprising.

Any future transmit-affecting control on this page follows the same rule: it
takes effect when clicked, or it is not a switch.
