---
module: reach
source:
  - src/reach.js
  - src/snapshot-api.js
  - src/doors.js
  - tests/test_doors.mjs
  - scripts/check_all.mjs
  - scripts/check_snapshot.mjs
source_hash: 0f04d2ffd1874e920e30652dc03ce50c08594f8f6654bdc17b684c1dcc93cf2c
updated: 2026-09-03
---

# reach — one module for the thing that is currently in eight files

Peter, 2026-08-23:

> look all of these bits and pieces belong together, it should not have taken 30
> mins to identify them

He is right, and **the time it took is the defect**, not a symptom of one. The set
has no name, no index and no boundary, so finding it means reading eight files and
noticing that three of them do the same thing.

## The set

```
engine        observatory.js                      archived 2026-08-18
catalogue     inferences.js                       archived 2026-08-18
store         obs_observation, obs_fact,
              obs_v_fact, obs_v_traceroute        LIVE, empty
live compute  snapshot-api.js  clusters.js
              reach.js  doors.js  terrain.js      LIVE, consumed by /events
raw tables    relay_observation  signal_history
              traceroute_history  nodes  terrain_grid
```

## It was not an evolution — it was parallel growth

Worth stating because it changes what "consolidate" means. Checked from git:

```
doors.js                          created 03 Aug
snapshot-api / clusters / reach / terrain   05 Aug
observatory archived              18 Aug
```

The live modules **predate** the archiving by two weeks. They did not replace
observatory and they are not a distillation of it — the two lines grew side by
side and the one that happened to survive is the one still running. So there is no
"latest version" to keep; there are two designs and a duplicated third.

## Five door implementations, three of them live and disagreeing

Three were found by reading. **Two more were found by fixing the first three** —
they only became visible once the board stopped agreeing with them.

| where | broadcast excluded? | how it was found |
|---|---|---|
| `doors.js:102,117,152` | **yes** — `filter(n => n !== BROADCAST)` | read |
| `snapshot-api.js:222` `distribution()` | **no** — only `d.num != null` | mesh-gw, reading our store |
| `inferences.js` `relay.usage` (archived) | **yes**, with the reasoning written down | read |
| `snapshot-api.js` `newGround()` `new_doors` | **no** | went red only after `distribution()` was fixed |
| `check_snapshot.mjs:53,61` | **no** | the check itself made the same omission |

The last two are the interesting ones. `check_snapshot.mjs` runs 54 assertions
over six windows comparing the board against independent SQL, and **all 54 passed
throughout**, because the check repeated the board's mistake. Two wrongs agreeing
is indistinguishable from correct, and no amount of re-running finds it: the
harness only went red when the code it checks was fixed.

`new_doors` was wrong on the **all-time window only** — the broadcast first
appears in `route[0]` at 2026-06-25, which is outside every bounded window — so
five of six windows agreed even after the exclusion landed. A defect visible in
one column of one window is one nobody reads as a defect.

Measured over the same 7-day window, same table:

```
snapshot-api's query   2404451644:11  3608510722:8  47500548:6  4294967295:5  …
with the doors.js filter   2404451644:11  3608510722:8  47500548:6  3851314899:2  …
```

`4294967295` is `0xFFFFFFFF`, the broadcast address. It is not a node and cannot be
a door. It is ranked **fourth** in what `/events` publishes.

**This is mesh-gw's reported defect 2**, found by them reading our store: *"4294967295
is ranked third in snapshot.distribution.doors at 39%, name '?'. That is
0xFFFFFFFF, the broadcast address — a broadcast counted as a relay."* Their window
differs from ours; the defect is the same.

And the archived catalogue had already solved it, with the reason recorded:

> *"it ranked eighth in the door list on first run, with 49 targets 'behind' it,
> which is meaningless."*

So the knowledge existed, was written down, and was lost — not because it was
wrong, but because it lived in a file nobody could find from the code that needed
it. That is the argument for the module, better than any principle.

## Scope — this is increment 1 of several, and the rest are named

Consolidating all five live modules in one change would be a rewrite of code that
`/events` consumers depend on today. **Not attempted here.** This increment
establishes the module and moves the one thing that is provably duplicated.

**In scope now**

- `src/reach.js` becomes the module's entry point and gains `doorUsage({ since })`
  — the single door-usage query, broadcast excluded — and exports `BROADCAST`, so
  the constant lives once in the module that owns door identity.
