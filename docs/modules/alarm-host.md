---
module: alarm-host
source: src/alarm-host.js
source_hash: fc67d7439f9693837cacf2d51bef469650e59f51304a54e63f5d28831528f541
updated: 2026-08-13
---

# Module: alarm-host

## Purpose

The **one** boundary between node-dash and the mt-alarm bridge on `:8790`. Replaces
`pac-host.js`, whose service was stopped under pm2 at 09:35Z on 2026-08-12 and will
not return on a reboot.

Everything bridge-shaped lives in this file. No other module branches on the
bridge's types, fields, or message shapes — they call the small surface exported
here. That was true of `pac-host.js` and is the only reason this migration is one
module rather than fourteen.

## Why the rename, and why not `bridge-*`

`pac-host.js` pointing at a service called the bridge would be a lie in a filename,
and the next session pays for it.

**`bridge-` was rejected because it is already taken.** `src/bridge-events.js` is
mesh-gw's event bridge — a different thing entirely, on a different host, older.
Two unrelated "bridges" in one `src/` is worse than the stale name it replaces.

`alarm-host` names what it is: the boundary to the alarm estate's host. Every
importer is already `alarm-*` (`alarm-ws`, `alarm-images`, `alarm-sections`,
`alarm-browser`, `alarm-image-api`).

## The outage this exists because of

Measured, not remembered:

- 1568 failed fetches between 09:35:27Z and 09:35:35Z
- `_poll()` caught, set `available:false`, emptied `_units`, and every downstream
  poll then returned early
- logs go **silent** at 09:35:35 and stayed silent for five hours

Nothing crashed. Nothing errored. Six panels rendered **nothing**, which is
identical on screen to "this unit has nothing to say". That is the defect worth
designing against, and it is why the section contract below is not optional
polish.

## THE SECTION CONTRACT — the reason to migrate, above any route

`GET /dash` returns a `sections` map. Every panel appears **whether or not anything
can fill it**, and one that cannot names a reason and an owner:

```
units    ok    bridge GET /state
commands ok    bridge POST /queue
outbox   gap   device    no route lists commands sent and their outcome
obs      gap   plugins   no series store; the record plugin is unbuilt
images   gap   undecided chunks are classified and logged, nothing reassembles them
align    gap   undecided ownership parked by Peter 2026-08-12 (park-align-ownership)
config   gap   device    NOT CONSUMED HERE — zero call sites, droppable
diag     gap   device    NOT CONSUMED HERE — zero call sites, droppable
```

**A gap is served to the browser as text, never as absence.** The Camera panel
must read *"unavailable: nothing reassembles chunks yet — device"*, not spin and
not blank. A section is never omitted; omission is how a gap becomes invisible,
which is precisely what happened this morning.

When an upstream gap closes, the entry changes on their side and the panel fills
**with no deploy here**.

## Migrating restores TWO of six panels, and the spec says so out loud

| node-dash panel | bridge section | after migration |
|---|---|---|
| unit roster / reachability | `units` | **fills** |
| command buttons | `commands` | **fills** |
| queue ledger | `outbox` | still empty — device owns it |
| Camera | `images` | still empty — undecided |
| coulomb / Stats | `obs` | still empty — plugins, unbuilt |
| Yagi Align | `align` | still empty — parked |

Anyone reading this expecting the alarm pages to come back whole should stop here.
They do not, and no work in this repo makes them.

## Link freshness — the page must be able to tell STALE from QUIET

Peter, 2026-08-13: *"because I cannot rely on the dashboard, I have to repeatedly
ask questions to the agent about the status of the device, when it was last
heard, is its beat on schedule. I am doing this constantly because it is NOT
available to me and/or I cannot trust it."*

**The verdict cannot ride the feed.** `servedAt` refreshes on every `/state` push
and proves the bridge is still *building* bodies — but when it stops serving, no
push arrives to carry the word "stale". The state that matters most is precisely
the one nothing will tell us about. So freshness is derived from **silence**, on
our own clock, and it is the one thing in this module that must keep working when
every socket has gone quiet.

### Served on `pac_host_status.link`

```
fresh     true | false | null      null = unknown, NOT "stale"
servedAt  epoch ms | null          the bridge's own build instant
label     "last state body 1m ago" | null    rendered HERE, never in the browser
why       null | "no state body received yet"
                | "tick clock unknown — silence cannot be judged"
```

