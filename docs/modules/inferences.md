---
module: inferences
source: src/inferences.js
source_hash: df1549d4518b22cf8970a1d5a2afd51d109783c94eddfbc15c1ecb194871d509
updated: 2026-08-03
---

# Module: inferences

## Purpose

**The catalogue — every value node-dash works out rather than is told.** Read it
top to bottom and you have seen everything the system infers.

Peter, 2026-08-02: *"the hooks should be a seperate file, so it's easy to see our
calculated functions in 1 place, the file will grow as we think of new things to
get / extract. so each will be a small func that does one thing."*

**Four inferences today**, all batch, all recomputed on boot and every 15 minutes:

| key | produces |
|---|---|
| `relay.usage` | the doors — traffic carried and targets behind each relay |
| `reach.target` | per target: km, bearing, attempts, hits, verified |
| `reach.ladder` | one global fact: every moment the frontier moved |
| `link.observed` | every witnessed node-to-node hop, both ends placed |

All four read `obs_v_traceroute` — a view over `traceroute_history`, so they run
over five weeks of history that already existed and spend no airtime.

## The split from the engine

This file is **domain code**. It knows what a bearing is, what a node is, what a
relay is. `observatory.js` knows none of that and must never learn
(`docs/modules/observatory.md`, `MESH_REACH_SPEC` §7f).

That split is what keeps the engine testable without a radio and reusable beyond
this project. It is enforced by `tests/test_observatory_boundary.mjs`, which
permits exactly **two** importers of the engine: `index.js` (the composition
root) and this catalogue.

The catalogue is not core. It is a plugin that registers with the engine, in the
same way `alarm-sections.js` registers a `node_status` section.

## The rules every inference obeys

1. **Pure.** A function of the evidence it is handed and nothing else. No
   database, no clock, no randomness, no network.
2. **Small, and one thing.** If it does two things it is two inferences.
3. **`null` is a real answer.** "Not enough evidence yet" is returned, never
   thrown, never faked as a zero.
4. **No provenance by hand.** The runner stamps what produced a value, when, and
   from how much evidence. An inference that writes its own provenance can
   launder itself as a fact.
5. **Graduation.** When a function outgrows a page it moves to its own file and
   is imported and registered here. This file stays the index.

### Why purity is enforced rather than requested

It is the rule most likely to be broken for convenience, and breaking it fails
nothing else — the code would work. But an inference that reaches for the
database cannot be recomputed over history and cannot be tested without a
database, which destroys the retroactive property the registry exists for: *write
the estimator in October, run it over July's data*.

So the test asserts it directly:

- `inferences.js` must not import `db.js`
- no `Date.now(`, `new Date(`, or `Math.random(` outside comments

If an inference needs more evidence, it **declares** it and the runner fetches
it.

## Evidence is declared, not fetched

The design problem this layer exists to solve. An inference cannot query without
destroying its purity — and with it the ability to recompute over history. The
engine cannot query on its behalf without learning what a route is.

So an inference **declares** its evidence as SQL, the engine executes it
understanding nothing (exactly as a driver does), and `run(rows)` stays a pure
function of what came back. The SQL is domain knowledge and lives here, with the
inference that owns it.

`json_each` earns its keep: it expands the route array inside a JSON payload
inside a view over a table nobody migrated, turning stored traceroutes into a
graph in SQL with no parsing in JavaScript.

## Scope of the founding task (`observatory-inference-catalogue-boundary`)

Created **empty**, with the boundary test corrected first.

The test previously asserted that *only* `index.js` may import the engine — the
rule stated slightly wrong. A catalogue must call `registerInference`, so it
would have been rejected, and the boundary would have been loosened under
pressure from code that already existed. **Widening a boundary test to admit code
that is already written is how boundaries die.** Widened here first, with nothing
waiting on it, so it is a decision rather than a consequence.

## Public interface

None. The module registers on import and exports nothing.

## `reach.mission` — what to try next, and why

The memory §2 says the prober does not have: *"the machine is not selecting; it
is iterating."*

**§9 was mis-framed and this inference is the correction.** Peter, 2026-08-02:
*"why is everything blocked by something else meaning that this will never be
completed?"* — §9 had been treated as a block on the whole Missions panel. It is
not. node-dash **already dispatches traceroutes itself** (`traceroute.js:128`,
`passive-tracer.js:122` — 21,793 over five weeks, from both radios). No new
authority is needed to govern sending that is already happening ungoverned. Only
the **broadcast callout** is contested, and that is one instrument of three.

