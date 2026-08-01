# mesh-reach — founding specification

**Status:** founding spec. Written in node-dash (task `mesh-reach-founding-spec`,
2026-08-01) from Peter's redirection of the project's goal. **Nothing is built.
One structural decision (§9) must be answered before any code is written**, and
it decides which repository this lives in.

**One sentence:** stop measuring how far we can *hear*, and start measuring how
far we can *reach* — then attack the difference.

---

## 1. The change of goal

Peter, 2026-08-01, verbatim:

> "so far I have focussed the design around the radar, my goal was to always try
> and get further nodes directly, when in reality that's unlikely to increase a
> great deal because of my geographic location. the goal really is to see how far
> out into the known mesh I can get, and then focus our attention on it… meaning
> that we would do things like repetitive traceroutes and public bc messages
> … so we can at least get a reply or a bc so we can confirm we hit it… look deep
> into the mesh, gather data, find the x number of most remote locations, test the
> mesh and verify as a hit or a miss, and that is repetitive, we keep trying, but
> not so much as to become a nuisance. in a few words how far can we get"

The old question was **reception**: what can this antenna, at this location, hear
directly. It is bounded by geography and Peter is right that it is near its
ceiling.

The new question is **reach**: how deep into the mesh can a packet of ours travel
and be *confirmed* to have arrived. That is bounded by the mesh's own topology,
not by our horizon, and it is a far larger space. It is also asymmetric — their
hop count to us is not our hop count to them, and the return path is a different
route from the outbound.

**The gap between the set we can hear and the set we can reach is the product.**
Everything in this document exists to measure that gap and then close it.

## 1a. The headline value is kilometres

Peter, 2026-08-01: *"at the end of all calculations the single important value
will be in km."*

Hops are a proxy and a poor one — a seven-hop chain around a valley may cover
less ground than a two-hop shot across it. **Every calculation in this system
resolves to one number: the furthest distance at which reach has been
verified.** Hop count, SNR, route and bearing are diagnostics that explain the
kilometres; they are not the answer.

**The current record, computed 2026-08-01 23:43 from `traceroute_history` joined
to stored node positions, great-circle from `home` (51.0263296, −3.1588352):**

| | |
|---|---|
| **furthest verified reach** | **189.1 km** |
| verified beyond 150 km | 8 targets |
| verified beyond 100 km | 13 targets |
| targets ever verified | 104 |
| …of those, with a known position | 84 |

The far cluster is real and identifiable: **Carbis Bay and St Ives** in Cornwall
at 187.7 km, and a group of **Guernsey** nodes at 177–182 km. Most carry a single
confirmed hit — these are rare, fragile paths, not standing links, which is
exactly §4's point about reach being probabilistic rather than binary.

### The record ladder

The frontier's history is already in `traceroute_history` and reads as a ladder —
every moment the verified maximum moved, computed 2026-08-01:

```
24 Jun 10:59     5.3 km   Preston~Bowyer
24 Jun 11:42    24.7 km   Tiverton N Repeater G4ZA
24 Jun 11:43    43.0 km   M7FJD~Base
24 Jun 11:44    67.5 km   G0MOH Solar
24 Jun 12:01    92.0 km   Mr B's number 2
24 Jun 19:06    95.2 km   MrBs portable mesh
25 Jun 05:23   181.6 km   GCM0004 St Peters Village, Guernsey   ← first past 100 km
 4 Jul 15:43   189.1 km   (unnamed node 3663958688)
```

Peter's phrase for the 25 June entry — *"our first hit over 100 km"* — is the
right framing, and the ladder is the product's narrative. Note what it shows:
**the entire climb happened in about eighteen hours, and the frontier has moved
7.5 km in the five weeks since.** A system that iterates without learning
plateaus, and this is what the plateau looks like.

**Milestones are first-crossings and must be stored as such** — the first
verified hit past each threshold, with its target, route and timestamp. They are
derived from the event log (§5), never recorded separately, so a corrected or
retracted hit re-derives the ladder rather than leaving a false record standing.