`label` is null while fresh: there is nothing to say about a link that works.
`why` exists so a page never has to guess what an absence means — "not connected
yet" and "connected but unjudgeable" are different situations and must not render
identically. **The browser renders `label` and decides nothing** —
`docs/BROWSER_CONTRACT.md`.

### A verdict, not an age — and why that distinction is the whole design

Serving *"served N seconds ago"* continuously would re-render every second
(`fmtAgo` ticks per second under a minute, `format.js:95`), which against a 10 s
feed is a **1 Hz broadcast of the whole status payload** — a poll wearing a
push's clothes, the exact thing `served-time.js` exists to kill.

Instead: **one timer, armed for the instant the verdict flips**, re-armed by every
`/state` push. While the bridge is healthy that timer is always in the future and
always cancelled before it fires, so freshness costs *nothing*. Measured over 32 s
on a healthy link: 27 status pushes, **one** distinct link state.

Once it has fired, `scheduleTime` takes over so the outage is visibly growing —
one wake per rendered change, and only while broken. That is ~1 push/s for the
first minute of an outage, then per-minute. Accepted deliberately: during an
outage a counter that moves is the point, and it stops mattering the moment the
link returns.

The threshold is `silenceMs()` — `MISSED_TICKS × feedTickMs`, read from the wire.
**When the tick clock is unknown or OFF, the verdict is `null`, never `false`.**
A "stale" badge raised against a guessed threshold would be wrong on a bridge
behaving exactly as configured, and would train the reader to ignore the true one.

### Proven by breaking it

The flip was measured end to end by making `_onState` deaf after one body,
restarting, and watching the browser feed with nothing arriving:

```
t=44.3s  fresh=false  label="bridge silent 50s ago"   <- first draft's wording
t=54.9s  fresh=false  label="bridge silent 1m ago"
```

Then the deafness was reverted and recovery confirmed: 27 pushes over 32 s, all
`fresh=true`, one distinct state.

That run also caught the wording. `fmtAgo` renders an **age** — "50s ago" — so
*"bridge silent 50s ago"* says the silence *happened* 50 s ago rather than that it
has *lasted* 50 s. Now `last state body 50s ago`, which is about the instant
`fmtAgo` is actually describing.

**Not yet proven the honest way**: a real wedged bridge — socket up, frames
swallowed — was not used, because that means interfering with a peer's running
service. A local stall-proxy was built for it and works, but node-dash could not
be repointed at it: `pm2 restart --update-env` does not inject `ALARM_HOST_URL`
and `ecosystem.config.cjs` declares no such key, so the end-to-end path exercised
here is the deaf-handler one above.

## This module does not touch the dash mode — 2026-08-13

**PASV / ACTV / SCAN are radar concepts. The alarm has no relationship to them.**

Peter: *"PASV/ACTV etc have nothing whatsoever to do with alarm, they are
functions of the radar and the probing of the mesh to reach as far as possible.
There is NO link between that whatsoever. The ONLY common factor is MY RADIOS
(OMNI and RAK) and the rotator. They are 2 entirely different things and there is
nothing one offers to the other."*

Until 2026-08-13 `applyAlignModel()` saved `dashMode.value`, forced PASV for the
duration of an align session and restored the mode on stop. Deleted, with the
import and the saved-mode variable (ledger `B112`).

**This is not migration preparation and does not depend on one.** Peter, while it
was being implemented: *"it makes no diff if alarms is moved to a new server or
not, there is still no relationship between radar modes and alarm."* The
possibility of the alarm moving out is why the coupling was noticed; it is not
why it is being removed. If the alarm never moves, the interlock is still wrong.

Two further reasons it had to go:

- it is the **2026-08-06 rule broken from the plugin's end** — *modes use the
  pointer, they must not control or gate it* (task `mode-must-not-control-aim`);
- it had been **unreachable** since the bridge migration, because the guard on
  the function's first line returns while section `align` is a gap. Dead code
  asserting a relationship that does not exist is worse than live wrong code —
  nothing will ever contradict it.

**The underlying need is real and is not a mode.** mt-transport's point stands:
*"if the Yagi moves during a burst, the readings are silently wrong rather than
obviously broken, which is the worst kind of wrong."* What that calls for is a
**hold on the beam for a stated duration**, owned by the rotator, which is shared
hardware with several users including the garage alarm — a lease with a timeout,
not a mode change, and not something a plugin reaches across the repo to perform.