This inference spends no airtime. It ranks; it does not send.

### Evidence starts from `nodes`, not from the traceroute view

That LEFT JOIN is the whole point. It is the difference between *"which target we
have tried deserves another go"* and *"what have we never looked at"*. Measured
2026-08-02: **213 positioned nodes have never been attempted once**, 39 of them
beyond the 189.1 km record — while **423 attempts went to a single node with no
position that has never answered**. The pool the prober never saw is where the
information is.

### The step, not the distance

Peter, 2026-08-02: *"what I am expecting to see is the 189km increase, if it's
not then we are not making use of all of that data we have?"*

He was right. The first ranking used **distance from home**, which is the naive
metric, and the runner spent every attempt on 233–234 km nodes in Cheshire and
Bedfordshire — roughly **100 km past anything we have ever touched**, in
corridors where no path has ever been demonstrated. Five consecutive misses.

Meanwhile the data already held the better candidates:

| target | km | step past a node we have **reached** |
|---|---|---|
| `?5C3` | 191.4 | **3.6 km** |
| `?1F2` | 190.7 | **3.3 km** |
| `Sen1` | 208 | 20.8 km, past `Ives` (verified 187.7) |
| `GA3` | 212.9 | 39.3 km, past the Guernsey relays |
| `?A20`, `WIST` | 233–234 | ~100 km |

On the headline number those are 40 km apart. As propositions they are nothing
alike: one extends a working corridor by a hop, the other is a leap into the
dark.

`step_km` is the great-circle distance from a candidate to the **nearest node we
have actually reached** — computed from `proven`, the set of every verified
target's position plus home, which the same evidence rows already carry.
Suspect distances are excluded from `proven` (§12): a claim is not a place.

`rank = 1000 + max(0, 300 − step × 2)`, so `record` and `unknown-record` share one
scale and the smallest step wins regardless of which class it is in.

### The window and the attempt budget — settable, and read as evidence

Full rationale in `docs/DISCOVERY_STRATEGY.md`.

Ranking by smallest step was right and insufficient. The 24 h cooldown retired
every good candidate after one attempt, so the queue walked outward until it was
shooting **106–133 km** past anything we had reached, with 44 targets locked out
at any moment.

Four settings now arrive **through the declared SQL evidence**, the same way
`home.lat` always has — this inference is pure and cannot call `getConfig`.
`COALESCE` supplies the default in SQL, so an unset key can never produce a null
that silently disables a rule.

| setting | effect |
|---|---|
| `strategy` | `ladder` applies the window; `portfolio` is the old behaviour |
| `window_km` | a candidate further than this past proven ground is excluded |
| `attempts_per_target` | replaces the hardcoded `attempts >= 40` retire rule |
| `cooldown_min` | replaces the hardcoded 24 h lockout |

**Proven reached, not merely present** (2026-08-02, same data, only the strategy
changed):

| strategy | candidates | max step shown | `skipped_beyond_window` |
|---|---|---|---|
| `ladder` 25 km | 131 | **15.8 km** | 129 |
| `portfolio` | 222 | **163.7 km** | 0 |

The `global` summary fact publishes the active rule (`strategy`, `window_km`,
`attempts_per_target`, `cooldown_min`) alongside the counts, so the panel states
what it is running under rather than only what it produced.

### Your choices outrank the ladder

Full rationale in `docs/DISCOVERY_TARGETING.md`.

Two classes sit above everything automatic: `pinned` (one node, `discovery.pinned`)
and `target` (any node with `nodeinfo.obs_target`). Both bypass the window **and
the §12 distance ceiling** — you chose them explicitly, so an automatic exclusion
does not get to veto it. Found in Phase 4: a node starred at 333 km never reached
the queue because the ceiling test ran first, which defeats the point of choosing
it. The record is protected separately (`reach.ladder` excludes suspect
distances), so a reply from a badly-placed node still cannot move the frontier —
and the reason string says the distance is self-reported and unverifiable.

**They still respect the cooldown.** Pinning plus a 180 s interval would be twenty
traceroutes an hour at one stranger's node; that is pursuit turning into
harassment.

Quotas come from `mode`, which is orthogonal to `strategy` — `mode` decides
whether auto picks at all, `strategy` decides how:

| mode | pinned | target | automatic classes |
|---|---|---|---|
| `auto` | 1 | 4 | 6 / 6 / 4 / 4 |
| `targets` | 1 | 12 | 3 / 3 / 2 / 1 |
| `manual` | 1 | 20 | **0** |

Verified live, same data, only the mode changed: `manual` returned exactly
`pinned:89ec, target:trix` and nothing else; with nothing selected it returned
**zero rows**, which is what lets the panel say *"MANUAL · nothing selected"*
rather than idling with no explanation.

### Liveness — the strongest predictor we have, and it was unused

Measured across all 21,864 stored attempts:

| last heard | attempts | answers |
|---|---|---|
| directly, 0-hop RF | 4,345 | **26.1%** |
| within 24 h | 12,847 | **16.0%** |
| within 7 d | 1,024 | 7.0% |
| silent over 7 d | 3,648 | **1.8%** |

A **14× spread** — far larger than any distance effect the ranking was built on.
`MESH_REACH_SPEC` §3 stated the principle from the start — *"passive reception is
free evidence and must be mined first… it is proof the node is alive and roughly
where, which is what makes an attempt worth spending"* — and the selector did not
implement it, while `last_heard` sat unused in evidence it already selected.

The shortlist this replaced had **4 of 14** entries heard within 24 h; the rest
were 4–33 days silent. That is where the attempt budget was going while 40+
shots produced nothing.

`max_silence_days` (default 14, settable) excludes silent nodes outright, counted
as `skipped_silent` — 150 on the first run. Above that, a tiered bonus (400 / 220
/ 90 / 20) is added to every automatic class. **Tiered rather than smooth,
because the measured curve is a cliff between "today" and "last week", not a
gentle decay.**

A pinned or starred target bypasses the cutoff, as it bypasses the window and the
ceiling — an explicit choice still outranks an automatic exclusion.

Result: **11 of 11** shortlist entries heard within 24 h, against 4 of 14 before.

### Focus = distance + last heard + first heard

Peter, 2026-08-02: *"so our window focus should be based on distance and
last/first heard."*

**Distance — proven ground means RELIABLY reached, not reached once.** The anchor
admitted any node that had ever answered, and the furthest was the 189.1 km
record holder at **1 hit in 63 = 1.6%**. So the window measured from 189 km and
admitted candidates to 214 km — a band answering 0.0–1.3% across 2,088 attempts.
One lucky packet on 4 July was dragging the whole search 90 km past anything real.

| anchor | nodes | furthest |
|---|---|---|
| ever answered once | 84 | 189.1 km |
| `proven_min_hits` 3 **and** `proven_min_rate` 10% | 31 | **95.2 km** |

95.2 km is exactly where the distance chart puts the wall.

**The record is unchanged.** `reach.ladder` still reports 189.1 km — *furthest we
have reached* and *furthest we can rely on* are different claims and both are
true. Only the search anchor moved.

**Last heard** — the liveness tiers and `max_silence_days` above.

**First heard** — a `new` class for nodes discovered within `new_node_hours`
(default 48), so a genuinely new node gets one aimed six-shot run instead of the
single passive trace it gets today. ~6.9 are discovered a day and only 1 of 11
shortlist entries had been found in the previous week.

**Probation, not a priority spike.** Measured: a first traceroute within an hour
of discovery answers **5.9%**, against **40.9%** for nodes traced days later —
new nodes are usually new because their NODEINFO arrived relayed from the edge.
Ranking them top would move the budget out of a 16–26% pool and into a 5.9% one.

Effect, same data, only the anchor changed: shortlist went from 191–208 km and
silent for days, to **22–67 km, heard 5 minutes to 35 hours ago**, with 194
candidates excluded as beyond window.

### Classes

| class | meaning | quota |
|---|---|---|
| `unknown-record` | never attempted, and beyond the record | 6 |
| `record` | attempted, no reply, and beyond the record | 6 |
| `reconfirm` | verified past 100 km, untried for ≥ 7 days | 4 |
| `unknown` | never attempted | 4 |

Rebalanced once the step metric existed. The old split gave eight slots to
`unknown-record` and every one went to a 100 km leap, crowding out the handful of
candidates a short hop past a working corridor. The two record classes now share
a rank scale, so the split is about breadth of evidence rather than about which
class wins.