**The binding constraint on this metric is position coverage.** Only 84 of the
104 verified targets have a position, and only 122 of 211 known nodes do. For the
rest the reach is real but the kilometres are unknown, and the honest headline is
therefore *"≥ 189.1 km verified"* — never a claim about the maximum. Improving
position coverage is a legitimate way to improve the headline number without a
single new transmission.

## 2. This is NOT green field — the machine already exists and does not learn

Measured 2026-08-01 from `data/node-dash.db` and the live radios. Every figure
here is from this repo's own stored data, not an estimate:

**The inventory exists.** The YAGI's nodedb, read live at 23:43, holds **211
nodes heard by RF**, zero via MQTT — every one of them a real radio path. **122
have a known position**, so a bearing and a distance are computable today. Hop
distribution:

```
hops:  0:6   1:24   2:42   3:49   4:24   5:23   6:28   7:11
```

**62 nodes sit at 5 hops or deeper.** That is the frontier, and it needs nothing
built to enumerate.

*These nodedb counts drift — they moved from 210/121 to 211/122 within the hour
this spec was written, as nodes are heard and time out. Treat them as the shape
of the problem, not as constants; re-measure before relying on any of them. The
`traceroute_history` figures below are stored history and do not drift.*

**The prober exists too, and has been running for five weeks.**
`traceroute_history` holds **21,793 attempts against 439 targets** since
2026-06-24:

| outcome | count |
|---|---|
| `timeout` | 18,273 |
| `ok` | 3,334 |
| `send_failed` | 186 |

A **15.3%** success rate. 9,818 of those rows already carry the `rotator_az` the
antenna was pointing at — so the "aim, then ask" instrument is also already
built and recording.

**And here is the finding that justifies this whole document.** Grouped by
target:

| band | targets | attempts | hits |
|---|---|---|---|
| >60% reliable | 8 | 1,146 | 855 |
| 25–60% | 19 | 3,415 | 1,382 |
| 5–25% | 52 | 8,209 | 1,012 |
| <5% | 25 | 3,977 | 85 |
| **never reached, not once** | **335** | **5,046** | **0** |

**5,046 transmissions — 23% of everything ever sent — were spent on 335 targets
that have never once answered.** Meanwhile 8 targets answer more than 60% of the
time. The machine is not selecting; it is iterating. It has no memory that
changes its behaviour.

**Its rate control is equally absent.** Attempts per day over the last week:

```
25 Jul   13     26 Jul  1045     27 Jul   958     28 Jul    1
29 Jul    4     30 Jul     1     31 Jul     0      1 Aug     8
```

Two modes: idle, or a thousand transmissions a day — roughly one every ninety
seconds, sustained. Neither is a design. Peter's "not so much as to become a
nuisance" has no implementation.

**So the work is not building a prober. It is giving the existing one a memory,
a policy, and a budget.**

## 3. What counts as a hit

Three instruments, answering different questions. They are not
interchangeable and the model must never merge them into one "success" column.

| instrument | proves | needs a human | cost |
|---|---|---|---|
| **traceroute reply** | a packet reached the node and a reply came back, with the path | no | one round trip |
| **broadcast callout + reply** | end-to-end reach *and* that a person saw it | yes | one TX + social capital |
| **passive reception** | they reached *us* — the opposite direction | no | zero |

**Traceroute is the workhorse.** Machine-generated, works at 03:00, returns the
actual route and per-hop SNR, and is repeatable without annoying anyone.

**The broadcast callout is the confirmation, used sparingly.** Peter's framing —
`@XXXX Hi, do you hear me?`, `Hello, any pong for me?`, varied and witty — is
correct in tone: it must read as a person being friendly, never as a bot
harvesting. Rules: never the same wording twice to the same node, never more than
one in flight, and a per-target cooldown measured in days.

**Passive reception is free evidence and must be mined first.** Every node we
hear tells us the inbound path works. It is not proof of outbound reach, but it
is proof the node is alive and roughly where, which is what makes an attempt
worth spending.

