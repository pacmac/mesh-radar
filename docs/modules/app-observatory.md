---
module: app-observatory
source: public/app-observatory.js
source_hash: 1d80ef8b69ea13eaea56bbf8c5860c80d09d18322836c2edd3e03100a3bea955
updated: 2026-08-02
---

# Module: app-observatory

## Purpose

Observatory page mixin — the live observation feed and the doors table.
**Presentation only.** Every value arrived over the WS from
`src/observatory-ws.js`; this file decides nothing (`BROWSER_CONTRACT`).

**No fetch anywhere in it, and there must never be.** The feed is pushed,
replayed on connect, appended on arrival.

## State

| | |
|---|---|
| `observations` | newest first, capped at 500 |
| `relayUsage` | doors, server-ranked and server-labelled |
| `reach` | the reach model — record, ladder, frontier, radar plot |
| `meshLinks` | `{ total, links[], marks[], nodes[], legend[] }` — geometry, captions, classes |
| `obsTab` | `'board'` \| `'radar'` \| `'map'` \| `'receptions'`, persisted, declared in `app.js` |

`MAX_ROWS = 500` — enough to fill a tall screen and scroll, small enough that an
idle tab cannot grow without bound. The server replays 200 on connect.

## Sub-tabs

Peter, 2026-08-02: *"maybe we need a main menu and sub menus for this? … that way
debug sub pages can be added and we still have the main nasa dashboard."*

`switchObsTab()` mirrors `switchControlTab`/`switchCfgTab` exactly. **No data load
on switch** — everything is WS-pushed regardless of which tab is showing.
Defaults to `board`: the dashboard is the page, raw feeds are diagnostics you go
looking for.

## Times are absolute, not relative

A contract decision rather than a style one. `BROWSER_CONTRACT` forbids the
browser computing "3s ago" on a timer; formatting a timestamp it was *given* is
expressly allowed. So rows carry a clock time. When the server pushes a formatted
age this adopts it without the page changing shape.

## Renderers

```js
obsTime(ts)          // HH:MM:SS, 24h
obsRadio(mac)        // label from the pushed roster, else the raw MAC
obsNode(entity)      // short name if known, else the raw num
obsAz(o)             // "119°" or an em dash — NEVER "0"
obsHasAz(o)          // tints the row; does not filter
obsNum(v, suffix)    // value or em dash
obsNodeCount()       // distinct nodes ON SCREEN
obsRelayShare(uses)  // bar width relative to the busiest door
obsVia(o)            // "RF" | "MQTT" | em dash — never assumed
obsFeedSummary()     // rows on screen, bearings, and the RF/MQTT split
```

### `obsVia` — an em dash for rows written before the flag

`via_mqtt` is a boolean on every observation recorded from 2026-08-02 onward
(spec §3a). Rows older than that have no key, and they render as an em dash
rather than as `RF`. Defaulting them would credit the reach model with contacts
that may never have crossed air — the same class of error as `obsAz` rendering
an unknown bearing as north.

### `obsAz` — em dash, never zero

North is a real bearing. A blank must not read as one, and a zero must not read
as unknown. The same rule the capture side enforces
(`docs/modules/observations.md`).

### `obsNode` looks up by num, not through `nodeById()`

`nodeById()` takes a `!hex` id and threw **`nodeId?.startsWith is not a
function` 182 times** when handed the numeric entity. An observation's `entity`
is opaque to the engine and only *happens* to be a node num here; converting it
to an id would be the page asserting a format the store does not guarantee.

### `obsRelayName()` was removed — the server sends `label`

It looked the name up in `this.nodes`, which is a **filtered** list — 4 entries
when measured — so every relay rendered as a raw number. It was also a
`BROWSER_CONTRACT` breach: a label is a display value and belongs to the server.
`relayUsage()` in `observatory-ws.js` now resolves it.

## The plots — SVG built as a string, not `<template x-for>`

`obsRadarSvg()` and `obsMapSvg()` return markup, and that is **not** a style
choice. The HTML parser treats a `<template>` inside `<svg>` as an SVG-namespaced
element with no `.content`, so Alpine cannot use it as a loop scope: every
binding reports *"ring is not defined"* and the attributes land empty. Thirty
console errors on the first attempt. The frozen mockup builds its SVG as a string
for the same reason.

**Colours come from DaisyUI CSS variables, never Tailwind classes.** Tailwind
here is the in-browser JIT build, and utility classes injected via `x-html` are
never compiled — the first radar rendered as a solid black disc because
`fill-base-200/30` resolved to nothing and SVG defaults to black.
`oklch(var(--b2))` needs no build step and still follows the theme.

The arithmetic in both is *layout* — where on a circle, where in a rectangle. The
kilometres, bearings, ranks and captions were all computed server-side.

### Map labels — de-collided **and clamped**

Marks arrive already clustered, counted and named (`observatory-ws.js`); the page
places them. Labels sharing a corridor are nudged apart vertically, and the
nudge is **clamped into the viewBox**: pushing collisions downwards walked the
Guernsey stack off the bottom edge and four captions silently vanished. Text
outside the viewBox looks like missing data, not overflow.

`+7` after a distance means seven more nodes sit under that dot. The count is the
server's — a cluster never quietly hides its members.

### Node colour — class from the server, swatch from `C_CLS`

`meshLinks().nodes` arrives pre-classified (`relay` / `endpoint` / `seen`) with a
`weight`. This maps class → fill and weight → radius, and nothing more.

```
relay     oklch(var(--a))        radius 3.5 + weight * 8
endpoint  oklch(var(--p))        radius 3.5
seen      oklch(var(--bc)/0.35)  radius 3.5, opacity 0.5
```

The legend swatches in `tab-observatory.html` use `bg-accent` / `bg-primary` /
`bg-base-content/30` — **these must stay in step with `C_CLS`**. They are Tailwind
classes on real elements, which do compile; the SVG fills cannot be, for the
reason above.

Drawn lightest-weight first so the heavy doors land on top rather than being
buried under the specks.

There is a fallback path for a payload with no `nodes[]` — an older server still
gets a drawn map instead of a blank panel.

### `obsNodeCount()` counts what is on screen, and says so

It describes the list being rendered, not a fact about the mesh. A mesh-wide
count would be a derived claim and belongs to the server — which is why the UI
labels it "on screen".

## Invariants

- No fetch. Ever.
- Nothing derived that the server could compute.
- A missing value renders as an em dash, never as a zero or a guess.

## Test notes

Live at 1600×1000, all four sub-tabs, both themes, 0 console errors, 2026-08-02.
`ARW1` rendered at 4 hops, −115 dBm, bearing 119° — a distant relayed node with
a bearing, the population that had none before this work.

Map, same session: 220 links drawn, ten captions, all inside the panel in light
and dark. `St. Pierre du Bois 182km +7` is the whole Guernsey cluster under one
label; `?2A0 189km` is the furthest node still waiting on the geocode backfill
and correctly shows its callsign rather than an invented place.

## Out of scope

- Any derivation the server should own.
- The panels still awaiting a feed — they render an empty state naming the phase
  that fills them.
