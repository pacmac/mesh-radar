---
module: tab-observatory
source: public/partials/tab-observatory.html
source_hash: 46a7346bebe9a33f211780e63b3ca635b672bae2d054df8846e98d4fb58c7e85
updated: 2026-08-02
---

# Module: tab-observatory

## Purpose

The Observatory page — main menu, below Radar. Renders `observatoryMixin`
(`docs/modules/app-observatory.md`). Presentation only.

Peter, 2026-08-02: *"a new page in the main menu, below radar, so that I can see
the page growing with live data as it is added"*, and on watching me read numbers
out of a terminal: *"you can see data, I see nothing at all."*

## Built whole, populated only by real data

Peter: *"create the page and all of it's elements, but dont populate the data
with dummy data, so that I can see more and more real data appearing as the
feeds develop"* and *"so many fields or lists or tables would be empty now and
only those that are live data are populated."*

So **every panel is present and correctly shaped from the start**, and a panel
with no feed says exactly what it is waiting for and names the phase that
supplies it. No placeholder numbers, no fake rows, nothing that could be
mistaken for a measurement. As each phase lands its panel fills and **nothing
moves**.

| panel | today |
|---|---|
| Furthest verified reach | awaiting the reach model |
| Doors | **live** — `relay.usage` |
| Bearings recorded / Nodes seen | **live**, on screen |
| Radar | awaiting the reach model |
| Map | awaiting the relay graph |
| Missions | awaiting the scheduler (blocked on spec §9) |
| Record ladder | awaiting the reach model |
| Receptions | **live** |

## Sub-tabs

Peter: *"maybe we need a main menu and sub menus for this? … that way debug sub
pages can be added and we still have the main nasa dashboard."*

**Board** is the dashboard. **Receptions** is the raw feed on its own page. The
first version had them sharing one screen, which meant the board could never stay
clean and every future diagnostic would have cost it space. Adding the tenth
debug view now costs the board nothing.

Same `tabs tabs-bordered` shape as `tab-cfg.html` / `tab-control.html`.

## Design reference

`public/_mockup-mission-control.html`, served at
`http://192.168.10.205:8000/_mockup-mission-control.html` — **frozen**. Peter,
twice: *"keep the static page as a reference, do not delete it"*, *"this page
must stay… it is a reference and is stand alone."*

The live page is built by **copying** it, never by editing it. The reference is
never wired to data, never re-pointed, never overwritten by what derives from it
— that freeze is what lets the shipped page be diffed against the agreed design.

## Honesty rules on this page

- **A bearing renders as an em dash when absent, never as 0.** North is a real
  bearing; a blank must not read as one.
- **Relayed packets are shown, not filtered.** The distant nodes worth locating
  are exactly the ones that arrive via relays.
- **The bearing column tints rows rather than filtering them** — hiding the
  bearing-less majority would hide how much traffic carries no bearing, which is
  itself worth seeing.
- **Empty panels say "waiting for a feed, not for data."**
- Counts labelled "on screen" are the rendered list, not a claim about the mesh.

## Invariants

- Nothing fetched. Everything arrives over the WS.
- No panel invents a value to look populated.
- Relay labels come from the server (`relay_usage.label`), never a browser
  lookup — `this.nodes` is filtered and produced raw numbers.

## Test notes

Live at 1600×1000, both sub-tabs, both themes, 0 console errors, 2026-08-02.
Doors rendered `T4 / fir / TE 5 / S2 / TivN` with targets-behind and
traffic-carried; the outbound-only subset of those figures reproduces the
hand-computed values from the same evening exactly.

## Out of scope

- Any derived value the server should own.
- The panels awaiting a feed — each fills in its own task.
