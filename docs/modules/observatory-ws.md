---
module: observatory-ws
source: src/observatory-ws.js
source_hash: 60531ca149a301c090b7522a98738c73117ff93dc7e11b7bfc5247749dc95059
updated: 2026-08-04
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

## It drives the actuator

`recompute()` hands the shortlist to `missionRunner.setQueue()` and seeds it with
what was already known, so the first route does not report the whole existing
mesh as newly discovered. The runner never fetches — this file is already an
allowed importer of the engine and `mission-runner.js` deliberately is not, so
the coupling lives here.

`missionRunner.on('activity')` is broadcast as `mission_activity` **on every
state change**, not on the 15-minute recompute: the panel has to show a discovery
while it is in progress, which is the whole point of it.

The runner starts 20 s after boot, once the first recompute has had a chance to
fill its queue.

## BROWSER_CONTRACT

This is **raw observation data**, not display values. Anything the page needs
*formatted* — relative ages, labels, counts — is a server-computed field and must
be added here, never derived in the browser.

## `charts.bands` — rate per day, split by distance band

Task `rate-by-band-by-day`. Fifth series in `charts()`, in its own try/catch like the
other four, riding the existing `{type:'charts'}` broadcast on connect and after each
recompute. No new transport.

It exists because the aggregate `daily` series cannot distinguish a change in TARGET MIX
from a change in PERFORMANCE. That ambiguity concealed a fall from ~58% to ~7% in the
answer rate to nodes within 25 km over three weeks, while the 100+ km band sat at 0-4%
and never moved — a rig regression that looked like a targeting question.

Data comes from `db.rateByBandByDay(30)`; this module only assembles and broadcasts, per
the rule that display aggregation belongs in the display feed rather than the inference
catalogue.

## One window for every series

Task `observatory-window`. `charts()` reads `observatory.window_days` once and passes it
to all four series, then publishes `window_days`, `window_best_km` and `window_answered`
alongside them.

The window is SERVER state. Peter, 2026-08-03: *"the browser is a presentation layer ONLY,
this filtering must be done backend so anyone using the browser sees the same thing."* The
browser PUTs the config key and re-renders from the broadcast; it holds no window of its
own, so two viewers can never see different figures.

`record_km` stays all-time and `window_best_km` is windowed. They answer different
questions and both are published.

### Why it subscribes to `registerSettingsListener`

The recompute timer is `discovery.recompute_min`, default **15 minutes**. A control whose
effect appears a quarter of an hour later is not a control, so this module refreshes its
own `charts` message when core announces a settings write.

Core announces generically and names no plugin — `config-api.js` must not import this
file. The broadcast function is captured from the first `registerWsWiring` hook rather
than passed in, because the listener fires outside wiring.

## `charts.failure_epoch`

Published so a later Domain 2 task can mark the censoring boundary on screen. Rates before
it are already suppressed in `db.js` — this field is for the label, not the filtering.

## `event_log` and the enumerable pipeline

Task `logs-feed`.

On connect: `{type:'event_log', events, hooks}` — the last 300 rows **and the declared
pipeline**. `hooks` is the answer to *"what does this system execute, in order, and what
does each step claim to do?"* served rather than inferred, so the page never guesses and
nobody reads code to find out.

Live: `{type:'event', event}` pushed per emission via `onEvent()` in `hooks.js`, announced
**after** the row is written so a listener never sees an event the database lacks. That is
what makes the page a feed rather than a report — the 15-minute recompute is far too slow
to feel alive.

`charts.interventions` carries `config`/`deploy`/`mode` events inside the window, so the
board can mark them on the traces: *"yield fell after we changed X"* becomes visible rather
than remembered.

Core announces and the plugin subscribes — `hooks.js` names no consumer, the same boundary
rule as `registerSettingsListener`.

Verified 2026-08-03: 33 events and 9 hooks replayed on connect, 13 interventions in window,
and a live `unknown-nodes` finding arriving mid-session.

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

## Window default corrected to 7 (task `frontier-strip-payload`, 2026-08-03)

`getConfig('observatory.window_days', 30)` defaulted to **30** while the stored
value was **7**, and `boardVerdicts(days = 30)` did the same. A missing key would
therefore have silently re-based every board figure onto a 30-day window with
nothing on screen saying so — the silent-default class of B74.

Both defaults are now **7**, and `window_days` is published on `board.frontier`
so the basis is visible to the reader instead of assumed. `0` means all time.

## Answer-rate verdict served (task `verdict-strings-to-backend`, 2026-08-04)

`app-observatory.js:300,307` divided `answers/attempts` itself and then applied
`>=15 / >=5` to choose a bar colour — a judgement about discovery **yield**,
made in the presentation layer.

`withRateVerdict()` now serves both halves on every `silence` and `distance`
row: `rate_pct` (the division) and `tone` (the band). Serving only the tone
would have left half the decision in the browser.

| rate | tone |
|---|---|
| ≥15% | success |
| ≥5% | warning |
| ≥0% | error |
| **0 attempts** | **muted**, `rate_pct: null` |

