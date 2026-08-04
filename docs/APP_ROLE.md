# What this app is for

**Status:** the definition. Written 2026-08-04 because the purpose had become
unclear enough that the code drifted into doing the opposite of it, and nobody
noticed for weeks. Everything else — the selector, the workers, the board, the
repo split — is downstream of this document. Where a module contradicts it, the
module is wrong.

---

## One sentence

**It finds and opens paths that push our reach, and keeps them open.**

## Two sentences more

node-dash already shows what has been **achieved** — its node list *is* the
record of everything we have reached. This app does not restate that. It works
the **edge**: mining the traffic we already store for leads, identifying the
doors and routers that carry us, and spending traceroutes to confirm what the
data suggests.

Peter, 2026-08-04:

> the existing node dash and it's lists of nodes already shows what has been
> achieved, this app is supposed to push that envelope

> it is not replacing node dash, it enhances it. all of the workers and digging
> through data and finding possible leads, and probing with traceroutes and
> pointing at DOORS and ROUTERS and identifying them is all part of this app.
> finding and opening opportunities that will push our reach, **not one time but
> forever**.

---

## "Not one time but forever" — the sentence the design hangs on

This is an **engine, not a scoreboard.**

A single lucky contact at 200 km is a fact about one evening's propagation. It
does not repeat, it cannot be scheduled, and it teaches nothing that survives
the night.

An **opened corridor** is different. A router identified at 30 km on a bearing
of 227° is a door that stays open: every future node behind it becomes cheaper
to reach, and every packet through it confirms the path still works. The value
compounds.

**So the unit of value is the path, not the contact.** A shot that opens a
corridor beats a shot that sets a number, even when the number is bigger. This
single principle resolves most of the ranking questions that follow.

---

## The three things it does

### 1. Mine — find leads in data we already hold

Zero airtime. Every packet the mesh sends past us is evidence, and most of it
has never been read. Relay bytes, route chains, who is heard and when, which
bearings produce and which never do.

A **lead** is a node or a corridor the stored data says is worth a shot, that we
have not yet taken. Leads cost nothing to generate and are the cheapest thing
this app produces — the miners should run constantly and report their zero cases
explicitly, because silence from a worker is indistinguishable from a broken
worker.

### 2. Probe — spend airtime to confirm a lead

A traceroute is **an instrument, not the point.** Peter, 2026-08-04: *"traceroute
is just a tool for probing."* It is how we turn a suspicion into a known path.

It is also the only thing here that costs anything — airtime on a shared
channel, and time on a shared antenna. Everything in the budget, the brake and
the backoff exists because 26.6% of thirty days of attempts bought nothing.

### 3. Open — turn a confirmed path into standing infrastructure

A confirmed door is recorded, aimed at, and reused. This is the step that makes
the work permanent rather than a series of one-offs, and it is the step the app
has been weakest at.

---

## Three classes, and they are not interchangeable

Peter, 2026-08-04: *"you have identified DOORS - opportunistic, and ROUTERS -
dedicated but not ENDPOINTS"*.

`src/doors.js:40-56` already draws the first line. This document had blurred it
back together, which is the mistake this section exists to prevent.

| class | evidence | durable? | what it is for |
|---|---|---|---|
| **ROUTER** | **declared** role — `ROUTER`, `ROUTER_LATE`, `ROUTER_CLIENT`, `REPEATER` | **yes** — the operator configured it to carry traffic, and it will keep doing so | siting a corridor on |
| **DOOR** (relay) | **observed** — it carried a packet for us once | **no** — says nothing about intent, may never recur | a lead worth using now, and re-confirming |
| **ENDPOINT** | it is a destination | n/a | the *point* — what we reach **through** the other two |

**This is where "not one time but forever" actually comes from.** A door is
opportunistic: it worked on one evening, and tomorrow it may not exist. A router
is dedicated: it is infrastructure, and a corridor built on it survives. Both
can carry a packet; only one can be planned around.

### But they do the same job — and at the frontier they are equal

Peter, 2026-08-04: *"DOORS and ROUTERS could be of equal value, they do the same
thing, BUT we can probably assume that if someone has setup a router, that it is
in a great location"*.

Both halves are true, and the second is the **mechanism** behind the first.
Measured over nodes observed relaying in completed traceroutes:

```
                    n   med alt  (n)   avg targets   avg hops   furthest behind
declared ROUTER    19     266 m   13          28.7        387          189.1 km
everything else    80      39 m   38           4.4         17          181.6 km
```

- **Siting: routers win, and that is the whole reason.** A median 266 m against
  39 m — nearly 7× the height. Somebody who configures a router puts it
  somewhere good, and height is the single biggest lever on range. **The role
  declaration is a free signal about siting**, which we cannot otherwise measure.
- **Breadth and load: routers win.** 6.5× the distinct targets, 23× the volume.
- **Reach at the edge: they are equal.** The furthest node behind a plain door is
  **181.6 km** — within 7.5 km of the furthest behind any declared router.

So value depends on **what the path is being used for**, not on the class:

| purpose | which is better |
|---|---|
| one shot at the frontier | **equal** — use whatever sits on the bearing |
| standing infrastructure, "forever" | **router** — height, breadth and durability compound |

A door on the right bearing is not a second-rate router. It is the same tool with
no warranty.

*Bounds: altitude is recorded for only 13 of 19 routers and 38 of 80 others, and
it is self-reported by the node. Small samples on both sides.*

So the two are used differently:

- a **router** justifies standing investment — aim at it, map what lies behind
  it, treat losing it as a significant event
- a **door** is a lead with a shelf life — use it, but re-confirm before relying
  on it, and never mistake one good night for a corridor

Measured: **6 declared routers carry 95.1% of every route we have completed.**
That is why they are gold dust — not because they are far, but because they are
*dependable*.

### An endpoint is never infrastructure

Peter, 2026-08-03:

> we should not waste time trying to get replies from routers, but we need to
> use them for what they are and not treat them as just another endpoint which
> they are not

The inverse holds just as hard: **an endpoint must never be scored as a door.**
It is the destination, not the path. Reaching one proves the corridor worked; it
does not make that node part of the infrastructure.

Rules that follow:

- A router's score is **traffic carried and targets reachable behind it**, never
  its own reply rate. Probing a router for a reply spends airtime to learn
  something we do not need.
- `CLIENT_MUTE` can never be a door — it does not rebroadcast, by declaration.
- A door with no confirmed route is still a door if we can hear it **directly**.
  The bootstrap must not require a node to already have been `route[0]`.
- Losing a **router** is a bigger event than losing a door, which is a bigger
  event than losing an endpoint. The board should reflect that ordering.

### Is the role enum a valid classifier? Measured, 2026-08-04

Peter: *"it's basically defined by the Device Role CLASS i.e CLIENT, ROUTER etc,
but that may not be a 1:1 comparison or valid classifications"*. Correct — and
the shape of the error is worth knowing exactly.

Counting nodes seen relaying inside completed traceroutes:

| | declared relay-role | everything else |
|---|---|---|
| nodes that ever relayed | 19 (19.2%) | **80 (80.8%)** |
| hops actually carried | **11,170 (88.2%)** | 1,491 (11.8%) |

**Role is a good classifier for LOAD and a bad one for MEMBERSHIP.** Ask *who
carries the mesh* and it is 88% right. Ask *who are our doors* and it misses four
out of five.

Per-role relay rate, against an 8.0% baseline:

```
ROUTER         28 nodes   60.7%    7.6x lift; 6 of them carry the bulk
CLIENT_BASE    85 nodes   20.0%    17 relays — same COUNT as ROUTER, and not in RELAY_ROLES
(no role)     741 nodes    8.0%    59 relays — the largest single block of real doors
CLIENT_MUTE    69 nodes    0.0%    0 of 69. The enum's one perfect signal.
ROUTER_CLIENT   4 nodes    0.0%    in RELAY_ROLES on faith; has never relayed for us
REPEATER        1 node     0.0%    same
200.0           3 nodes            corrupt role value (ledger B77)
```

So the valid rules are narrower than `RELAY_ROLES` assumes:

1. **`CLIENT_MUTE` → never a door.** Hard, reliable, perfectly predictive.
2. **`ROUTER` → load-bearing.** A strong prior on *capacity*, not a definition of
   doorhood.
