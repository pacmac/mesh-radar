---
module: tab-observatory
source: public/partials/tab-observatory.html
source_hash: 1899bfc726992ee8b5e155a39cbf11766490caa15f362d4e89a450180701c743
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
| Furthest verified reach | **live** — `reach.ladder` |
| Doors | **live** — `relay.usage` |
| Bearings recorded / Nodes seen | **live**, on screen |
| Radar | **live** — `reach.target`, full page |
| Map | **live** — `link.observed`, full page, classified and named |
| Missions | **live** — `reach.mission`, ranked and explained |
| Record ladder | **live** — `reach.ladder` |
| Receptions | **live** |

### Missions panel

Rows come ranked, classified and explained. The page renders the server's
`reason` string verbatim — **it must never assemble an explanation out of
numbers** — and colours the class dot: `bg-accent` for `unknown-record`,
`bg-primary` for `record`, `bg-secondary` for `unknown`, muted for `reconfirm`.

The header carries the published exclusions (`19 of 227 candidates · 7 cooling ·
22 exhausted`), and the footnote states plainly that **nothing is dispatched from
this panel**: traceroute dispatch already exists elsewhere and is what the list
is for; the broadcast callout remains unbuilt.

Scrolls at `max-h-80` — verified 853 px of content in a 340 px box, scrolled to
the bottom, all four classes reachable.

### The feed summary line

`obsFeedSummary()` reports rows on screen and how many carry a bearing. Counting
the *rendered list* is expressly allowed — it describes what is on screen, not a
claim about the mesh.

### Map legend

Three swatches, shown only when their count is non-zero, driven by
`meshLinks().legend`. The page counts nothing and names no class — it picks a
swatch colour per class, and those colours **must stay in step with `C_CLS` in
`app-observatory.js`**. Legend swatches are Tailwind classes on real elements, so
they compile; the SVG fills cannot be and use DaisyUI variables instead.

The caption under the map explains the two size encodings — relay radius is
traffic carried, line weight is how often that hop was witnessed — because a
size difference with no stated meaning is decoration.

## Discovery panel — full width, at the top

Peter, 2026-08-02: *"I still see no signs of activity on the dashboard, as far as
I can see it is static"*, then on finding it: *"the discovery card should be
above missions, i.e. at the top"* and *"well if it's there it's not very
obvious."*

All three were the same fault. The panel was working — 23 attempts, 22 completed,
a mission in flight — but it sat **third in the right-hand column, below the
fold**, while the left column ended at the Frontier table and left half the board
empty. The one thing on the page that is happening *right now* required
scrolling to find.

It is now full width, directly under the stat row, above everything. The status
is a badge with a pulsing dot rather than grey micro-text, and the header carries
`24 tried · 0 answered` so the counters move where they can be seen.

If a glance cannot tell you whether the mesh is being probed, the panel has
failed at its only job.

## Discovery panel

Peter, 2026-08-02: *"what I expect to see is a table of the discovery mission,
i.e what it's done, doing right now and whether a discovery is in progress."*

Three parts, in that order:

1. **Status line** — `IN PROGRESS`, `idle · 1 every 3 min · 18 queued`, `HELD —
   automatic traceroute is off`, or `stopped`. The panel explains itself when
   nothing is moving, which is what an empty table never does.
2. **In progress** — the single target being pursued, with the radio, the place,
   the distance and the mission's reason.
3. **Done** — newest first, and the last column is **what it revealed**, not
   hit/miss. A reply reports hops out and back plus new relays, new links and
   return-only hops; a miss reports `no reply after 90s`, because §4 says silence
   is evidence and a feed showing only successes would misrepresent it as absence
   of attempt.

Above the table, a discovery tally: attempts, replies, new relays, new links,
records. The point is watching the web grow, not a hit counter.

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
- **There is no arrival-path column, and there must not be one.** MQTT arrivals
  never enter the store (spec §3a) — they are dropped at the mapper — so every
  row on this page was heard on air by construction. A column reporting that
  would always say the same thing.
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