## Meshtastic is these units' TRANSPORT, not their application

`docs/ALARM_TRANSPORT_BOUNDARY.md` — **mandatory before changing anything in this
module.** The units run 100% custom firmware. They appear in the node list, the
radar and signal history because our radios hear them, and at that layer they are
ordinary nodes — but no inference about what they DO may be drawn from Meshtastic
semantics. The `alarm` class on portnum 260 is a port classification and not a
motion event; that mistake paged a peer 21 times in 40 minutes.

## Identity: the bridge speaks `!hex` ONLY

`GET /dash` unit keys, measured 2026-08-12: `unit, heardAt, rssi, snr, radios,
beat, win`. **There is no node num anywhere on the bridge.**

node-dash's core speaks node nums (`unitForNum(num)`, `unitNums()`, and every
`node_status` caller). The conversion is mechanical — `!hex` IS the num in hex,
`!987ab80f` → 2558179343 — and `src/node-label.js:55` already does it.

**The conversion happens once, here, at this boundary.** No caller outside this
file converts, and `unitForNum`/`unitNums` keep their existing num-based
signatures so the thirteen importers do not change.

Short names do not resolve on the bridge, the same as pac-host. Full `!id` always.

## Path or query is NOT uniform — and the wrong form returns 200

Measured live 15:02Z, `!987ab80f` percent-encoded:

```
GET /state/%21987ab80f       200   {unit, schedule, comms, link…}  ONE unit
GET /state?unit=%21987ab80f  200   {!987ab80f, !8cee336b}          EVERY unit
GET /state                   200   {!987ab80f, !8cee336b}          identical
GET /dash/unit?unit=%21…     200   {unit, state…}                  ONE unit
GET /dash/unit/%21987ab80f   404
```

**device's core routes take a PATH param. plugins' routes take a QUERY param.**
plugins' written guidance — *"there are no path parameters anywhere, every
`/thing/:target` becomes `/thing?unit=`"* — is correct for their own routes and
wrong for device's.

The dangerous half is line 2: `/state?unit=` does not 404 and does not error. It
returns 200 with a well-formed body that is **every unit rather than the one asked
for**. A client written to the guidance reads one unit's schedule as another's, and
the two live units are on 60 s and 300 s beats, so a staleness indicator would be
confidently wrong rather than blank.

**CONFIRMED AND CLOSED**, `[path-or-query-8790]`, 2026-08-12. plugins withdrew the
guidance with file and line: `device/bridge/src/api.js:120` is `path === '/state'`,
but `:122` is `path.startsWith('/state/')` and `:172` the same for `DELETE /queue/`.
The `===` is real but lives only in the **plugin dispatch loop**
(`path !== r.path`), which was the code they had read. Device's core routes take
path parameters.

The silent-ignore is mechanical: `path` is `url.pathname`, so a query string is
never part of the comparison. Nothing looks at the query, so nothing rejects it.
Whether `/state?unit=` should 400 is device's call and is with them.

Each call site here names which convention it uses. `/dash/unit?unit=<id>` also
returns the whole `state` object, so it is a route around the question — not taken,
since the question now has an answer.

## Two fields to take from `/health`, not `/dash`

- **`startedAt`.** `/dash` serves `null` with `startedAtWhy` — plugins' own known
  bug, the value is unreachable from a plugin. `GET /health` carries the real
  value (`2026-08-12T14:47:26.405Z`, measured). Read it there. Their fix will land
  by itself; this is not a workaround for a peer's defect, it is reading the
  authoritative source.
- **`present`.** `/dash` units have no such flag, and pac-host's `/mesh/devices`
  carried `present:false` for a unit DECLARED but not currently in the roster.
  **`GET /health` already distinguishes it** — it returns both `units` (declared)
  and `heard`, as separate arrays. `present` = in `units`, absent from `heard`.

`present:false` units **must be rendered, never dropped**. A unit silent for a day
disappearing from the list shows a shrinking roster instead of a unit in trouble,
and silence is the exact thing the panel exists to display.

## `beat` provenance EXISTS — corrected 2026-08-12, and the correction is the point

**An earlier draft of this spec said the bridge had no `beatSource` and that one
had been requested from plugins. That was false, and it was a false ABSENCE of
exactly the kind this repo keeps paying for.** It was read off `GET /dash`, whose
unit summary carries a bare `beat` — without then opening `GET /state/<id>`, which
carries provenance in three places.