3. **Everything else → a door only when OBSERVED.** 80 of our 99 real relays.
4. **No role ≠ not a relay.** 741 nodes carry no role at all and hold the largest
   block of observed doors.

`RELAY_ROLES` used as *the* door filter discards 80% of our actual doors.

**Bounds on this conclusion:** it counts relaying seen inside *completed
traceroutes*, so it is biased toward corridors we chose to probe. It shows what
has carried for us — not what could.

---

## Why the classification matters: it selects the probe

Peter, 2026-08-04:

> to node dash this kind of thing is irrelevant, but to us when we are probing it
> is key to our probes and the different things we try and do to discover and get
> contact from a remote endpoint

**This is the separation of concerns, stated exactly.** node-dash lists nodes and
shows state; a role is a column and nothing depends on it. This app cannot
function without the classification, because **the class decides what we try.**

And probing is not one action. It is a repertoire, and picking the wrong
technique wastes the scarcest thing we have:

| what we know | what to try | status |
|---|---|---|
| target is behind a known **router** | aim the beam at the **first hop**, not the destination — 88% of relays fall outside the beam when we aim at the target | task `aim-at-the-first-hop` |
| target has an observed **door** on its bearing | aim at the door; re-confirm the door before relying on it | doors.js `doorAim` |
| target is **silent and distant**, no door | this is the lead the app exists for — and the current selector excludes it | **inverted today** |
| target **transmits but never answers** | stop probing it; capture passively — a reply is not the only evidence of contact | `passive-tracer`, worker `explorers` |
| target is a **declared router** | do **not** probe it for a reply. Probe *through* it | rule in this document |
| target is `CLIENT_MUTE` | never a door; only ever a destination | doors.js |
| target **sleeps** (wakes ~30 s per cycle) | timing, not repetition — a `no_ack` proves sleep, not routing | recorded, not built |
| we want proof of delivery without PKI | `want_ack` on a broadcast — implicit ack via the flooding router | **not built**; mesh-gw item #14 open |

The table is the app's operating model. A node's class does not just describe it
— it **routes it to a technique**, and choosing the technique is the judgement
this app exists to make.

### The gap this naming exposes

`doorKind()` returns three values — `router`, `relay`, `never` — and there is no
`endpoint`. A plain `CLIENT` that has never relayed anything falls through to
`'relay'`, i.e. *potential door*, and so does a node whose role we simply do not
know:

```js
function doorKind(role) {
  if (RELAY_ROLES.has(role)) return 'router';
  if (role === 'CLIENT_MUTE') return 'never';      // cannot relay, by configuration
  return 'relay';                                  // observed only, or role unknown
}
```

**Unknown role therefore reads as door-capable**, which is the fail-open pattern
this project has been bitten by twice already. A third class is missing:
`endpoint` — known role, cannot or does not carry — kept distinct from `unknown`,
which is an absence of evidence and should be treated as such rather than
optimistically.

---

## Contact, reach, and what each is for

Peter, 2026-08-04: *"we are supposed to treat ANY packet received from a node as
contact verified."*

Three different facts, currently conflated. They are kept separate because they
answer different questions:

| fact | means | who owns it |
|---|---|---|
| **contact** | a packet from that node reached us — by any path, any port | node-dash's node list |
| **direct RF** | reached us with **0 relays**, on our own radio | the honest measure of our own antenna |
| **verified route** | a traceroute completed — we know the **path** | this app; it is what "opened" means |

The record (189.1 km) is a *verified route*, and it stays what it is. It is not
this app's headline, because it describes what has already been achieved and
node-dash already shows that. **This app is measured on what it ADDS**: leads
converted, doors opened, corridors that keep delivering, ground reached that was
not reachable before.

Contact is not a lesser fact than a verified route — it is a *different* one.
267 positioned nodes have sent us packets. Discarding that because they never
answered a traceroute was the largest single error in the model.

---

## What a candidate is

**A node we know exists, that is distant, that we have not opened a path to.**

Silence is the *reason to probe*, not a disqualifier. The current selector has
this exactly inverted — it removes never-heard nodes from candidacy
(`skipped_silent`), which deletes the target population by definition.

Ranked by **what opening it would unlock**, not by how likely it is to reply:

1. a node that would open a **new corridor** (a bearing, a region, a door we do
   not have)
