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

## Doors and routers are infrastructure, not destinations

Peter, 2026-08-03:

> repeaters are gold dust to us

> we should not waste time trying to get replies from routers, but we need to
> use them for what they are and not treat them as just another endpoint which
> they are not

Measured: **6 declared routers carry 95.1% of every route we have completed.**

A router is a **door**. Its worth is what it carries and what lies behind it —
not whether it answers us. Probing a router to see if it replies is spending
airtime to learn something we do not need. Probing *through* it, at a node
behind it, is the entire job.

Rules that follow:

- A router's score is **traffic carried and targets reachable behind it**, never
  its own reply rate.
- `CLIENT_MUTE` can never be a door. It does not rebroadcast, by declaration.
- A door with no confirmed route is still a door if we can hear it directly — the
  bootstrap must not require a node to already have been `route[0]`.
- Losing a door is a bigger event than losing a node, and should be treated as
  one.

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

- The **repo split** (`docs/OBSERVATORY_REPO_SPEC.md`). This definition makes the
  case sharper — mining, probing and opening is a different job from displaying
  state — but the decision, and the database question inside it, is still open.
- **How the airtime budget is divided** between corridor work and the existing
  liveness-ranked probing. That is a number, and it is Peter's.