- `snapshot-api.js` `distribution()` calls it instead of its inline query.
- `snapshot-api.js` `newGround()` excludes the broadcast from `new_doors`. It is a
  *first-appearance* count over the same `route[0]`, not a usage ranking, so it
  cannot call `doorUsage()`; it takes the constant and states the rule.
- `provenLinks()` excludes it too. That one has **never actually leaked**, because
  `place()` needs a `nodes` row with a position and `0xFFFFFFFF` has none — an
  accident of the store, not a rule, and the day something writes that row it
  becomes a proven RF link to the broadcast address.
- `check_snapshot.mjs` restates the exclusion in its own SQL. It deliberately does
  **not** import `BROADCAST`: a check that imports the code it checks asserts only
  that the code equals itself.
- `doors.js` keeps `knownDoor` / `dominantDoor` / `relayDoor` / `doorAim`
  unchanged: those answer *aiming*, not *usage*, and its own chain filters already
  exclude the broadcast.

**Ordering is part of the contract.** `doorUsage` breaks ties on `num ASC`. Ties
in `uses` are common in a small mesh and SQLite's order within a tie is not
guaranteed, so before this the ranking could differ between two calls over the
same window — which makes "the top door" something no caller can test.

**Named, not done**

1. migrate `clusters` / `terrain` / `frontier` behind the same entry point
2. adopt the catalogue contract from `inferences.js` — declared evidence, pure
   `run(rows)`, provenance stamped by the runner, `null` a real answer
3. revive `obs_observation` persistence so a value can be recomputed over history
4. the table-level WS feed, which is the catalogue pattern exposed
5. drop `mission-runner.js` and the observatory UI on unarchive — actions are not
   part of this

## Why the catalogue is the shape to converge on

Not preference — it is the only one of the three that survived contact. From
`inferences.js`'s own header:

- **pure**: a function of evidence handed to it. No DB, clock or randomness
  inside. An inference *declares* its evidence and the runner fetches it, so it
  can be recomputed over history.
- **`null` is a real answer** — never thrown, never faked as zero.
- **no provenance by hand** — *"an inference that writes its own provenance can
  launder itself as a fact."*
- **one thing per function.**

`snapshot-api.js:222` breaks the first and the third: the query is inline with its
consumer, so it cannot be recomputed, tested apart, or found by anyone looking for
"how do we compute doors".

## Explicitly NOT changed

- `doors.js`'s aiming exports and its single consumer (`standing-tasks.js`).
- The `/events` message shape. `distribution.doors` keeps its fields; the broadcast
  row disappears from it, which is the point.
- The archived tarball. Nothing is unarchived in this increment.

## Test notes

`tests/test_doors.mjs`, registered in `check_all.mjs` as `doors` (service group —
it reads the live store; exits 127 if the db or driver is missing, which the
register reads as a mistrial rather than a conviction).

It asserts the **output** of `doorUsage()`, not the SQL. A test that greps for a
filter passes the day somebody writes a sixth query with the filter and a
different bug.

**Red first, 2026-08-23**, register entry
`broadcast-address-counted-as-a-door` — GUILTY, 1 of 1 runs failed. Green after:
8 checks, 0 failed.

| check | why it is there |
|---|---|
| no door is `4294967295` | the defect |
| every `num` an integer, every `uses` > 0 | shape |
| returned most-used first | "top door" has to mean something |
| two calls over the same window are identical | the tie-break |
| **not empty when the window holds completed traceroutes** | the control — a filter that removed everything would satisfy the broadcast check and be useless |

The last row is the one that stops this passing for the wrong reason. The test
also prints how many rows the raw table holds with the broadcast in `route[0]`
(**181** today), so a future green run says whether it was tested by live data or
merely unexercised.

**Live, over the socket the page actually reads** — `{type:'snapshot',days:7}`
after `pm2 restart`:

```
window 7d, doors_total 10
  2404451644  uses 11  E1     100%
  3608510722  uses 8   fir     73%
  47500548    uses 6   T4      55%
  1030966680  uses 2   TivN    18%
  2816444330  uses 2   PENS    18%
  3851314899  uses 2   EX5R    18%
```

`4294967295` had been **fourth at 5 uses**. It is gone, and the three-way tie at 2
is ordered by `num`.

`scripts/check_snapshot.mjs`: **54 checks across 6 windows, 0 mismatches** — the
board and independent SQL now agree on `doors_total` and `new_doors` for every
window, which they did not before (7d live=10 sql=11, 14d 12/13, 30d 15/16, all
19/20).

Regression: `npm run check` otherwise unchanged; `doors.js`'s aiming exports and
`standing-tasks.js` untouched.