Measured on `!987ab80f`, 15:14Z:

```
schedule.beat      60000          DECLARED
aim.source         "declared"
contact.basis      "declared"
measured.beat      { n:20, meanMs:62862, minMs:49905, maxMs:129256,
                     declaredMs:60000, errorMs:2862, contacts:255 }
measured.lateWakes { n:51, worstMs:189622 }
```

So the bridge is **richer than pac-host was**, not poorer: it serves the declared
value, the measured mean, and the error between them, per unit. `beatSource` maps
to `contact.basis`. The drift that made BNCH's `beatSource: measured` matter is
now a number (`errorMs`) rather than a flag.

The rule that follows is unchanged and now better supported: a countdown rendered
from the declared beat while the measured mean is 2.8 s longer and the worst late
wake is 189 s is a promise the unit did not make. **Render the basis alongside the
number, and prefer `measured` where `n` is meaningful.**

Per unit, never one number for the estate: the two live units are 60000 and 300000.

`/dash`'s summary remains the wrong place to read provenance from. Where a panel
needs it, the per-unit call is the source.

## Field map — what the thirteen importers consume, and where it now comes from

Consumed fields, counted across the importers:

| node-dash field | bridge source | note |
|---|---|---|
| `u.id` | `unit` | `!hex`, unchanged |
| `u.num` | `unit` | converted here, `node-label.js:55` |
| `u.beat` | `schedule.beat` | declared |
| `u.beatSource` | `contact.basis` | `"declared"` observed |
| `u.windowMs` | `schedule.win` | |
| `u.nextWake` | `aim.nextWakeAt` | ISO; `comms.nextWakeMs` is the countdown form |
| `u.name`, `u.shortName` | **not on the bridge** | resolved here via `node-label.js` — the bridge holds no names |
| `u.awake` | **no direct field** | `contact.overdue` + `aim.nextWakeAt` are the nearest facts |
| `u.txRadio` | **no direct field** | `link.radios` lists both; which one TX'd is not stated |
| `u.acks` | **no direct field** | `traffic` has `lastReplyAt`, `roundTripMs`, `queued`, `inFlight` — no counts |
| `u.wakesSeen` / `wakesExpected` | partial | `measured.beat.contacts`, `measured.lateWakes.n` |

**The last four are genuine losses and must be rendered as such** — the field says
it has no source today, naming the owner, rather than being computed from a
near-enough substitute.

Confirmed by plugins 2026-08-12 (`[where-do-these-live]`), who enumerated all eight
blocks of `/state` before answering:

| field | verdict |
|---|---|
| `awake` | not served under any name. **device's to publish** — they know whether `aim.preemptMs` counts |
| `acks` | not served per unit. `/stats` is estate-wide only. device's to add or decline |
| `wakesExpected` | not served. `measured.beat.contacts` is seen; there is no expected |
| `txRadio` | **plugins are building it** — the `before:send` hook already carries `{unit, text, radio, channel}` past them |

**Why this module does not compute `awake` itself**, in plugins' words, who refused
the same request for the same reason: *"a boolean I synthesised would be a second
opinion about whether a unit 2.5 km away is listening, sitting in the same payload
as the bridge's own numbers, with nothing to say which was right when they
disagreed."* The parts are all present — `aim.nextWakeAt`, `schedule.win`,
`aim.preemptMs` — which is exactly what makes the derivation tempting and wrong.

`wakesExpected` is the sharpest case. It is `elapsed / beat`, and **which beat is a
judgement about the unit, not arithmetic**: declared 60000 against
`measured.beat.meanMs` 68617. Dividing by the declared one is a choice that would
have been made here without anyone noticing a choice was made.

## contact vs aim — silence and opportunity are different clocks

Both can be true at once, and on 2026-08-12 both were: `contact.overdue` true with
`overdueBy` 35062 while `aim.nextWakeAt` was 38 s in the **future**. That is not a
contradiction.

```
contact.dueAt     when we should have HEARD from it by   -> SILENCE
aim.nextWakeAt    when we predict it will next LISTEN    -> OPPORTUNITY
```

`dueAt` is derived from when we last heard; `nextWakeAt` from the schedule. A unit
can be late for a wake it has not yet reached.