**A portfolio, not a sort.** Ranked purely by score the shortlist came back as
twenty rows of *"never attempted, and would beat the 189 km record"* — the
highest information gain, and useless as a mission list. One class swamping the
panel hides the record attempts already in flight and the frontier corridors
going stale, which are different kinds of work that want doing in parallel. So
each class gets a quota and keeps its own internal ranking. The quotas are a
judgement about balance, stated in the code rather than buried in a score.

Within `record`, rank decays with attempts (`-6` each, capped at `-120`). §4 says
silence proves nothing; it does not say silence is free, and the twentieth silent
attempt is worth less than the second.

### Every mission carries its reason as a string

Written by the inference, not assembled by the page (`BROWSER_CONTRACT`). A
ranked list with no stated reason is a magic number wearing a table.

### Exclusions are published, not silent

`COOLDOWN` 24 h — Peter's *"not so much as to become a nuisance"* with a number
attached. This is the **only** rate rule the selector owns; a real budget belongs
to whatever dispatches, which is not this.

`CEILING_KM` 250 — beyond this a self-reported position is a claim, not evidence.
250 rather than §12's 200 because a mission may legitimately aim *past* the
frontier — that is the point — but a node claiming 1,681 km is a bad coordinate,
not a target.

A `global` summary fact reports candidates, shown, and the cooling / suspect /
exhausted counts. First live run: **19 of 227 candidates, 7 cooling, 125 suspect,
22 exhausted.** A shortlist that quietly drops most of the pool reads as "these
are the only options".

### Our own radios are excluded via `from_num`, not `nodes.device`

The first attempt used `n.device IS NULL`, which is a different thing entirely:
`device` is the MAC of the radio that **heard** the node, so it is set on 903
nodes and the filter cut the pool from 601 to 3 — with a `0 km` record to match.
`from_num` is the addressee of a traceroute reply and is only ever one of ours
(measured: TA2o, TA2y, GARG, nothing else).

## `reach.ladder` windowed, and `reach.heard`

Task `windowed-reach-model`. Peter, 2026-08-03: *"the board is stagnant and looks to me to
be identical to how it looked 3 days ago… might be that 189.1 will never change and our
sights are too high."*

Measuring today against an all-time maximum admits two outcomes — unchanged, or once a
month a new record — and the antennas have MOVED since 189.1 km was set on 2026-07-04. A
month-old number taken with a different physical setup is history, not a target.

`reach.ladder` now publishes both. `record_km` stays all-time and is never lowered;
`window_km` is a **plain maximum inside the window, not a running one** — inside a period
we want that period's best, not a ratchet inherited from before it.

`reach.heard` is the one-way frontier: a packet on any port that originated at a node and
reached us. Hearing a node proves a path TO us exists, which is the strongest prior we hold
for whether a traceroute might return.

```
window   ANSWERED all-time  ANSWERED window   HEARD all-time  HEARD window  nodes
   1d            189.1 km          92.0 km        1050.9 km      932.4 km    210
   7d            189.1 km          92.0 km        1050.9 km      932.4 km    299
  30d            189.1 km         189.1 km        1050.9 km     1029.8 km    547
  all            189.1 km         189.1 km        1050.9 km     1050.9 km    591
```

### The window must trigger a RECOMPUTE, not just a rebroadcast

`charts()` reads STORED FACTS, and the window is baked into a fact when its inference last
ran — a 15-minute cycle. The first implementation only rebroadcast, so every window served
the previous window's numbers and the frontier appeared frozen regardless of selection.
The settings listener now re-runs `reach.ladder` and `reach.heard` before broadcasting.
Nothing else is re-run; the other inferences keep their cadence.

### The per-hop guard is weak, and that is recorded rather than tuned

`MAX_KM_PER_HOP = 200` rejected only **19 of 610** nodes, leaving a headline heard figure
of 1050.9 km. 932 km over 7 hops is 133 km/hop and passes. The threshold is calibrated so
the real 189.1 km record survives — its single longest leg was ~176 km — which leaves it
too lax to catch MQTT-laundered origins.

**It was NOT tuned downward to make the number look plausible.** Choosing a threshold by
whether the output pleases is fitting the guard to the desired answer. The principled fix
is to separate DIRECT receptions (`hops = 0`, nothing can be laundered) from relayed ones
and report them as two different facts — direct-heard was 143.2 km over 30 days against a
relayed 1029.8 km. That is a separate task.

