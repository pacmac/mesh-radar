---
module: hooks
source: src/hooks.js
source_hash: c4a7e89e57d5b9cd99d4c964dbbcaded89b71db9211a403db6bc72479e16f82e
updated: 2026-08-03
---

# Module: hooks

Task: `event-log`. The foundation the decision trace, the logs page and the timeline all
stand on.

## Why this exists

Peter, 2026-08-03: *"that was the whole idea behind hooks, and the beauty of hooks is they
can describe what they are doing."* And, decisively: *"otherwise hooks may just as well be
small funcs integrated into the core code."*

That is the whole justification. Registration, naming and a pipeline are pure ceremony
unless a hook is **obliged** to say what it is and report what it did. The obligation is
the feature.

Every failure found on 2026-08-02/03 was a step that ran and said nothing:

| what happened | why it was invisible |
|---|---|
| passive tracing off 9.5 h | `if (dashMode.value !== 0) return;` — a gate with no voice |
| the beam 148° off | the action succeeded; the *decision* left no trace |
| 191 candidates dropped | a filter with no announcement |
| `traceroute.enabled` false 5 days | a switch with no consequence on screen |

None is a missing log line. They are steps with **no obligation to speak**. A logging call
next to a decision depends on someone remembering; a contract does not.

## The registry is addressable by scope

Peter, 2026-08-03: *"shouldnt hooks be an object: {'per-node':{do this(), do that()}, xxx:
{xxx(), yyy()} - effectively addressable"*.

```js
hooks['per-node']['select-target'].emit({ ... })   // one, by name
Object.values(hooks['per-node'])                    // the probe steps, in order
```

A flat list makes every consumer filter; this makes the grouping structural. **Insertion
order is preserved for string keys, so registration order is execution order** within a
scope — load-bearing for `per-node`, whose steps are a sequence, so they are declared in
the order they run.

Names remain globally unique despite the nesting: `event_log.source` is a bare name, and a
collision would make the log ambiguous exactly where it is read.

## The contract

```js
defineHook({
  name:    'select-target',
  purpose: 'picks the highest-ranked candidate from the shortlist',
  scope:   'per-node',            // 'store' | 'per-node' | 'per-mode'
  modes:   ['disc'],              // per-mode only
})
```

`name`, `purpose` and `scope` are **required**. A hook that omits any of them throws at
registration — which is what makes "add a step that says nothing" impossible rather than
merely discouraged.

### Three scopes, because they fire differently

| scope | trigger | gets | example |
|---|---|---|---|
| `store` | a cadence | the database | ghost-relays, asymmetric-paths |
| `per-node` | a probe | `probe_id` + one target | select, history, dispatch |
| `per-mode` | a mode permitting it | the mode | passive tracing, scanner |

**`per-mode` is today's headline bug made structural.** Passive tracing carried its mode
rule as a bare `dashMode.value !== 0` inside the consumer; declaring `modes: ['pasv','disc']`
puts the list where `dash-mode.js` owns it, makes it enumerable, and means a hook cannot
hold a hidden mode check. The 9.5-hour silence becomes impossible rather than lucky to
catch.

A declared scope can be inspected. An inline conditional cannot.

## The pipeline is enumerable

`listHooks()` answers *"what does this system execute, in order, and what does each claim
to do?"* without reading code. That is the direct answer to the original complaint that the
logic is hidden, and logging alone cannot provide it.

## Emitting

```js
hook.emit({ summary: 'chose REGM 100.1 km — rank 1 of 3, 21 km past proven ground',
            detail:  { num: 3663958688, km: 100.1, rank: 1 } })
```

`summary` is **written at the decision site**, never assembled downstream. A trace whose
strings are composed elsewhere reintroduces the hiding it exists to end — the same rule as
the verdict basis strings in `boardVerdicts()`.

**Reporting nothing found is mandatory.** `ghost-relays: 82 route members checked, 0
unknown` is evidence the mesh is mapped; silence is indistinguishable from the hook being
broken. That distinction is exactly what the passive tracer failed.