## 4. A miss proves nothing — the censoring rule

**This is the single most important statistical constraint and the model must be
built around it.**

Silence has at least four causes and the wire cannot distinguish them: the node
never heard us; it heard us and did not answer; it was asleep; the reply was lost
on the way back. With a broadcast there is the additional case of a human who saw
it and could not be bothered.

Therefore:

- The stored fact is **`verified reach ≥ X`**, never `unreachable`.
- A target with 30 failed attempts is recorded as *not yet verified*, with 30
  samples. It is never recorded as out of range.
- Repetition is what converts silence into a confidence interval. That is the
  legitimate reason to keep trying — not stubbornness.
- Any UI that renders a miss as a red cross is lying. It renders as *unconfirmed*,
  with the sample count beside it.

This is the same censored-data problem already flagged in the `perf-honesty`
task for signal margins, and the two should share vocabulary.

## 5. Store atoms, not tables

Peter: *"all of the data for that hit is needed and will be filtered and
tabulated in other useful ways that I have yet to think about."*

That sentence is the requirement. **Every attempt is stored as a raw immutable
event, and every table, score and chart is derived from those events at read
time.** Summarising at write time makes the questions invented in three weeks
unanswerable against three weeks of history — and this project's entire value is
the longitudinal record.

Minimum per attempt: target, timestamp, instrument, our TX radio, rotator azimuth
at the moment of transmission, the exact wording if a broadcast, hop count and
route claimed, what came back, elapsed time, and the outcome vocabulary as a raw
string (open, never a closed enum — same rule services gave us for their transfer
outcomes).

Nothing is ever updated in place. A later reply is a new row referencing the
attempt, not a mutation of it.

### What we record today — audited, not assumed

Peter, 2026-08-01: *"the target increases, a fairly simple loop, but what is
crucial is the amount of data we have for that."* Correct, and the audit is
stark. Measured against `traceroute_history`, 2026-08-01:

**A successful hit is richly recorded — every field below at 100%:**

| field | coverage on the 3,334 hits |
|---|---|
| forward route | 3,334 |
| **return route** | 3,334 |
| per-hop SNR outbound | 3,334 |
| per-hop SNR back | 3,334 |
| relay positions | 3,334 |
| TX / RX radio | 3,286 / 3,334 |
| rotator azimuth | **1,407 (42%)** |

Both directions of both path and SNR are already there, which means route
asymmetry — the thing that makes reach different from reception — is studyable
from existing history with no new transmissions.

**A failure records almost nothing.** Of the 18,459 non-`ok` attempts: route 0,
SNR 0, azimuth 8,411 (46%), TX radio 18,459. Timestamp, target, radio, sometimes
a bearing. That is the whole record of 85% of everything ever attempted.

**THIS IS THE CENTRAL DATA DEFECT AND THE REASON FIVE WEEKS TAUGHT THE SYSTEM
NOTHING.** All learning here is comparative — why did *this* attempt succeed when
*that* one did not — and a miss with no conditions attached cannot be compared to
a hit. The successes are over-documented relative to the failures by roughly two
orders of magnitude, and the failures are where the information is, because there
are five times as many of them.

**Requirement: a failed attempt is recorded as fully as a successful one.**
Everything knowable at transmit time is knowable whether or not a reply arrives —
antenna azimuth (and elevation/tilt if the rotator reports it), TX radio and
power, channel utilisation and air-time at that moment, the target's last-heard
age and last-known SNR, hop depth, and the §6 decision context. None of it
depends on the outcome, and none of it can be reconstructed afterwards.

## 6. Log the decision, not just the outcome

**This is what makes Peter's "hook my session in and analyse it in real time"
worth anything, and it is free on day one and impossible to retrofit.**

An outcome log says *"tried node X at 22:10, no reply."* Nothing can be learned
from that which is not already obvious.

A decision log says *"at 22:10 the candidate set was 47 nodes; these 12 were
excluded by cooldown; these 9 by the daily budget; the top 5 by score were …;
X won at 0.83 because it has been reached once, six days ago, via a relay that
answered 20 minutes ago; the antenna was turned to 118°."*