The guard, its threshold and its rejection count are all published so a reader can argue
with them instead of finding them applied silently.

## The ranker aims past the WINDOW's best, not the all-time record

Task `chase-the-window-best`. Peter, 2026-08-03: *"the ultimate target is 189.1km, but in
our current window, the best is 92km, that is what we should be looking to beat and not
189.1km."*

`record` was a running maximum over every row ever, and both record-chasing classes gated
on `km > record` — so the search aimed beyond 189.1 km, a figure set on 2026-07-04 with
antennas that have since moved. That band answers **0.0–1.3% across 2,088 measured
attempts**; just past the window's best sits in 75–100 km, which answers **20.9% (n=549)**.

`windowBest` is the furthest target answered inside the window, from rows whose `last_ok`
falls in it — `last_ok` is already in the evidence, so no new query. The classes now gate
on `bar`, and the summary publishes `record_km`, `window_best_km` and `bar_km` so the panel
can state which is which.

**`bar` is floored at `reliable_km`.** A self-referential target can ratchet DOWNWARDS: a
poor window lowers the bar, which selects easier targets, which keeps the window low. The
bar may never fall below ground we already hold. Currently that floor binds — window best
92.0 km, reliable 95.2 km, so `bar_km` is 95.2.

### OPEN: `step` does not reconcile with `reliable_km`

Verified after the change, at a 7-day window with `reliable_km: 95.2`:

```
192.9 km  record   "10 km past the nearest node we have reached"
191.5 km  record   "21 km past ..."
208.0 km  record   "21 km past ..."
```

`stepKm()` measures target-to-nearest-proven-point. With the furthest proven node 95.2 km
from home, a 192.9 km target is at least 97.7 km from it by the triangle inequality — so a
10 km step is impossible unless `proven` contains points that `reliable_km` does not see.

This is **pre-existing**, not introduced here: the same targets appeared with the same step
values before the change, and it is why the ladder's 25 km `window_km` failed to keep the
search near home. Filed as **B65**. Until it is resolved, lowering the bar admits nearer
targets but does not stop the far ones ranking.

## Invariants

- Every inference in node-dash is registered here or imported here. One place.
- No `db.js` import, no clock, no randomness.
- The engine never imports this file. The dependency runs one way.

## Test notes

`node tests/test_observatory_boundary.mjs` — each guard proved reached by
planting a violation and confirming the failure, then restoring:

| planted | failure |
|---|---|
| `import` in `src/node-label.js` | *"may be imported only by index.js and inferences.js. Found in: node-label.js"* |
| `import db from './db.js'` here | *"must not import db.js… the runner fetches evidence, the inference does not"* |
| `Date.now()` here | *"must be pure — found `/\bDate\.now\(/` outside a comment"* |

## Out of scope

- **The antenna-bearing estimator.** Its capture half is not an inference —
  recording where the antenna pointed is an *observation* — and the estimate
  itself is **blocked on data, not on code**: measured 2026-08-02, 305 recorded
  bearings span **two distinct azimuths, 119° and 120°**, because the rotator has
  not moved. An estimator over that would place every unplaced node at 119°, a
  confident wrong answer. It needs the antenna to sweep first.
- Anything that transmits. `MESH_REACH_SPEC` §9 is unanswered, and none of the
  four inferences here sends anything.


## The funnel must account for every node

Task `funnel-accounts-for-every-node`.

This module carried the comment *"THE EXCLUSIONS ARE PUBLISHED, not silent. A
shortlist that quietly drops most of the pool reads as 'these are the only
options'."* It was not true. Reconciled against the live store on 2026-08-03:

```
rows entering the loop : 607
skipped WITH a counter : 532
scored (candidates)    :   0
DROPPED WITH NO COUNTER:  75
```

### The unnamed exit

The classification chain ended in a bare `} else { continue; }`. A node that has
been **attempted**, has **not answered**, and sits **nearer than the period bar**
matches no branch, and left through it uncounted.

Not a rounding error: with `bar_km` at 176.4 that was nearly every node still
alive. It is why the shortlist was empty and the runner idle — *"not probing — no
candidates"* — with no explanation anywhere on the page. It is now
`skipped_unclassified`.

### The exclusion the loop cannot see