**"Next window" is built from `aim` and is correct.** It answers *when can I get a
command to it*. Reading it as staleness was a misreading on this side, not a defect
in the field — recorded here so it stays a reason rather than a coincidence. A
staleness indicator, if one is ever built, comes from `contact` plus
`contact.basis`.

**NO ESCALATION ON `contact.overdue`.** plugins' caveat, honoured: they have watched
25 overdue/returned pairs in 100 minutes, several resolving in under half a second,
and have an open item with device asking whether that is a real lapse or their
detector firing on its own boundary. Indicator yes, pager no, until that is
answered. This constraint travels with any future alerting path (`/notify` is the
obvious candidate and is deliberately not consumed yet).

`u.acks` losing its source is what breaks `alarm-sections.js:102` independently of
services' vocabulary change. Both causes land on the same field.

## Instants: ISO on the wire, epoch MILLISECONDS in the unit object

`heardAt`, `restoredAt`, `startedAt`, `aim.nextWakeAt` are ISO 8601 on the bridge.
pac-host stamped epoch ms.

**The unit object this module builds carries epoch MILLISECONDS, not seconds.**
That is pac-host's contract and every consumer assumes it: `alarm-sections` calls
`msToSec(u.beat)`, `msToSec(u.windowMs)`, `msToSec(u.nextWake)` and does the divide
itself, exactly once. `_isoToMs()` is the only converter here; there is deliberately
no seconds-producing variant, so the second divide cannot be added by accident.

**This was got wrong on the first cut and shipped.** An earlier `_isoToSec()`
handed `nextWake` over already divided, `nextWindowField` divided again, and
`1755012899` became `1755012` — **21 January 1970**. Permanently in the past, so
"Next window" read `overdue` on every unit forever, while the bridge's own
`contact.overdue` said `false`. The page was contradicting its own source.

What made it hard to see: `beat` (60000) and `windowMs` (8000) rendered perfectly
throughout, because the bridge serves those as plain millisecond **durations**
which were never double-converted. **A units bug that is wrong on one field and
right on the two printed beside it does not look like a units bug.** It looks like
a unit that is genuinely overdue — which, on a device that sleeps 99% of the time,
is entirely plausible. Nothing but arithmetic catches this.

Same rule as `docs/modules/coulomb.md`'s ms→s divide, and the rule services'
`[ms-everywhere]` note exists because of.

## NOTHING IN THIS MODULE POLLS — 2026-08-13

Peter: *"GET/HTTP is FORBIDDEN FOR LIVE DATA. NO EXCEPTIONS ... the ONLY data
that can use POST/GET is for things like form submission."*

This module shipped 2026-08-12 with **six pollers** — health 30 s, queues 5 s,
align 2 s, obs 60 s, obs-table 60 s, tx 5 s — against a bridge that was
advertising `ws /events` the whole time. plugins named that socket in their first
message; it was read past, and pac-host's polling shape was carried over
wholesale. device's own test, `api.js:13`: *"if a caller would have to POLL to
keep up, it belongs on the WS."*

plugins then deleted seven GET routes on the same rule at 07:02Z. Four were ones
this file polled, and node-dash retried `/tx` every five seconds until it was cut
over.

### An EVENT STREAM is not a STATE FEED — 2026-08-13, device

The rule, in device's words on `[events-is-not-a-state-feed]`:

> **Use `/events` to learn that something HAPPENED; use a feed to learn what is
> TRUE. Only the second kind rebuilds.**

On a feed the body is a *function*, re-invoked on every push, so the whole body is
recomputed from current state and current time. `/events` forwards each event
verbatim and has no body to rebuild — which is why a `tick` there is 47 bytes and
carries no state. That is correct, not a deficiency:

```
{"type":"tick","at":"2026-08-13T19:48:38.443Z"}
```

This module was built against the opposite assumption. It held two sockets and
took everything else as one-shot GETs at connect, so every value that only lives
in a rebuilt body — `contact.overdueBy`, `contact.missed`, `dueAt`, `measured.*`,
`servedAt` — was frozen at the moment the socket opened.

**One asymmetry that makes the state feed mandatory rather than a convenience**
(device, same item): `overdue` fires as an event **once per lapse**, on purpose —
*"six hours of silence is one event, not 360"*. The event stream gives a single
edge and never says it got worse. The magnitude exists only in the rebuilt
`contact` block. "Silent for 3 beats and counting" cannot be derived from events.

