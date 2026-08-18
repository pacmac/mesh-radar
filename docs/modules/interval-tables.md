---
module: interval-tables
source:
  - vendor/meshtastic-android/FixedUpdateIntervals.kt
  - scripts/gen_interval_tables.mjs
  - src/interval-tables.js
source_hash: f573ec0d01c2870e734c65496ff49f06d480d93097844e4aa9a75a46b7ce5481
updated: 2026-08-18
---

# The interval tables are generated, and drift is a red check

Peter, 2026-08-18: *"my guess is you did a 1 time export of the schema. this
should be a script"*.

He was right, and the situation was worse than the guess. The tables in
`src/interval-options.js` were typed in by hand from a copy of the app's
`FixedUpdateIntervals.kt` that existed **only in a session-scoped scratchpad
directory**. `find / -name FixedUpdateIntervals.kt` returned that one path. Once
the session ended, the numbers in `src/` would have become folklore with a
citation attached — unverifiable by anyone, including me.

## What the hand-transcription got wrong

Fifteen of the sixteen configurations were byte-for-byte correct. `ALL` was not.

The app defines it as `FixedUpdateIntervals.entries` — **enum declaration
order** — and four members were appended to the enum after `ALWAYS_ON`:

```kotlin
SEVENTY_TWO_HOURS(72.hours.inWholeSeconds, ...),
ALWAYS_ON(Int.MAX_VALUE.toLong(), ...),
EIGHTY_SECONDS(80.seconds.inWholeSeconds, ...),
NINETY_SECONDS(90.seconds.inWholeSeconds, ...),
EIGHT_SECONDS(8.seconds.inWholeSeconds, ...),
FORTY_SECONDS(40.seconds.inWholeSeconds, ...),
```

So the app's real order ends `… 259200, 2147483647, 80, 90, 8, 40`. I wrote it
ascending: same 34 values, different order.

**The error was not a typo — it was an improvement.** I made the data tidier than
its source, which is the one thing a port must never do, and no test could have
caught it because every test I wrote asserted the values I had typed. That is the
argument for generating rather than transcribing, stated better by the failure
than by any principle.

It was harmless *today* only because `ALL` is mapped to no field in
`FIELD_CONFIGURATION`, so nothing renders from it. That is luck, not correctness.

## The split, and why the boundary is where it is

| file | origin | may be hand-edited |
|---|---|---|
| `vendor/meshtastic-android/FixedUpdateIntervals.kt` | upstream, copied verbatim | **no** — replace wholesale when re-vendoring |
| `src/interval-tables.js` | **generated** from the above | **no** — the check fails |
| `src/interval-options.js` | ours | yes |

`FIELD_CONFIGURATION` stays hand-written in `interval-options.js` and is
deliberately **not** generated. It maps *our* schema field names to the app's
configuration names, and that correspondence exists nowhere in
`FixedUpdateIntervals.kt` — it comes from the app's individual settings screens
(`TelemetryConfigItemList.kt` and its siblings), one `DropDownPreference` at a
time. Generating it would mean parsing a dozen Compose files to recover a mapping
that is a dozen lines long. The honest boundary is: **what upstream states, we
generate; what we infer, we write and own.**

## The generator

`scripts/gen_interval_tables.mjs` parses the vendored Kotlin:

1. **The enum members** — `NAME(<expr>, ...)` — resolving Kotlin duration
   expressions (`30.minutes.inWholeSeconds`, `Int.MAX_VALUE.toLong()`,
   `TimeConstants.ONE_HOUR.inWholeSeconds`) to integer seconds.
2. **The `when (this)` arms** of `IntervalConfiguration.allowedIntervals`, mapping
   each `FixedUpdateIntervals.NAME` reference back to its value.
3. **`ALL -> FixedUpdateIntervals.entries`** is special-cased to mean *every
   member in declaration order*, which is exactly what got transcribed wrong.

It writes `src/interval-tables.js` with a generated-file banner naming the script
and the vendored input.

**It resolves names, never re-derives numbers.** If a member appears in a `when`
arm that the enum does not define, or a duration expression is in a form it does
not recognise, the generator **throws** rather than emitting a plausible number. A
generator that guesses is a hand-transcription with extra steps.

## The drift check

`--check` regenerates in memory and compares against the file on disk, exiting
non-zero on any difference. Registered in `scripts/check_all.mjs` as
`interval_tables` (group `fast`), so it runs on every `npm run check`.

It catches both directions:

- somebody hand-edits `src/interval-tables.js` → red
- somebody re-vendors a newer `FixedUpdateIntervals.kt` and forgets to regenerate
  → red

What it does **not** catch is upstream changing while our vendored copy sits
still. Nothing local can detect that, and pretending otherwise would be a false
absence. `vendor/meshtastic-android/PROVENANCE.md` records the URL, the upstream
path and the date fetched, so a human can compare deliberately. Stated as a limit
rather than hidden.

## Test notes

- the generator reproduces `src/interval-tables.js` byte-for-byte (`--check`
  exits 0 on a clean tree)
- editing a single value in `src/interval-tables.js` makes `--check` exit non-zero
- `ALL` is in **declaration order** and ends `2147483647, 80, 90, 8, 40` — the
  specific thing the hand-port got wrong
- all 34 enum members resolve, and every value is an integer
- an unresolvable member reference makes the generator throw, not emit