That second form makes the counterfactual inspectable. An analyst — Peter, or a
Claude session watching live — can then say *"you passed over a better target"*
or *"your scoring is over-weighting recency"*, which is exactly the collaboration
Peter described. Without it, an observer can only watch results scroll past.

**Requirement: every attempt row carries the decision that produced it — the
candidates considered, the exclusions applied and why, the scores, and the
winner's margin.**

## 7. Choose by expected information gain

A node hit five times this week teaches almost nothing. A node never reached,
whose neighbouring relay answered twenty minutes ago, teaches a great deal
either way.

The scheduler's question is therefore not *"whose turn is it"* but **"which
attempt would most change what we believe?"** Inputs available today: attempts
and hits per target, time since last attempt, time since last *success*, whether
a relay on its last known route is currently live, hop depth, distance and
bearing from `home.lat`/`home.lon` (51.0263296, -3.1588352), and whether the
antenna is already pointed near it.

The specific scoring function is deliberately **not** fixed here. It is the
research question, it will be wrong at first, and §6's decision log is what makes
tuning it possible. What this spec fixes is that a scoring function *exists* and
that its inputs and output are recorded on every attempt.

**Distance is the objective the score serves (§1a).** An attempt that could
extend the verified frontier in kilometres is worth more than one that confirms
ground already held — which means a node at 180 km with one stale hit outranks a
reliable neighbour at 12 km, and a node with *no known position* is a partial
unknown: reaching it proves reach but cannot move the headline until a position
arrives. That tension is real and the scoring function must take a deliberate
position on it rather than leaving it to fall out of the arithmetic.

The 5,046 wasted transmissions in §2 are what a scheduler without this looks
like.

## 8. The budget is enforced in code, not configuration

An unattended process transmitting on a public channel shared with strangers is
the one failure here that a commit cannot undo. Reputation on a local mesh is not
recoverable.

- A hard ceiling on transmissions per day, enforced in the transmit path itself,
  which a config edit cannot raise to infinity and a bug cannot bypass.
- A per-target cooldown in days for broadcasts, hours for traceroutes.
- Automatic back-off: consecutive silence lengthens the interval for that target.
- Never two callouts in flight at once.
- A kill switch that stops transmission without stopping observation.
- The firmware's own traceroute rate limit must be established before assuming
  any rate is available. **Not yet checked — do not assume.**

The 26–27 July burst of ~1,000 attempts/day happened with none of these in place.

## 9. THE BLOCKING DECISION: who owns the transmitter

**This must be answered before design, because it decides the repository, the
API, and who owns the airtime budget.** An autonomous prober is a mesh *actor*,
not a dashboard.

Two facts currently contradict each other:

- `src/mesh-send.js` POSTs to mesh-gw and is how Peter's broadcasts went out
  tonight. node-dash transmits today, and `CLAUDE.md` describes node-dash as a
  consumer of mesh-gw.
- The standing rule recorded from earlier sessions is that **mesh ownership is
  services'** — that node-dash never sends to mesh-gw and never reads its
  streams.

Three defensible answers:

1. **Brain here, arm borrowed.** node-dash owns targets, scoring, history and UI;
   services expose a transmit primitive and own the airtime budget.
2. **All of it in services.** node-dash renders what services decided. Consistent
   with the standing rule; puts the interesting logic outside the repo that holds
   the data.
3. **node-dash's send path is blessed.** Simplest, fastest, and requires
   `CLAUDE.md` and the standing rule to be corrected rather than quietly ignored.

**No preference is expressed here.** It is Peter's call, and it is the first
question to settle. Raise it with services on the xsession board once he decides,
rather than presenting them with a built thing.

## 10. Non-goals

- **Not a chatbot.** The callouts are a measurement instrument that happens to be
  polite. No conversation handling, no auto-reply to anything.