### Four sockets

Measured 2026-08-13 20:11Z, each by opening it and diffing consecutive frames.

```
ws /health             { ok, startedAt, uptimeMs, units, heard, schemaHash,
                         feedTickMs, servedAt }                        216 B
ws /state              { "!id": {schedule, comms, link, traffic, aim,
                         contact, measured}, …, servedAt }            3611 B
ws /events             { type, at, unit, … }          device's own event stream
ws /plugin/dash/live   { at, bridge, units[], counters }        plugins' view model
```

`/state` is **one socket for every unit**, keyed by `!hex`, not one per unit.
Across three frames on a quiet mesh it moved `link.heardAt`, `link.rssi`,
`contact.dueAt`, `measured.beat.meanMs`, `measured.beat.contacts` and `servedAt`.

`feedTickMs` arrives **on the `/health` body**, so the watchdog threshold is read
from the wire and never hard-coded. `null` means the tick clock is OFF — a real
state, and one that must not be defaulted to 10000, because that would claim a
guarantee that is not running. See `docs/modules/alarm-socket-watchdog.md`.

`servedAt` is on CORE feed bodies only (`/health`, `/state`, `/stats`) and
deliberately **not** on plugin bodies or on `/events` — injecting a field into a
plugin's payload would be a contract change in their repo. Take it from `/state`.

| event | carries | replaces |
|---|---|---|
| `beat` / `alarm` | `frame.json`, `frame.decodeError` | **GET /obs** |
| `send` | `radio`, `channel`, `text` | **GET /tx** |
| `witness` | `rssi`, `snr`, `direct`, `hops` | polled signal |
| `overdue` / `returned` | `dueAt`, `overdueBy`, `missed` | re-read `/state` |

**`/obs` and `/tx` were DELETED, not moved**, and neither is a loss: both
re-served what these events already carry. `frame.json` IS the runtime
parameters, already through device's decoder once — reading a field off it is not
decoding. A plugin in the middle of its own feed is a second surface that can
only drift.

### The only GET left, and it is not ours to fix

`GET /dash/sections`. It is the one route on the bridge that **refuses a socket
upgrade** — measured, `ws /dash/sections` → `404`, while `/health`, `/state`,
`/stats`, `/events` and `/plugin/dash/live` all open. It is plugins' route; raised
with them, not worked around here.

`GET /health` and `GET /state/<!id>` are **gone**. Both were one-shot snapshots
taken at connect, and both are sockets that rebuild every `feedTickMs`. Peter,
2026-08-13: *"GET and polling is forbidden. You subscribe to the feed, it is real
time, it is not polled, it is a LIVE STREAM."*

**A packet is a packet.** There is no re-broadcast handling in this module and
there must never be. Nothing on these feeds is a delta, a partial or a replay —
every push is a complete body, and the only correct response to receiving one is
to take it and use it, exactly as with any other packet. Peter, 2026-08-13:
*"they should be treated just like every other packet received. They are NOT
partial packets."*

That retires `_statusesEqual`. Comparing each body against the last and dropping
it when equal is the re-broadcast special-casing this rule forbids, and it is why
the page went stale: on the dash feed the only field that moves between pushes is
`at`, so the gate answered "nothing changed" every single time, forever.

### The age is OURS, and no feed can carry it

Distinguish two things that were conflated for a day:

| | moves when | whose job |
|---|---|---|
| `heardAt` — an **instant** | the mesh speaks | the bridge's; it is current on every push |
| `"29 minutes ago"` — an **age** | the wall clock advances | **node-dash's** |

`heardAt` not moving while a unit is silent is *correct*. The rendered string
still has to change, and nothing the bridge sends can make it — the thing that
changed is on this side of the wire. device, `[events-is-not-a-state-feed]`:
*"The rendered age was always yours."*

With `/state` pushing every `feedTickMs`, a rendered age is at most one tick
stale, which bounds it at ~10 s against a 900 s beat. Where a tighter bound is
needed the mechanism is `src/served-time.js` — a push scheduled at the computed
transition of the rendered string, never a comparison on a cadence.

### A socket that dies without a FIN — the watchdog

`_socket` reconnects on `'close'` and logs on `'error'`. A TCP connection that
dies with no FIN emits **neither**, so before 2026-08-13 node-dash held a
half-open socket indefinitely and the re-prime above never ran. Peter saw the
garage "last heard 39 minutes ago" when it had been heard 10.6 minutes ago.

