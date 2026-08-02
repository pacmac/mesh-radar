---
module: observatory-ws
source: src/observatory-ws.js
source_hash: 3b2e25b04c107f8d1e5c0723c3981fe13e11f071663295aec62c863d9651306b
updated: 2026-08-02
---

# Module: observatory-ws

## Purpose

Pushes each observation to the browser as it is recorded, and replays the recent
past to every new connection. **Plugin wiring, not core.**

Peter, 2026-08-02: *"a new page in the main menu, below radar, so that I can see
the page growing with live data as it is added"* and, on watching me read numbers
out of a terminal, *"you can see data, I see nothing at all."*

## Why it is a separate file

Identical reasoning to `alarm-ws.js`. `src/ws-relay.js` is core — it serves the
WS for every page — and must not name a plugin. This file knows the observatory;
core does not know this file. Delete it and its one import in `index.js` and core
is unchanged. Verified: `grep -c observatory src/ws-relay.js` → **0**.

**It is the third file permitted to import `observatory.js`**, and that is a
decision rather than a boundary slipping. The rule the test encodes is *core must
not reach into the engine*. This is a plugin — the engine's own WS wiring, as
`alarm-ws.js` is the alarm's. The allowlist names it explicitly so a fourth entry
is again a visible choice.

## Messages

| type | when | payload |
|---|---|---|
| `observations_replay` | every new connection | `observations[]`, newest first, ≤ 200 |
| `observation` | each write | one `observation` |
| `relay_usage` | connect, and after each recompute | `relays[]` — the doors, heaviest first |
| `reach_model` | connect, and after each recompute | `reach` — record, ladder, frontier, plot |
| `mesh_links` | connect, and after each recompute | `links` — `{ total, links[], marks[], nodes[], legend[] }` |
| `missions` | connect, and after each recompute | `missions` — `{ missions[], summary }` |

```
{ id, ts, kind, entity, source, data:{ rx_device, az, beam_deg, rssi, snr, hops, portnum, packet_id } }
```

Recompute is deferred 10 s past boot and then runs every 15 minutes. The three
model messages are pure reads of stored facts — the inference has already run, so
a page load never triggers a computation.

`data` is **re-parsed** before sending — the browser must never be handed
JSON-inside-JSON to unpick. A parse failure yields `null` rather than throwing;
one malformed payload must not stop the feed.

### Why replay exists

On a quiet channel a page that waits for the next packet shows nothing for
minutes and reads as broken. A new connection opens with the recent past already
on screen and grows from there. An empty array is the same code path as "plugin
not installed", so a page with no observations and a node-dash without the
observatory behave identically.

## Map marks — one label per cluster, named by town

`meshLinks().marks` is what the map captions. Everything about it is decided
here, because *which corridor is worth naming*, *what it is called*, and *how many
nodes hide behind a dot* are all decisions, and the browser makes none
(BROWSER_CONTRACT).

**Outliers only** (> 90 km). The near cluster is where we live and needs no
caption; the point of the map is the reach.

**One label per cluster, not per node.** Greedy outward from the furthest: the
first node in a neighbourhood names it, every later node within `CLUSTER_KM`
(15 km) only raises its `nodes` count. Naming nodes instead printed six Guernsey
street addresses stacked on top of one another — six ways of saying "Guernsey",
and one unreadable smudge. Fifteen kilometres is a map-legibility figure, not a
mesh one: it is roughly where two dots stop being separable at this zoom.

**`placeName()`, not `shortPlace()`.** Nominatim returns

```
Alexandra Road, St. Ives, TR26 2ET, Cornwall, United Kingdom
Rue des Prés,   St. Pierre du Bois, GY7 9RZ, Guernsey
Horeb,          SA44 4ND, Ceredigion, United Kingdom
```

— the same shape with a different number of parts, so any fixed index picks the
street in one address and the county in another. Counted from the **end**
instead: the last surviving part is always the region (Cornwall, Guernsey,
Ceredigion) and the one before it is the town. `United Kingdom` is dropped —
identical for every node here — but Guernsey and Jersey are **not**, because
there the country *is* the location. Postcode-ish tokens (contain a digit,
≤ 9 chars) are filtered first. Verified against every geocoded outlier in the
cache: St. Ives, Torteval, Wychavon, St Peter Port, Nanpean, Horeb, Efailwen.

