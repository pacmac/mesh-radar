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
and all three were false. **A fourth was found on 2026-08-06**, which is why this
section is the one to read twice:

| claim | truth |
|---|---|
| `nodes` has no `first_heard` | `nodeinfo.first_heard` — **1104 rows** |
| "cluster anchors carry no creation timestamp" | `clusters.created_at` — **52 rows**, all 2026-08-05 00:15:26 |
| "no send log is stored" | `alert_rules.last_sent` — most recent 2026-08-05 21:36 |
| "nothing separates an RF path from an MQTT-carried one" | `relay_observation.transport` — **132,674 rows** |

The fourth was not in a card. It was in a **spec and a served caveat**, which is
worse: it told every future reader the capability did not exist, and two commit
messages repeated it. Four for four. Nothing claimed absent in this codebase has
yet turned out to be absent.

**A claim inherited from a previous session's handover or spec is not evidence
either.** Checking the fourth one also caught a smaller error being copied
forward — that `TRANSPORT_INTERNAL` is "our own three locally-attached radios".
It is two of ours plus one stray row from a foreign node.

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

## Status, 2026-08-06

Four of the five below are closed. Detail follows; read the two method failures
above regardless, because they are what produced the list.

| | was | now |
|---|---|---|
| 1. LAYOUT | needed Peter's call between three bad options | **FIXED**, `08f1a70` — none of the three was needed |
| 2. AUDIT | every "cannot measure" claim suspect | **DONE** — health clean, but it caught a fourth false absence elsewhere |
| 3. VERIFY | `918df5e` rests on void evidence | **STILL VOID**, and the stated reason was wrong |
| 4. Housekeeping | 12 tasks unclosed, litter in the root | **DONE** |
| 5. RF vs MQTT | *(was not on this list, and should have been)* | **FIXED**, `cf6bd24` |

---

## 1. LAYOUT — 1280×800 needed internal scrolling — FIXED `08f1a70`

`tests/test_page_snapshot.py` now reports `cut 0` at 1600×1000 and 1280×800 in
both themes, 16/16 assertions.

**None of the three options this document asked Peter to choose between was
needed.** No health row was dropped, the hero was not shrunk, and no card scrolls.
The question was wrong because the cause was misdiagnosed as density. It was two
guessed numbers on the panel:

```
h-[calc(100vh-5.2rem)]   the parent chain ALREADY ends at the viewport
                         (measured 1280x800: parent top 39, bottom 800) — 36px thrown away
p-3                      the parent already applies p-3 — another 25px
```

61px, and every card below paid for it. The spec had justified the calc with
"h-full hung off screen by exactly the header height" — true of an older shell,
false of this one, carried forward for weeks as if measured.

The remainder came from density with nothing deleted: the five distance bands
were being separated by the card-body's *section* gap; health rows wrapped to
61px because a text-base label and a text-base value could not share a narrow
column. See `docs/modules/tab-snapshot.md`.

**The lesson is not about CSS.** Three attempts had been made at the wrong
problem, and the fourth was going to be asked of Peter. Nobody had measured where
the height was actually going.

## 2. AUDIT — DONE, and it found a fourth false absence

Every `value: null` + `reason` path in `snapshot-api.js health()` was read against
the schema. All six reasons are conditional on a genuine absence and none fires
today; the card renders 7 of 7 rows with real values.

But the same audit found the **fourth** false absence, in
`docs/modules/snapshot-api.md` — see item 5.

The prior stated here ("3 in 3") is now **4 in 4**. Nothing has yet been claimed
absent in this codebase and turned out to be absent.

## 3. VERIFY — `918df5e` still rests on void evidence

Measured 2026-08-06 over 739 post-fix traceroutes:

```
tx_device   beam_deg  aim_mode   n    rotator_az   route
OMNI          360.0     none    661        0        137
YAGI           35.0     none     74       74         20
```