Now: `ws.ping()` every `PING_MS` with a pong flag, plus a silence check, and
`terminate()` — not `close()` — when either trips, because terminate synthesises
the `'close'` this file already handles. **A pong deliberately does NOT reset the
silence clock**: the `ws` library auto-answers pings, so a peer that pongs while
publishing nothing would otherwise look healthy forever, which is the exact fault
being hunted. Thresholds derive from the bridge's declared `tick` contract.

Full reasoning, the derivation, and the incident: `docs/modules/alarm-socket-watchdog.md`.

### A failed decode must not erase what decoded

BNCH emits `alarm` frames that decode and `beat` frames carrying `json: null`
plus a `decodeError`. Overwriting blindly showed 18 fields for one second and
"nothing received" for the rest of the minute — measured. The parameters are the
**last successful decode**; a later failure is reported beside them, and `at` is
the instant of that decode, not of the last frame to arrive.

### The series is still a gap and must not be faked

`beat`/`alarm` carry the latest value per field — that is the table. A history
needs the `record` plugin, which is unbuilt. Accumulating events into a series
here would draw a chart starting at the last node-dash restart that looks like a
measurement.

## `obs` is TWO things and the word is overloaded

`GET /obs` shipped 2026-08-12 and is **the runtime-params table**, not the series.
Conflating them puts "no data" on a panel that has data, or the reverse.

| | needs a store | status |
|---|---|---|
| **table** — what is this device saying now, latest value per wire key | no | **live** |
| **series** — how has this number moved | yes | gap, `record` unbuilt |

The same payload carries `series: null` + `seriesWhy` deliberately, so one cannot
be mistaken for the other. `getObs()` therefore **never falls through to
`GET /obs`** — that route answers 200 with a table, and coulomb.js expects an
ascending series of `{at, n}`; the subtraction would run on whatever came out.

The `obs` entry in `sections` describes the **series**. `_pollObsTable()` is
deliberately **not** gated on it, or a working panel would hide behind an
unrelated gap.

### Four row states, and the difference is the point

```
arrived                    value, ty, label, at
declared `must`, absent    A DEFECT — also named in missingMust
declared `opt`, absent     normal, still listed; an absent optional is information
arrived, UNDECLARED        THE FINDING — firmware sends what the schema does not know
```

An undeclared key arrives as `value: null, withheld: true`. **Render the key,
never the value.** plugins' reason: `classify()` maps TELEMETRY/POSITION/NODEINFO
all to `beat`, so a position payload arrives on the same event class and lat/lon
lives in there. None of the 18 declared fields is positional, so the safe set and
the useful set are the same set.

### A broken schema is a ROW, not a gate

Got this backwards first: the section returned "unavailable" whenever
`schema.declared === 0`, which suppressed the rows entirely. But with an empty
schema **every arrived key classifies as undeclared** — and those are precisely
the rows this table exists to surface. BNCH had 17 keys arriving while the panel
said "unavailable".

The schema's state is now the first row (`0 of 18 declared` + the reason), and
only a table with no rows at all falls back to a bare statement.

### Presentation

Peter, 2026-08-12: *"this is a simple key/value list / table"*, *"make the table
fit the data"*. It is a `value_grid` like Reachability — short pairs in a grid
that sizes to them — **not** a full-width table and **not** a card per field. The
field set changes when firmware changes, so any hand-picked layout guarantees the
newest field is the one not shown.

**Every section needs an `id`.** The browser keys its section list on it, so two
sections without one collide and only ONE renders — silently, whichever loses
simply absent. `Charge` shipped without an id and looked fine as the only such
section; adding `Runtime params` made Charge vanish.

## Public interface

**Unchanged from `pac-host.js`.** That is the point: the transport is rewritten,
the surface is not, and the thirteen importers are untouched apart from the import
path.

Retained as-is: `events`, `start`, `stop`, `isAvailable`, `connectMessage`,
`queuesMessage`, `alignMessage`, `unitForNum`, `unitNums`, `obsForUnit`,
`queueCommand`, `getQueue`, `getObs`, `getImagesProgress`, `getStoredImages`,
`getDeviceImage`, `getImageById`, `getImageBytes`, `alignPing`, `alignStop`,
`alignConfig`.

### New

