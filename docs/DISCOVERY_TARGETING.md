---
module: DISCOVERY_TARGETING
source_hash: 36875861e490880d6014048cf178cc67230eae3e0c21ed3af18554385cdc2dc6
updated: 2026-08-02
---

# Picking your own targets

Task: `obs-target-selection`. Builds on `docs/DISCOVERY_STRATEGY.md`.

Peter, 2026-08-02: *"I would like to have the ability to select a node and
favourite it, this would always prioritize it, maybe every x traces it will try
the favourites… and also have the ability to select a node push it to the top and
work on it… maybe an auto/manual toggle is needed?"*

## Why not the existing star

`nodeinfo.favourite` already exists, with the exact click-on/click-off UX, an
endpoint (`nodes-api.js:14`), a sidebar nav entry and a node-filter bypass
(`node-filter.js:34`).

**It must not be reused.** The three nodes starred today are **TA2m, GARG,
GARG** — our own local units, 2.5 km away. Wiring discovery to that flag would
immediately spend airtime tracerouting the garage alarm.

Peter: *"that favourite is used for something else. this favourite only applies
to this observer app."*

*"Pin to my sidebar"* and *"spend airtime pursuing this"* are different intents.
Two flags, two meanings, two icons.

## Three things

| | what it is | where it lives |
|---|---|---|
| **target** (☩) | a node you want pursued; gets a guaranteed share | `nodeinfo.obs_target`, per node |
| **pinned** | *the* node to work on now; jumps the queue | `discovery.pinned`, a single num |
| **mode** | whether auto picks at all | `discovery.mode` |

`pinned` is a **singleton by construction** — one config value, not a per-node
column. The point of pinning is concentration; a pinned *list* is just the queue
again.

### Mode

| mode | behaviour |
|---|---|
| `auto` | as today, plus targets get a small guaranteed quota |
| `targets` | targets take most slots, auto fills the remainder |
| `manual` | **only** pinned and targets — if none are set the shortlist is empty |

A real `manual` state matters because the panel can then say **"MANUAL · nothing
pinned"** instead of idling silently. Silent idling is the exact failure that
cost an hour earlier today.

`mode` and `strategy` are orthogonal and both stay: `strategy` is *how auto
chooses*, `mode` is *whether auto chooses at all*.

## The nuisance guard

A pinned target **bypasses the window** — you asked for it explicitly, so the
ladder does not get to veto it — but **still respects `cooldown_min`**.

Without that, pinning plus a 180 s interval is twenty traceroutes an hour at one
stranger's node. At the default 30 min cooldown a pinned target is attempted
twice an hour and the auto queue fills the gaps, which is pursuit rather than
harassment. Targets behave the same way.

## Exact changes

### `src/db.js`

- Migration: `nodeinfo.obs_target INTEGER NOT NULL DEFAULT 0`, guarded with
  **`PRAGMA table_xinfo`**, not `table_info` — `table_info` omits generated
  columns, and a guard that reads it re-`ALTER`s on every boot and crash-loops.
  (The existing `favourite` guard uses `table_info`; it happens to be safe there
  and is left alone rather than widened in this task.)
- `setObsTarget(num, on)` and `listObsTargets()`, mirroring the favourite pair.

### `src/nodes-api.js`

- `PUT /nodes/:num/obs_target`, mirroring the favourite route exactly, including
  the 404 when there is no `nodeinfo` row and the cache sync afterwards.

### `src/node-list.js`

- `obs_target` joins `favourite` in the enriched node payload, so the browser
  renders from the server and never holds local state.
- `syncObsTargets()` mirroring `syncFavourites()`.

### `src/config-api.js`

- `DEFAULTS.discovery` gains `mode: 'auto'` and `pinned: null`.
- `PUT /config/discovery` validates `mode` against the enum and `pinned` as a
  positive integer or `null`.

### `src/inferences.js` — `reach.mission`

- Evidence `LEFT JOIN nodeinfo` for `obs_target`; subselects for `mode` and
  `pinned`.
- New classes: `pinned` (rank above everything, window bypassed, cooldown
  respected) and `target` (window bypassed, cooldown respected).
- Quotas by mode: `auto` gives `target` 4; `targets` gives it 12 and trims the
  rest; `manual` zeroes every automatic class.
- Summary fact publishes `mode` and `pinned` so the panel states the rule.

### `public/partials/tab-nodes.html`

- A crosshair button beside the existing star, distinct colour, its own tooltip.

### `public/app-nodes.js`

- `toggleObsTarget(n)` mirroring `toggleFavourite` — no optimistic state.

### `public/partials/tab-observatory.html` + `public/app-observatory.js`

- A pin button on each Missions row; pinned row marked.
- The Discovery status line reports `MANUAL · nothing pinned` when that applies.

### `public/partials/tab-cfg.html`

- Mode selector added to the Discovery section.

### Explicitly NOT changed

- `nodeinfo.favourite`, `src/nodes-api.js`'s favourite route, the sidebar nav,
  `node-filter.js` — the existing star keeps its meaning and never affects
  airtime.
- The `discovery` clamps added in the previous task.

## Invariants

- Two flags never merge. The node star does not select targets; the target
  crosshair does not populate the sidebar.
- One pinned target at a time, enforced by the storage shape.
- A pinned or starred target still respects the cooldown.
- `manual` with nothing selected says so on the panel; it never idles silently.
- The browser holds no local toggle state — every render comes from the
  re-broadcast node list.