The evidence query's own `WHERE n.lat IS NOT NULL AND n.lon IS NOT NULL AND
n.lat <> 0` removes unpositioned nodes **before any counter exists**. All
**331** of them (174 heard within `max_silence_days`) appeared in no segment at
all — the largest exclusion, and invisible.

It cannot be counted in the loop, so it is counted in the **evidence**:

```sql
(SELECT COUNT(*) FROM nodes u
  WHERE u.lat IS NULL OR u.lon IS NULL OR u.lat = 0) AS unpositioned
```

Declared evidence rather than a query inside `run()` — the inference stays pure.

### `skipped_suspect` is not "no position"

It counts `km > CEILING_KM` (**250**) — implausible *computed* distances. **Every
one of those 127 nodes has a position.** The browser rendered it as "no position"
(`public/app-observatory.js:512`), which is how the figure was reported to Peter
as a position problem twice.

The key is unchanged — the datum was always correct, only its label was wrong —
and the summary now publishes `ceiling_km` so the browser states the rule rather
than inventing a meaning.

### The acceptance test is arithmetic, not appearance

```
rows_in === candidates + every skipped_* counter
```

Verified after the change: `607 === 0 + (127+189+152+14+50+75)` — **closes
exactly**. If it ever fails to balance, a path has gone unnamed again, and that
is a defect regardless of how the page looks.

`rows_in` is published for exactly this reason.

### What this deliberately does NOT do

No targeting behaviour changed. Not one node was added to or removed from the
shortlist. Whether discovery should keep probing once the bar rises past
everything alive is a design decision — see `chase-the-window-best` — and this
task only makes the current behaviour legible enough for that decision to be made
from the page instead of a hand-run query.


## The bar decides priority, not eligibility — the `retry` class

Peter, 2026-08-03: *"the ratchet keeps starving the queue - you have glossed over
that."* He was right; it had been flagged three times without being fixed.

The classification chain only gave an attempted-but-unanswered node a class when
`km > bar`. Everything alive and **nearer** than the bar matched nothing and was
dropped — so reaching 176.4 km once made every target under 176.4 km ineligible,
and the queue emptied while the mesh was busy.

### What was actually being thrown away

Reconstructed against the live store with the selector's own thresholds:

- **138 nodes**, **93 heard within 24 h**, **82 with fewer than 6 attempts**
- **59 had answered us before**
- the furthest sat at **176.4 km, heard 4 hours earlier, tried exactly once**

A node at the frontier, alive, barely probed, and invisible — purely because it
was not *past* the bar.

### The fix

`retry` — `hits === 0 && attempts < MAX_TRIES`, ranked **300 + liveScore −
attempts×25**, deliberately below every record class (1000+). It can never
displace a record attempt; it fills slots only when nothing better exists, which
is exactly when the queue used to empty.

The bar still decides **what goes first**. It no longer decides **what is
allowed**. Ranking and the per-class quotas already did the first job.

### Measured, immediately after deploy

| | before | after |
|---|---|---|
| `candidates` | **0** | **48** |
| `shown` | 0 | 6 |
| `skipped_unclassified` | 109 | 58 |
| funnel balance | closes | closes (624) |

The shortlist came back entirely `retry` at rank 675 — correct, because no
record-class candidate is currently eligible (all are beyond the step window,
silent, cooling or exhausted).

### What is left in `unclassified`

The remaining 58 are the long tail: nodes with 300–865 attempts and past hits
that fall through `reconfirm` for being nearer than 100 km or attempted within
7 days. A different defect, deliberately not swept in here.


## Relay capability is NOT a targeting boost (task `rank-by-relay-capability`, 2026-08-04)

The first design for this task added a rank bonus so relay-capable nodes were
*targeted* more often. Peter stopped it before it shipped:

> *"we should not waste time tring to get replies from touters, but we need to
> use them for what they are and not treat them as just another endpoint which
> they are not"*

He is right, and the bonus would have made the original defect worse in a new
direction. A `ROUTER` is **infrastructure, not a destination**. Its job is to
carry other people's traffic; whether it personally replies to a traceroute is
close to irrelevant, and spending the airtime budget trying to make it answer is
the same error as spending 88 attempts on `79fc`, only more expensive because
routers are further away.

**No change is made to the class ladder.** `nodes.role` deliberately does not
enter the ranking here.

The finding that prompted it — 31 relay-capable nodes within 250 km, none ever
our `route[0]` — is real, but the answer belongs in `doors.js`: prefer
relay-capable nodes when choosing and disambiguating a **door**. See
`docs/modules/doors.md`.
