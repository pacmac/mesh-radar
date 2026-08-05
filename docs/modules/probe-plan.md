---
module: probe-plan
source: src/probe-plan.js
source_hash: b944b58301fe4990639cf196cbc190134c4d317caa0a7ed943496d6b66d57d22
updated: 2026-08-05
---

# Module: probe-plan

Peter, 2026-08-05:

> the traceroute for different classes based on distance, proximity etc can
> include a route table array with key-verbs as a list of sequential actions /
> methods. this will also allow us to tweak them without needing to touch the
> source code.

> we may find that repeating a step in the array or switching them around gives
> better results, but the hard part will be in defining the verbs and probably
> args for maybe repetitions.

## Why

Over 30 days, **443 targets were attempted more than once for 21,395 attempts** —
and by construction every repeat was the **same experiment**. The aim was derived
from `(target, mode)` with no attempt index, so attempt 40 was identical to
attempt 1.

`callout.js` has varied its probe per target since the day it was built
(`eligibleTemplates` picks a template *not recently used on that node*). The
machinery existed next door and traceroute never used it.

## The sequence is a SCHEDULE, not a script

Repetition, not variation, is where the yield is:

| 30 days | |
|---|---|
| targets attempted | 560 |
| never answered | 454 (81.1%) |
| answered on the **first** try | 19 (3.4%) |
| **answered only on a later try** | **87 (15.5%) — 82% of all successes** |

Gap between the failed attempt and the one that worked: p25 **29 min**, median
**62 min**, p75 **5.6 h**, p90 63 h.

So a step can say "try again in an hour", which means position in the sequence
must **survive restarts**. `traceroute._pending` is an in-memory Map that dies on
every restart — and pm2 watches `src/`, so it dies whenever anyone edits a file.
Hence `probe_state`.

## Two kinds of variation, deliberately separated

| | answers | scale |
|---|---|---|
| **spatial** — `aim` / `radio` / `target` | "we don't know the path" | immediate |
| **temporal** — `repeat` / `every_min` | "they weren't listening" | hours |

The measurement says temporal dominates, so a plan that only varies the aim is
optimising the minority case.

## Verbs — small and CLOSED

```
aim     auto | door | endpoint | bypass | none
radio   auto | omni | yagi
target  endpoint | door | hop2
args    repeat (1..20) · every_min (0..10080) · timeout_sec (5..600)
```

An open-ended DSL in a config file becomes a language nobody can validate, and
the failure mode is a silently-ignored step — which *looks like it ran*. Plans are
validated on write; unknown keys and out-of-range args are rejected.

**`target` is the verb that is not obvious and matters most.** Pointing at a relay
only biases who hears us — the mesh still chooses the path. **Tracerouting the
relay itself proves the direct link outright**, and that is the cheap experiment
nothing currently runs.

## State and advancement

`probe_state(to_num, plan_class, step_index, step_tries, last_ts)`.

- `nextStep()` returns `null` with a reason when the plan says **wait** — that is
  the schedule working, not a failure. The caller must move to another target.
- `recordAttempt()` is called at **dispatch** time, not at result time. A step
  that was tried and timed out has still been tried; advancing only on success is
  how a plan sticks on step 0 forever.
- A **class change restarts the plan** — the target is a different question than
  it was, so its old position means nothing.
- A **reply clears the state**: nothing further is learned from probing something
  that just answered.

`plan_class` and `step_index` are written onto every `traceroute_history` row.
Without them an escalating sequence is exactly as unattributable as a fixed one —
the same hole that made aiming unevaluable for months.

## API

`GET /config/probe-plans` → plans, verbs, step keys.
`PUT /config/probe-plans` → validated, logged as a config event.

## Verified 2026-08-05

Simulated over the `retry` plan:

```
attempt 1          step 0  (repeat 2, every 60m)
again immediately  WAIT — 60 min
+61 min            step 0  (2nd)
+61 min            WAIT — 59 min
+121 min           step 1  aim:endpoint radio:yagi (repeat 2, every 120m)
+121 min           step 1  (2nd)
+121 min           step 2  target:door
+121 min           WAIT — plan exhausted
```

State row persisted to SQLite between calls.