#### `sections()` -> `{ [name]: { ok, source, owner, why } }`

The bridge's own section map, forwarded verbatim. **Never synthesised here** — if
the bridge stops serving it, this returns null and the browser says so, rather than
this module inventing an optimistic map.

### Gap-bound exports

`getObs`, `getImagesProgress`, `getStoredImages`, `getDeviceImage`, `getImageById`,
`getImageBytes`, `getQueue`, `alignPing`, `alignStop`, `alignConfig` have **no
route on the bridge today**.

They must **throw a stated reason carrying the section's `owner` and `why`** — not
return empty, not return null, not fake a shape. An empty array from
`getStoredImages` is indistinguishable from "this unit has no images", and that
conflation is the whole defect this file was written after.

## State

Last pushed status, unit roster, per-unit queue ledger, align view-model, warm obs
cache. All read-only views of **the last packet received** — a caller on a request
path (`node-status`'s reachability section, which is **synchronous**) never fetches
and cannot block.

Held from the feeds, each named with the socket that fills it:

| state | filled by | note |
|---|---|---|
| `_declared`, `_heardIds`, `_schemaHash` | `ws /health` | was a one-shot GET |
| `_feedTickMs` | `ws /health` | **read, never hard-coded**; `null` = tick clock off |
| `_state` (`!id` → full unit body) | `ws /state` | was a one-shot GET **per unit** |
| `_servedAt` | `ws /state` | proves the bridge is still BUILDING bodies |
| `_units`, `_counters` | `ws /plugin/dash/live` | plugins' view model |
| `_obsFrames`, `_heard`, `_tx` | `ws /events` | what HAPPENED |
| `_sections` | `GET /dash/sections` | the one route that refuses an upgrade |

**`_contact` is deleted.** It was written by the `overdue` and `returned` events
and read by nothing (ledger `B106`), while `_mapUnit` took the same fields from a
connect-time snapshot. Both halves were wrong: the live values ride `/state`, and
the event edge cannot carry the magnitude anyway.

## Events emitted

`change` (status/roster), `alignChanged`. Both consumed by `alarm-ws.js`.

## Invariants

- **The PASV interlock stays here.** `pac-host.js:200-225` saves the dash mode when
  an align session starts, forces PASV, and restores the previous mode when it
  ends. That is node-dash's own machinery, nothing outside this repo knows dash
  modes exist, and it survives the migration untouched regardless of where align
  ownership lands.
- No module outside this file names a bridge route, field, or status string.
- `!hex` ↔ num conversion happens only here.
- ISO → epoch-**milliseconds** conversion happens only here, via `_isoToMs()`.
  Consumers divide to seconds themselves, once.
- A gap is rendered as its reason and owner. Never as absence, never as a spinner,
  never as an empty success.
- `present:false` units are served, not filtered.
- The browser never talks to `:8790`. `docs/BROWSER_CONTRACT.md` — page data is
  WS-only, replayed on connect, pushed on change. This matters more than usual
  here: `:8790` binds `0.0.0.0` with **no authentication of any kind** and accepts
  commands. node-dash's backend is the sole consumer and the surface stays on this
  host.

## Test notes

- The migration's proof is **panel-by-panel against the section map**, not "the
  page loads". A page that loads while every panel is silently empty is exactly
  the state this replaces.
- `units` and `commands` must fill. `outbox`, `obs`, `images`, `align` must each
  render their stated reason and owner. Both themes, 1600x1000 and 1280x800.
- `schemaHash` (`0xbaf7`, measured 2026-08-12) is served by `/health`. Worth
  logging on change — contract drift becomes visible instead of being discovered
  as a shape bug.
- Verify against a genuinely absent bridge too: with `:8790` stopped, node-dash
  must boot and serve every non-alarm page identically. Absence is normal — that
  was `pac-host.js`'s founding property and it must not be lost.

## Out of scope

- `config` and `diag` — zero call sites here, ever. plugins told to drop them.
- Building the series store, the image reassembler, or the outbox route. Those are
  other repos' and no amount of work here creates them.
- The `delivered` bug at `alarm-sections.js:102` — services' vocabulary change
  makes that state unproducible. Separate step, separate concern.
- `/notify`, `/probe`, `/pointer` — real routes on the bridge, deliberately not
  consumed yet. `/notify` in particular decides what *would* page a human and
  sends nothing; an alerts panel is a future decision, not this task.