## `event_log`

```
id, ts, kind, severity, summary, detail, source, probe_id
```

One table, three views:

- `kind IN (config, deploy, mode)` → the change timeline, marks on the board's sparklines
- `GROUP BY probe_id` → the decision trace for one probe
- everything → the logs page

`probe_id` is NULL for anything that is not part of a probe.

### Volume and retention, decided up front

~50 probes/hour × ~5 events ≈ **6,000 rows/day**. An order more than system events, far
less than `relay_observation` (~29k/day). `event_log.retain_days` defaults to **30**,
clamped 1–365, pruned inline on the same counter pattern `relay-observation.js` uses.

**The raw feed stays out.** ~50 attempts/hour, 216–468 receptions per 15 min and every
mission start belong in `traceroute_history` / `relay_observation`. A probe trace is 5 rows
per probe, not 500 — the log's value is inversely proportional to its volume.

### The dead `events` table is left alone

`events (id, ts, type, device, data)` exists, is indexed, and **nothing has ever read or
written it** — the only greps that match are `import { EventEmitter } from 'events'`. It
has no `summary` column and is the wrong shape. Dropping it is destructive and buys
nothing; it stays untouched.

## Deploy events come free

`pm2 watch is OFF` (verified 2026-08-03: `watch & reload: ✘`, 72 restarts). Edits do not
auto-deploy, so **every restart is deliberate** — which makes a boot entry stamped with the
git SHA a reliable deploy marker. That is Peter's "changes in logic", captured
automatically rather than by anyone remembering.

## Exact changes

### `src/hooks.js` (new)

- `hooks` — the registry, `{ store: {}, 'per-node': {}, 'per-mode': {} }`, addressable by
  scope then name.
- `defineHook({name, purpose, scope, modes})` → a handle with `.emit()`. Throws on a
  missing name, purpose or scope, on `scope: 'per-mode'` without `modes`, and on a
  duplicate name.
- `listHooks()` — the enumerable pipeline.
- `logEvent({kind, severity, summary, detail, source, probe_id})` — the direct path for
  events that are not hook emissions (config, deploy).

### `src/db.js`

- `CREATE TABLE IF NOT EXISTS event_log` + indexes on `(ts DESC)` and `(probe_id)`.
- `insertEventLog`, `recentEventLog(limit)`, `pruneEventLog(days)`.

### `src/config-api.js`

- `DEFAULTS['event_log.retain_days'] = 30`.
- Both PUT routes log a `config` event beside the existing `broadcastSettings()` call —
  one existing call site each, no new plumbing.

### `src/index.js`

- One `deploy` event at boot carrying the git SHA.

## Explicitly NOT in this task

- Converting `mission-runner`'s phases to hooks (next task — it is the consumer).
- The standing analysis tasks (ghost-relays, asymmetric-paths).
- The Logs sub-page and the timeline overlay — Domain 2.
- The 12 unrelated `setInterval` loops (`imap-receiver`, `alarm-images`, `pac-host`).
  Discovery path only; consistency elsewhere is scope creep.

## Verified 2026-08-03

```
rejected: no purpose            → "purpose is required — a hook that cannot say what it is for is a function"
rejected: bad scope             → "scope must be one of store, per-node, per-mode"
rejected: per-mode w/o modes    → "scope 'per-mode' must declare which modes it runs in"

deploy  started 8ca6150 — feat(board): show the selection funnel …
config  traceroute.enabled: true → false     severity notice
config  traceroute.enabled: false → true
window_days entries: 0                        (excluded on purpose — a view change, not a system change)
```

## Invariants

- A hook without a name, purpose and scope cannot be registered.
- `summary` is written at the source; nothing downstream composes it.
- A hook that finds nothing still emits.
- Emitting never throws into the caller — a broken log must not stop the work it describes.
- The raw packet/attempt feed never enters `event_log`.