The 20 yagi traces with routes cover three distinct first hops (TA2o 32.2°, T4
274.2°, fir 219.0°) against a beam parked at 18.86°–20.89°. The only nominal "in
beam" hit is our own OMNI 0.8 km away. **That re-measures nothing**, and the
12.9% figure stays un-re-measured.

### RETRACTED: "the mode gates aiming"

An earlier version of this section said the aim path *"is not executing because
the mode says not to"*, and that unblocking it needed a mode change from Peter.
**Both were wrong.** Peter, 2026-08-06: *"ACTV and SCAN are modes that use the
pointer, but they do not control or gate it."* The code agrees —
`traceroute.js:343`:

```js
const want = aimOpt ?? modeAim(modeKey) ?? 'none';
```

The **caller's** `opts.aim` wins. The mode is only the fallback when a caller
supplies nothing. Two further errors in the same claim:

- **`aim_mode:'none'` does not mean the beam was unaimed.** It means *traceroute
  did not do the aiming*. In SCAN the sweep already put the beam on the contact's
  bearing (`lifecycle.js:32`) and in ACTV the tracker has already pointed at the
  target (`lifecycle.js:80`) — both pass `aim:'none'` deliberately, so run() does
  not fight them. The beam is aimed; traceroute just did not move it.
- **661 of the 736 rows are the OMNI**, which can never be aimed at all
  (`traceroute.js:359` records `'none'` for any non-rotator radio). Quoting 736
  as one population mixed a hard radio constraint with a policy decision.

So this needs **no mode change and no decision from Peter**. `rotator_az` is the
real beam position at transmit time whoever set it, so the measurement is
available — what is missing is traffic where the beam is actually being driven.

**How the error was made, since it is the same shape as the four false
absences:** the causal claim was read off the `/config/modes` table — pasv says
`aim:'none'`, therefore the mode gates aiming — instead of off the one line of
code that consumes it. A config value that *looks* like a switch is not evidence
that anything reads it as one.

Related, and easy to misread: pre-fix the unaimed beam covered 191 distinct
azimuths across the full circle; post-fix, 14 within 2°. The slewing stopped
because nothing was driving the rotator, **not** because the hold bug in `_aim()`
was fixed. It is still there and will bite whenever the scanner or tracker is
driving the beam again. See `yagi-unaimed-fallback`.

## 4. Housekeeping — DONE

Seven tasks closed after verifying each against the repo rather than its own
marks (`packet-provenance-capture`, `rate-by-band-by-day`, `observatory-window`,
`verdict-strings-to-backend`, `strip-browser-verdicts`, `passive-tracer-starved`,
`retro-ungated-work-20260805`).

`backfill-stranded-positions` was **reopened**: marked complete with nodes still
stranded. Re-verified — 1 remains (`!f68e1508` TCm2), down from 2.

Still unclosed and deliberately not touched: `set-yagi-az` (another session was
active on it) and seven `ltc-*` tasks (different project, mis-filed here).

Loose PNGs and `.spdchk.mjs` moved out of the repo root. The `doc` symlink
remains — it points into `pac-garage-alarm` and is not this repo's to delete.

## 5. RF vs MQTT — the caveat was FALSE — FIXED `cf6bd24`

Not on the original list, which is itself the finding: the endpoint was telling
the browser that RF and MQTT could not be told apart, citing
`packet-provenance-capture` as unlanded. It had landed.
`relay_observation.transport` holds 132,674 rows, and every node past 150 km is
100% LoRa.

The replacement is deliberately **narrower**, not opposite: LoRa proves the final
hop into our gateway was radio, not that the whole path was.

**And the part that nearly became the next false claim:** `relay_observation`
only begins 2026-08-03 07:39:39. `lora: false` means NO PROVENANCE RECORDED,
never "MQTT" — all 329 all-time nodes without a LoRa row have zero rows of *any*
transport. `provenance_since` and `lora_covers_window` are served so no consumer
has to know that from a document.

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
