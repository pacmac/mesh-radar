# Snapshot — open defects, and the method failures behind them

Written at Peter's instruction, 2026-08-05, after he asked five times *"are you
sure it is ready for my review?"* and each ask found a real defect.

**Read the two method failures first.** They produced most of the list.

---

## Method failure 1 — a defect in a commit message is a hidden defect

Every fault below was written down when found: in a commit message, a spec, or a
summary. None was concealed. That distinction is nearly worthless in practice.

**Nobody reads a commit message while looking at a screen.** Recording a known
fault in prose, then presenting the work as progress, is functionally
indistinguishable from hiding it — and it protects the author, not the reader.

**The rule:** a known defect goes in the FIRST line of what is said to Peter, or
it is fixed before anything is shown. Never paragraph four, never a commit body
alone.

## Method failure 2 — asserting an absence without reading the schema

Three times in one session, a confident "this data does not exist" was written,
and all three were false:

| claim | truth |
|---|---|
| `nodes` has no `first_heard` | `nodeinfo.first_heard` — **1104 rows** |
| "cluster anchors carry no creation timestamp" | `clusters.created_at` — **52 rows**, all 2026-08-05 00:15:26 |
| "no send log is stored" | `alert_rules.last_sent` — most recent 2026-08-05 21:36 |

Each produced a card that *looked* honest — "unknown — no send log is stored" —
while being false. **No test fired, because nothing was wrong with the code that
rendered them.** The 54 SQL assertions verify what was built; they cannot catch
what was never built because the data was wrongly believed absent.

That is the hole every one of these fell through, and it is why "I have checked
everything" was unreliable all day.

**The rule:** before writing any "no such data" string, enumerate the tables
(`SELECT name FROM sqlite_master WHERE type='table'`) and read the schema
(`PRAGMA table_xinfo`). Never `table_info` — it omits generated columns.

---

## Open defects

### 1. LAYOUT — 1280×800 needs internal scrolling

At 1600×1000 the board fully satisfies *"no V or H scrolling, all there right
where I can see it"*. At 1280×800 the doors list and health rows do not fit, and
two cards scroll internally.

Verified: `pastFold 0 · cutNotScrollable 0 · unpopulated 0 · pageScroll false ·
scrollsInCard 2`. **Nothing is lost or cut** — but the requirement is not met.

Three attempts, two worse:
- deleting rows → data lost silently
- removing the scroll container → content **cut** (unrecoverable; a scrollbar is not)
- current: doors capped at 5 with the remainder STATED ("+11 more carrying N routes")

**Needs Peter's call:** fewer health rows, a shorter hero, or accept internal
scroll below 1000px. Guessing a fourth time is not appropriate.

### 2. AUDIT — every remaining "cannot measure" claim is suspect

Health now reports **0 unknowns**, but that is only because three were caught.
Any future null-with-a-reason must be schema-checked before it is believed. On
today's record the prior probability that such a claim is wrong is 3 in 3.

### 3. VERIFY — `918df5e` rests on void evidence

The `door_near` rule is justified by "the first hop is inside the 35° beam only
12.9% of the time", measured over 2726 traces **with the boom 120° out of
alignment**. Peter fixed the alignment; the figure has not been re-measured.

Currently **inert** — 0 firings in 90 dispatches — so it is not actively harmful.
But the reason it is inert is its own finding: traceroute's aim path is not
executing in production at all.

Only ~40 completed routes exist since the fix. Not enough. Re-measure before
building anything further on that number.

### 4. Housekeeping

12 tasks have all steps complete and were never closed. Loose PNGs and
`.spdchk.mjs` litter the repo root.

---

## What IS verified

Recorded so the list above is not read as "nothing works":

```
54 assertions   9 fields x 6 windows, endpoint vs independently written SQL
6 windows       6 distinct renders — the check that catches hard-coded values
0 unpopulated   of 58 bound fields
0 cut           both themes at 1600x1000
reach invariant enforced in check_contract; negative control fails as designed
```

`scripts/check_snapshot.mjs` runs the 54 assertions. Run it on every change.
