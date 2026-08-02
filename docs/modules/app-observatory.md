---
module: app-observatory
source: public/app-observatory.js
source_hash: 91436b7d9e82b43799fa4358a72d0bb22f9f81ac5b15cbcb06c02a2972271c77
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
| `obsTab` | `'board'` \| `'receptions'`, persisted, declared in `app.js` |

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
```

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

### `obsNodeCount()` counts what is on screen, and says so

It describes the list being rendered, not a fact about the mesh. A mesh-wide
count would be a derived claim and belongs to the server — which is why the UI
labels it "on screen".

## Invariants

- No fetch. Ever.
- Nothing derived that the server could compute.
- A missing value renders as an em dash, never as a zero or a guess.

## Test notes

Live at 1600×1000, both sub-tabs, both themes, 0 console errors, 2026-08-02.
`ARW1` rendered at 4 hops, −115 dBm, bearing 119° — a distant relayed node with
a bearing, the population that had none before this work.

## Out of scope

- Any derivation the server should own.
- The panels still awaiting a feed — they render an empty state naming the phase
  that fills them.