**Zero attempts is not a zero rate.** It is no data and must not paint red — the
same distinction `signal-verdict.js` draws with `none`.

### Why this is not in `signal-verdict.js`

That module judges how good a **link** is. An answer rate is a different kind of
fact with a different owner, and this chart builder is its only consumer. One
owner each is what SSOT requires; a single module holding every band table in
the app would just be a dumping ground.

## The board's node table (task `board-node-table`, 2026-08-04)

Peter, 2026-08-04:

> we should still summarise / use the data from nodes in node-dash as a quick way
> to see what nodes we have so we dont have to switch screens ... show the top n
> nodes in a table, which consumes less space than node cards would

> what you are doing via code is exactly what's needed on the new top n nodes
> table, the ability to analyse, traceroute it etc

`nodeTable()` sits beside `relayUsage()`, `reachModel()` and `missions()` — the
same shape, the same rules — and is served as `charts.nodes`.

### What it is for

The STATE band of `docs/APP_ROLE.md`: node-dash's own data, summarised, as
**context** — explicitly not a score. It exists so the operator does not switch
screens, and so a lead can be acted on where it is seen.

### Rows

Live **and** placed — `last_heard` within the window and a usable position —
sorted **furthest first**, limited to `limit` (default 15).

Furthest-first, not lead-ranked, is a deliberate first cut: the eye reads the
edge, which is where the work is. Lead-ranking (a router past the envelope
outranking a plain node further out) is a later option and is noted as unsettled.

### Every field decided here

`BROWSER_CONTRACT`, and the session that removed every threshold from `public/`
finished hours before this was written — it must not regress.

| field | notes |
|---|---|
| `num`, `label` | `resolveNodeLabel`, falling back to `!hhhh` |
| `km`, `az` | from home; the browser computes neither |
| `place` | `shortPlace(getCachedGeocode(...))`, null when not yet geocoded |
| `role`, `role_tone` | raw role plus its tone. `CLIENT_MUTE` is called out — it can never be a door |
| `hops` | `hops_display` — verified relay count preferred over reported |
| `heard_sec`, `heard`, `heard_tone` | age, formatted string, and tone — all served |
| `snr`, `snr_tone` | quarter-dB already decoded at ingest (`src/snr.js`) |
| `probes`, `answered` | traceroute attempts and successes, all time |
| `evidence` | `packet` when `relay_observation`/`messages`/`signal_history` holds a row; `nodedb` when the position is all we have |
| `lead`, `lead_reason` | **the judgement** — see below |

### What makes a row a LEAD

A node is a lead when it is **past the envelope, alive, and unworked**:

- `km` > the current record, and
- heard within the window, and
- `probes` is 0 or small

`lead_reason` is a **server-written sentence**. The page must never assemble an
explanation out of numbers — the same rule the mission table already follows.

`CLIENT_MUTE` is never a lead in the door sense; it can still be a destination,
so it is shown, tagged, and excluded from door reasoning.

### Actions the row offers, and what already exists

| action | endpoint | status |
|---|---|---|
| `pin` | `PUT /config/discovery {pinned}` | **exists** — bypasses ceiling, silence and window (`inferences.js:768/786/819`), keeps the cooldown |
| `star` | `PUT /nodes/:num/obs_target` | **exists** — same three bypasses |
| `probe` | dispatch now | Domain 1, later task |
| `analyse` | the dossier | Domain 1, later task — read-only |

Serving the rows is this task. The actions are Domain 2 plus the two endpoints
that already exist; `probe` and `analyse` are separate and come after.

### Out of scope

- Rendering (Domain 2).
- The CONTRIBUTION band — it needs the attribution ledger, which does not exist.
- Any change to targeting. The table exposes the selector's behaviour; it does
  not alter it.

### Verified

Live over WS after restart, 2026-08-04:

```
rows 15 | limit 15 | window 7d | record 189.1 km
?7A8  308.6  26h  muted    dim   packet   0 probes  LEAD
?47C  285.8   4h  success  dim   packet   0 probes  LEAD
JRSY  218.6  13h  success  gold  packet   4 probes
f3ed  206.8       muted    muted can_be_door=false  lead=false
```

10 leads found. Bearings 15/15, places 15/15, `CLIENT_MUTE` correctly
non-door and non-lead. Other `charts` keys unaffected — board verdicts,
silence (4), distance (10), ladder (8) all still served.

Example served `lead_reason`, written server-side as a sentence:

> 308.6 km is 119 km past the record, heard 26h ago, and has never been probed
> — we hold real packets from it

**A defect caught in Phase 4 and fixed before commit.** The first cut used
`heardTone()`, whose 30-minute / 1-hour bands answer *"is this node active right
now"* for the node list. Here the window is 7 days and the question is *"is it
alive at all"*, so **every row past an hour came back `error`** — an all-red
column carrying no information. Switched to `sinceTone()`, the same scale the
mission and relay tables already use for the same question. One concept, one
table — which is the rule the verdict work spent the day establishing, breached
within an hour of finishing it.