2. a node **behind a known door** we have never used that way
3. a node past the current envelope
4. a node that merely improves a number

Answer rate is an **efficiency measure, not the objective.** It will fall when
the app aims where it should. A falling answer rate with rising corridors opened
is the app working correctly; a high answer rate from re-probing known-good near
nodes is the failure mode it is in today.

---

## What success looks like — evidence of contribution

Peter, 2026-08-04:

> what we need to see is evidence that we are contributing to node-dash's reach
> and making a difference.

This is the requirement, and it is stricter than a list of achievements. The app
must show **its own contribution**, separated from what the mesh would have done
anyway.

### The trap this exists to avoid

The mesh generates traffic constantly. Nodes appear in node-dash's list on their
own — someone powers a radio on, a repeater comes back after a storm, propagation
lifts for an evening. An app that counts every new node in the window as its own
result is **flattering itself with the mesh's own activity**, and it would show a
rising line forever while contributing nothing.

So every claim of contribution needs a **causal link back to an action we took**,
and the honest report shows both columns: what we caused, and what simply
arrived.

### Attribution, strongest first

| strength | evidence | why it holds |
|---|---|---|
| **Caused** | a traceroute **reply** to a probe we dispatched | the packet exists because we sent one. Nothing else explains it. |
| **Caused** | first contact with a node whose only path runs through a door **we identified and aimed at** | the corridor is ours; the traffic followed it |
| **Contributed** | a node first heard **while the beam was on its bearing**, within the aim window | plausible and worth recording — the antenna was pointed because we pointed it |
| **Not ours** | a node that appeared with no probe, no aim, no door of ours in its path | counted, and counted **separately** |

The fourth row is the one that keeps the other three honest. It must be reported
with the same prominence, or the metric is marketing.

### What the board must therefore answer

1. **What did we open?** Corridors that did not exist before and are *still
   carrying* a week later — not opened-and-lapsed.
2. **What did it cost?** Airtime spent per corridor opened. A door bought with
   3,000 wasted traceroutes is a different result from one bought with 12.
3. **What arrived anyway?** New nodes and new reach with no attribution to us.
4. **What would node-dash not have without us?** The bottom line: nodes, doors
   and paths in node-dash's record that trace back to an action of ours.

### The uncomfortable part

That fourth question may currently answer **"very little"**, and the document
says so on purpose. Measured 2026-08-04, the selector aimed nothing further than
115 km against a 189.1 km record, spent 26.6% of thirty days of attempts on
targets that never answered, and excluded 155 never-heard nodes from candidacy
by rule. An app in that state cannot have contributed much, and a metric that
implied otherwise would be the thing to fix first.

**The measurement comes before the improvement.** Build the attribution ledger,
read what it says honestly, then change the targeting — in that order, so there
is a baseline to prove the change against.

A month where the record does not move but four new doors open, still carrying,
is a **good month**. A month where the record moves once by luck and nothing is
reusable is not.

---

## Rules inherited, learned expensively

- **State that resets on restart is a bug.** The airtime budget, the passive
  tracer's cooldowns and the own-node guard all failed this way.
- **A guard that fails open is worse than no guard** — it reports compliance
  while exceeding. `reach.heard`'s per-hop guard did exactly this and published
  1050.9 km.
- **Finding nothing is a result.** Every worker reports its zero case.
- **A recording change looks exactly like a trend.** Any new table needs an epoch
  consumers can filter on.
- **Test a model against a constant.** A bearing-matched door predictor scored
  32%; "always the busiest door" scored 63%.
- **The browser decides nothing.** Completed 2026-08-04.
- **PRIMARY transmission is Peter's product decision, not the app's.**

## What this document does not settle

- The **repo split** (`docs/OBSERVATORY_REPO_SPEC.md`). The classification
  section above is the strongest argument yet: *"to node dash this kind of thing
  is irrelevant, but to us when we are probing it is key"*. node-dash needs no
  concept of a door, a router-as-infrastructure, or a probe technique; this app
  is built entirely on them. That is a real boundary, not a size complaint. The
  decision — and the database question inside it — is still open.
- **How the airtime budget is divided** between corridor work and the existing
  liveness-ranked probing. That is a number, and it is Peter's.