Falls back to `resolveNodeLabel()` and then the raw num — never a placeholder, so
a node the backfill has not reached yet shows its callsign rather than a lie.

## Missions

`missions()` reads the `reach.mission` facts, resolves labels and places, and
splits the `global` summary row out of the list. **It ranks nothing and writes no
reasons** — both are the inference's (`docs/modules/inferences.md`), because a
mission's justification is a decision and the reason string is a display value.

The summary is passed through rather than filtered away: its candidate / cooling
/ suspect / exhausted counts are what stop a shortlist reading as *"these are the
only options"*.

Nothing here dispatches. Selection and sending are separate concerns and this
file does neither — it forwards a list.

## Map nodes — classified here, painted there

Peter, 2026-08-02: *"we need some node plot point colour differences so we can
more easily read the map and what it's telling us."* The map was drawing 92
identical grey dots: it showed where the mesh is and nothing about what any of it
does for us.

Classification is a decision, so `meshLinks().nodes` carries it and the browser
maps a class name to a fill (BROWSER_CONTRACT).

| class | meaning | count |
|---|---|---|
| `relay` | has carried our traffic — a door | 57 |
| `endpoint` | route verified, but nothing has ever relayed through it | 35 |
| `seen` | on the map only through someone else's route | 0 |

**`seen` being zero is expected, not a bug.** `link.observed` is built *from* our
own traceroute routes, so every endpoint on the map is by definition in a route
we obtained. The class exists because the moment a second evidence source lands —
passive `relay_node` capture, §7b — it starts filling, and a map that silently
reclassified those as `endpoint` would be claiming verification it never had.

`weight` is a door's share of relayed traffic, `log1p(uses) / log1p(maxUses)`.
**Log, not linear**, and that matters at this spread: the busiest relay carried
4,434 hops and the quietest carried one. Linear would draw a single enormous dot
and ninety-one specks; log puts `T4` at 1.00, `fir` at 0.91, `TE 5` at 0.87 —
one or two rungs apart, which is what they actually are.

`legend[]` ships the class names and counts so the page never counts anything.

### What it showed immediately

The relay mass is **local** and the distant reach is **all leaves**: nothing
beyond about 50 km has ever relayed for us. The far corridors are single shots
through nearby doors, not a distant network we are part of. That is a fact about
the frontier the map could not express before it had colour.

## BROWSER_CONTRACT

This is **raw observation data**, not display values. Anything the page needs
*formatted* — relative ages, labels, counts — is a server-computed field and must
be added here, never derived in the browser.

## Invariants

- Core (`ws-relay.js`) never names the observatory.
- Both the broadcast and the replay are wrapped. The broadcast runs inside
  `observe()` → `handlePacket()`, the hot path for every packet: a dead socket
  must not reach packet ingestion.
- Replay is capped and newest-first.

## Test notes

Live against a real WS client, 2026-08-02 09:11–09:13:

```
REPLAY on connect: 200 observations, 20 carrying a bearing
LIVE  09:12:25  node 862529744  radio E9:B0:3F  az null  rssi -115  hops 3
LIVE  09:12:25  node 862529744  radio F4:12:FA  az 119   rssi -112  hops 3
```

The same packet through both radios, one with a bearing and one without — and at
**3 hops**, which is the distant relayed population `signal_history` discards.
Boundary test passes with the three-file allowlist; `ws-relay.js` names the
observatory zero times.

Marks, live over the WS after clustering (2026-08-02, 220 links):

```
189 km  x1  ?2A0                 (no geocode yet — backfill still running)
188 km  x1  St. Ives
182 km  x8  St. Pierre du Bois   ← the whole Guernsey cluster, one label
159 km  x1  Wychavon
143 km  x1  Horeb
142 km  x1  Efailwen
140 km  x2  Nanpean
126 km  x1  St Kew
100 km  x1  Bournemouth
 95 km  x3  Swanage
```

Fourteen marks became ten, and the six overprinted street names became one
island. Rendered and screenshot-checked at 1600×1000 in both themes, 0 console
errors.

## Out of scope

- The page itself — Domain 2, its own task.
- Any derived or formatted value. This module forwards what was recorded.
