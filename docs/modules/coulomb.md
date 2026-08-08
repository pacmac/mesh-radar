---
module: coulomb
source: src/coulomb.js
source_hash: 6bd67057b84b9dcd8743483e04af03fdf1318c19ec5c2caa0f936066bf1c247b
updated: 2026-08-08
---

# Module: coulomb

## Purpose

Turns pac-host's raw coulomb-counter series into a **display-ready model** for the
alarm unit's Stats pane. Domain 1: every derivation, every verdict and every
formatted string is decided here, because `docs/BROWSER_CONTRACT.md` gives the
browser none of those.

Peter, 2026-08-08: *"device is now pushing the coulomb count… but it is invisible
to me in node-dash."*

**The measurement is `(n1 - n0) / hours`.** Everything else exists to support it
or to stop it being reported when it would be a lie.

## Why a module and not a few lines in pac-host.js

`pac-host.js` is a proxy and a poller — it knows nothing about what the fields
mean. Putting the subtraction there would put business logic in the transport
boundary. Same split as `snapshot-api.js` and `node-status.js`: the fetch is one
thing, the model is another.

Not to be confused with `src/observations.js`, which is the mesh-reach packet
producer and unrelated despite the name.

## The three fields, and which one to trust

| field | meaning |
|---|---|
| `n` | RAW accumulated-charge count, integer, unscaled. **THE ONE TO SUBTRACT ACROSS.** |
| `cons` | the same charge as whole mAh. DERIVED, LOSSY, scaled by a constant nobody has confirmed — discards ~25x of the hardware's resolution |
| `grst` | present ONLY when the gauge came back zeroed. **DO NOT SUBTRACT ACROSS IT.** |

`n` is the headline. `cons` is served for cross-checking and must never be the
headline.

**`n` is NOT converted to mAh or to a percentage.** `qLsb` is unverified and
device has retracted three attempts at it. A stored raw count can be re-read
correctly the day the factor is known; a number already multiplied by a wrong
constant cannot, and a percentage on a dashboard will be believed. Converting
requires a joint decision with services and a factor stated by device.

## THREE STATES, NOT TWO — and today there are four

An empty array does not mean "no gauge". Services' contract
(`node-dash--services` #87):

| state | how it is known |
|---|---|
| `not_fitted` | the `ltc` verb answers `{ok:false, why:"not fitted"}` and NEVER zeros |
| `no_samples` | fitted, empty array — a new unit, or one just updated |
| `has_samples` | rows |

**`unknown_gauge` is a fourth state this module serves TODAY, and it is the
honest one.** Verified live 2026-08-08: `GET /v1/mesh/devices` carries no field
on either unit matching ltc/coul/gauge/fitted, and `GET /v1/mesh/obs/!8cee336b`
(GARG) returns `[]`. So the first two states are **not currently
distinguishable**, and claiming either would be inventing a fact.

Services offered to serve the state explicitly and node-dash accepted (#89). When
that field lands, `unknown_gauge` collapses into `not_fitted`/`no_samples` and
this module changes in one place. Until then it says what it does not know.

Collapsing these misreports a unit twice: while it has no gauge, and again on the
day it is fitted and genuinely has nothing recorded yet.

## grst — a BREAK, not a point

A span crossing a `grst` **REFUSES** rather than returning a number. The count
restarted, so the subtraction across it is arithmetic on two unrelated origins
and yields a fabricated current that renders perfectly.

**Not verified against real data.** No `grst` row has ever been stored — measured
2026-08-08 across all 1000 stored BNCH rows: `n` x500, `cons` x500, nothing else.
The refusal path is covered by a synthetic fixture in `tests/test_coulomb.mjs`
and is recorded here as untested-in-production rather than claimed as proven.

## Ordering is asserted, not assumed

Services state rows arrive oldest-first. Verified 2026-08-08 as ascending across
1000 rows — **and asserted anyway on every call**, because the operation is a
subtraction: a descending list flips its sign and **a discharging cell reads as
CHARGING**. A silent re-order upstream would otherwise be invisible. The guard
costs one comparison.

Their `limit` takes the NEWEST n, so a plain call is the recent end, not the
start. This was broken on their side until 2026-08-08 (returned rows four days
older than the newest sample, with nothing indicating it — reads as a frozen
gauge, i.e. as a dead pipeline, the opposite of the truth).

## Milliseconds in, seconds out

pac-host stamps `at` in **milliseconds**. This repo's convention is epoch
**seconds** (`observations.js`), and `fmtAgo(ts, nowSec)` takes seconds. The
conversion happens once, at this boundary. Getting it wrong yields an age ~56000x
too large, which is obvious, or a silently wrong rate, which is not.

## Public interface

### `buildCoulomb(unit, { spanHours } = {}) -> Promise<model>`

`unit` is pac-host's `!hex` id. **Short names do not resolve** — verified
2026-08-08, `/v1/mesh/obs/BNCH` errors even though BNCH is in the roster (raised
with services, #90). Callers pass `numToNodeId(num)`.

Returns a model whose every string is render-ready:

```
{
  unit, state,                         // 'has_samples' | 'no_samples' | 'not_fitted' | 'unknown_gauge'
  empty_reason,                        // display string when state !== 'has_samples'
  latest: { n, at, at_text, ago } | null,
  current: { value_text, span_text, refused, refused_reason } | null,
  series: [ { at, n } ],               // ascending, for the line
  breaks: [ at ],                      // grst positions, drawn as breaks
  cons_latest,                         // cross-check only, never the headline
  caveat,
}
```

`current.refused` is true when the span crosses a break; `value_text` is null and
`refused_reason` says why. The browser prints `refused_reason`; it does not decide
anything about it.

## Invariants

- rows are ascending by `at`, or the call throws rather than subtracting
- a span containing a `grst` never yields a number
- `state` is never inferred from an empty array alone
- no mAh, no percentage, no `cons` headline
- every field the browser renders is a string or a number decided here

## Test notes

`tests/test_coulomb.mjs` — pure-function tests over fixtures, no network:
ascending guard rejects a descending list; grst refusal; ms→s conversion;
`unknown_gauge` for an empty array with no fitted field; `has_samples` arithmetic
against a hand-computed rate.

## Out of scope

- rendering — Domain 2, `public/plugins/alarm/`
- storing anything. pac-host owns the store; this reads through it
- `/v1/mesh/loss` and `/v1/mesh/unconsumed`, documented in the same services
  contract and deliberately not consumed yet