- **Not a DM tool.** Broadcasts only, per Peter — a DM proves a route, not reach
  into the public mesh, and consumes the same airtime with a smaller audience.
- **No claim of unreachability, ever.** See §4.
- **No new radar work.** The radar and rotator are not the goal any more; the
  rotator becomes a servant of §7 (turn to the bearing, then ask). No display
  work is in scope until the model exists.
- **No test traffic on PRIMARY by any agent session.** Standing rule, unchanged:
  ch0 is the public mesh, and a live send is Peter's to make. An autonomous
  prober transmitting on PRIMARY is a *product decision Peter has taken*, and is
  not licence for a session to send by hand.

## 11. Phasing

Each phase is its own `/idiot` task with its own spec, and each respects the
domain split — model and scoring are Domain 1, rendering is Domain 2, never both
in one task.

1. **Settle §9.** No code until it is answered.
2. **The reach model (Domain 1).** Event store per §5, decision fields per §6,
   backfilled from the 21,793 traceroute rows we already have — that backfill
   alone yields a first reach map with zero new transmissions.
3. **The budget and kill switch (Domain 1).** Before the scheduler, not after.
   It is easier to prove a ceiling holds when nothing is yet trying to breach it.
4. **The scheduler (Domain 1).** Scoring per §7, decision log mandatory.
5. **The callout instrument (Domain 1).** Wording variation, cooldowns, one in
   flight.
6. **The frontier view (Domain 2).** Reach vs hearing, per §4's honesty rules.

## 12. What is not established

Stated so nobody builds on it as if it were:

- **The firmware's traceroute rate limit.** Not checked. §8 depends on it.
- **Whether `status='timeout'` in the existing 18,273 rows means one thing.** It
  is this repo's own label; whether it distinguishes "no reply" from "never
  sent" has not been verified, and the backfill in phase 2 must establish it
  before those rows are treated as evidence of anything.
- **Whether the 335 never-reached targets are reachable at all.** By §4 they are
  unconfirmed, not unreachable — but some fraction are certainly stale nodedb
  entries for nodes that no longer exist, and no method for telling those apart
  has been designed.
- **How much of the mesh we cannot see at all.** Everything here is scoped to
  nodes that have reached *us*. The mesh beyond our reception horizon is, by
  construction, invisible to this design — and may be most of it.
- **Whether the 189.1 km record is trustworthy at the metre level.** It rests on
  a position the far node broadcast about itself, at whatever precision its owner
  configured — and `position_precision` is a per-channel setting that deliberately
  fuzzes location. The kilometre figure is sound; a claim to a hundred metres is
  not, and the model should carry the precision alongside the distance rather
  than quietly dropping it.

### A self-reported position can be wrong, and a km headline will launder it

**This threatens the headline metric directly and needs a guard before any
scoring uses distance.** Querying the furthest nodes we have *never* verified
produced, among others:

```
Millbridge        1681 km    heard 1 Aug
EA1HTF_ 8af4      1003 km    heard 23 Jul, RSSI -44 dBm
Repeater Laraxe    924 km    heard 21 Jul
whisper_*          428 km    heard late Jul
```

**EA1HTF arrived at −44 dBm** — a near-neighbour signal strength from a node
claiming to be in Spain. Whatever that packet is, it is not a thousand-kilometre
RF path. The positions are self-reported and some are stale, defaulted, spoofed,
or belong to a node that has since moved; others may be MQTT-injected into local
RF and re-broadcast.

The Cornwall (187.7 km) and Guernsey (177–182 km) figures are credible — sea
paths, plausible relay chains, sane per-hop SNR. The 400 km+ entries are not.

**A km-based objective will happily convert a bad position into a new record.**
Before distance drives anything, the model needs a plausibility test — and this
spec deliberately does not invent one, because it should be designed against the
data rather than guessed at here. Candidate signals worth examining: received
signal strength against claimed distance, hop count against claimed distance,
whether the position has ever changed, and whether any known MQTT bridge sits on
the route. **Until such a test exists, distances above roughly 200 km are
suspect and must not be published as records.**
