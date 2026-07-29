# Node page reachability — can we reach this unit, and when is its next chance

xsession work order `[wo1-reachability]`, leader = services, STATE: GO (2026-07-29).
mcpp task `node-page-reachability`.

**Acceptance, services' words, not to be softened:** *Peter can answer "can we reach this
unit, and when is its next chance" from the page alone, without asking anyone.*

Why now: Peter is about to be ~8000 km away for six months. The node page today answers
what a unit **is** and almost nothing about whether we can **reach** it — which is the only
reason anyone opens it.

Names `docs/BROWSER_CONTRACT.md`, `docs/STYLE_GUIDE.md`, `docs/NODE_STATUS_SPEC.md`,
`docs/modules/pac-host.md`, `docs/modules/node-status.md`.

---

## 1. The problem, measured

`src/pac-host.js` polls `GET /v1/mesh/devices` every 30 s and holds the result in `_units`.
The whole array is pushed to the browser on the `pac_host_status` WS message.

The browser reads **four fields** out of it — `id`, `num`, `shortName||name`, `present`
(`public/app-control.js:33-36` is a four-key `.map()`, and nothing else in the repo touches
`units[]`).

Everything else pac-host publishes is **delivered and discarded**: `acks{}`, `nextWake`,
`wakeSource`, `beat`, `beatSource`, `phase`, `wakesSeen`, `wakesExpected`, `wakeErrMs`,
`windowMs`, `windowSource`, `txRadio{}`, `radios{}`, `awake`, `awakeSource`, `slp`, `mode`,
`fw`, `rotator{}`.

**This is therefore new UI over data already arriving, not a rendering fix.** No new fetch,
no new poll, no new endpoint is required to obtain the data.

## 2. Where it is built — server side, and this is not negotiable

`buildNodeStatus(num, windowHours)` in `src/node-status.js` reads **only** SQLite via
`stmts.*`. It has no knowledge of pac-host. The pac-host roster lives in a different module's
in-memory state and reaches the browser on a *different WS message*.

Two ways to join them. Only one is permitted.

| | Where the join happens | Verdict |
|---|---|---|
| A | `node-status.js` asks `pac-host.js` for the unit and emits a section | **REQUIRED** |
| B | the browser merges `pacHostStatus.units` into `nodeStatus` | **FORBIDDEN** |

B is forbidden by `docs/BROWSER_CONTRACT.md`: the browser makes zero decisions, and joining
two server-pushed structures to decide what a tile says is a decision. It would also produce
two code paths for one displayed value — exactly what `ws-relay.js:112-114` was written to
prevent ("the browser re-requests the RPC, so there is exactly one code path producing
displayed values and no chance of a pushed value disagreeing with a fetched one").

## 3. The iron rule for this section

**Every fact states its kind and its age, or explicitly states that it has neither.**

The precedent already exists on this page and services cited it back to us as correct — the
SIGNAL tile: `-116 dBm · Fair · -6.5 dB · direct 45m ago`. Value in the value slot,
provenance and age in `desc`.

The counter-example is on the same page: the HOPS tile renders a value verified on 14 Jul
with the same visual weight as live data. That is a confirmed defect. It is **out of scope
here** (own task) but it is the thing this section must not become.

A corollary that governs several fields below: **an undated value must not borrow another
field's date.** Services removed their own `rosterAt` block name for exactly this reason —
"sharing an age is not a reason to share a name" — and replaced it with `hopsAt` / `rssiAt` /
`snrAt` / `positionAt`. Where a field has no honest age, it renders with no age.

## 4. The contract, as confirmed by services from their source

All confirmed on the board 2026-07-29 (`[wo1-reachability]` #22, #24, #26). Recorded so the
implementation is not written against a guess.

### 4.1 Time

Every timestamp in `GET /v1/mesh/devices` is **epoch milliseconds**. The single seconds field,
`lastHeard`, was **deleted** on our confirmation that we do not read it.

`fmtAgo()` and `fmtStamp()` in `src/format.js` take **epoch seconds**. Every pac-host instant
must therefore be divided by 1000 at the boundary. This is a known trap: the divide is silent
and produces a plausible wrong answer. It has already bitten this repo once (pac-host's
ledger, `src/pac-host.js:103-120`).

**`fmtAgo` cannot express a future instant, and fails silently when given one.**
`src/format.js:97` clamps with `Math.max(0, nowSec - ts)`, so any future timestamp returns
`"0s ago"`. `nextWake` is a *future* instant: passing it to `fmtAgo` would render a sleeping
unit's upcoming window as "0s ago" — i.e. *awake right now* — which is the exact opposite of
the truth and unfalsifiable from the page. Ledger `bugs` step 41.

A separate `fmtUntil()` is therefore required. **Separate function, not a flag on `fmtAgo`** —
a flag would let an existing caller change meaning silently, and every current caller wants
the historical clamp. `fmtUptime()` (`src/format.js:31-41`) already formats a bare duration
and supplies the wording.

### 4.2 Age siblings are mechanical

Ages arrive as `<field>` + `At`, sources as `<field>` + `Source`. No abbreviations, no special
cases — so age can be resolved **by construction** rather than from a hand-maintained lookup
table that rots when a field is added.

Present today: `hopsAt`, `rssiAt`, `snrAt`, `positionAt`.

**Absent today, deliberately:** `awake`, `mode`, `fw`, `txRadio`, `slp`, `beat`, `windowMs`
have no `At` sibling, because services does not currently record when several of them were
established and would rather omit a timestamp than invent one. Under the mechanical rule an
absent sibling is *detectable*, so these render **without an age**. They must not be stamped
with `now()` and must not borrow another field's instant.

Outstanding with services (does not block): a per-field **computed-at-request-time vs
remembered** classification. Only remembered fields need an `At`. Priority stated to them:
`beat` first — `nextWake` is computed *from* `beat`, so a stale beat yields a confidently
wrong "next window in 4m 12s", which is worse than no answer. Then `slp`, then
`txRadio.state`. `fw` and `mode` are identity, not reachability, and are not needed dated.

### 4.3 `acks` — one object, latest overall

`acks` is a **single object summarising the most recent request of any verb**, not a map keyed
by verb (their `_ackSummary` does `requests({unit, limit:1})`). It already answers "can we
reach it" by the most recent attempt of any kind, which is the question this page asks.

`acks: null` means **NEVER COMMANDED**. It must render as unknown — never as failure.

> Expect an apparent regression. Services stripped their own `push` housekeeping polls from
> `acks`; units that showed acks yesterday may now be null. That is the fix, not a
> regression — it means nobody has actually commanded them.

Five numbers, and they must stay five. Never collapse them into one success boolean:

| field | meaning |
|---|---|
| `sends` | POSTs mesh-gw **accepted** — NOT transmissions |
| `transmitted` | actually left the radio |
| `notSent` | refused |
| `unknownSent` | accepted, no status yet — neither transmitted nor refused |
| `delivered` | acknowledged by the far end |

Services' evidence for why: **15 of GARG's 131 sends one day never left the radio, and every
one was counted as a send.** A single boolean would have shown a green tick through the whole
of 2026-07-28, while every send was being refused.

### 4.4 `wakeSource` — which kind of `nextWake: null`

| value | meaning | what the page must say |
|---|---|---|
| `always-listening` | the unit never sleeps | a command goes **now** |
| `device` | beat came from the device's own reply | a real schedule exists |
| `measured` | beat derived from observed intervals | a real schedule exists |
| `unknown` | never measured, never reported | **wait — we do not know** |

`awake: true` with `nextWake: null` is a **valid and correct** combination. Treating
`always-listening` and `unknown` the same is a real bug (services' B32).

### 4.5 `wakesExpected: null` — a category statement, not a missing measurement

An always-listening unit does not wake, so there is **no denominator** and no percentage
exists to compute. The old 110% figure was a category error: it counted telemetry
transmissions against expected wakes, comparing two different things.

Where `wakesExpected` is null the page renders **no reliability figure at all** — not `0%`,
not a dash, not "unknown" — and uses `wakeSource` to say why. Confirmed by services (#28),
who called our wording better than theirs.

**`0` is not `null` and must not be conflated with it.** Observed live: BNCH `null`
(always-listening — no denominator exists), GARG `0` (a real denominator that happens to be
zero — nothing expected in the window yet). Both make a percentage impossible, but for
different reasons, so they must not print the same string. Dividing by either is a defect.

### 4.6 `awakeSource` — four states, and they are not equally strong

Originally `device-stated` covered both "we heard it" and "the device claimed `slp: 0`".
Those are different kinds of claim, and the argument that carried the split was: *a config
claim is not evidence that anything reached the unit.* Services split it along the same
branches their `_awake()` already takes, so the source can never describe a different
decision than the value (their commit `35b274a`).

| `awakeSource` | meaning | strength |
|---|---|---|
| `device-stated` | `slp === 0` | a **config claim**. NOT evidence anything reached the unit |
| `heard` | inside the RX window from `lastHeardMs` | **observed**. Renderable as fact |
| `inferred` | outside the window — sleep deduced **from silence** | weak. Must not render as fact |
| `unknown` | never heard; `awake` is null and says so | no claim |

The page must render these differently. `heard` is the only one that is evidence of
reachability; `device-stated` and `inferred` are both weaker and must read as weaker.

**Verified in the wild: two of four.** `device-stated` (BNCH, `slp 0`) and `inferred` (GARG,
silent past its window) observed live 2026-07-29. `heard` needs a unit caught inside its
window and `unknown` needs a never-heard unit — neither has been observed, so both are
**specified but unverified**. Encountering something outside these four is a defect to report
to services, not a surprise to absorb.

### 4.7 `windowSource`

An abbreviation of `windowMsSource` predating the mechanical convention. Rename requested
(costs nothing today — we consume four fields). Implementation must tolerate either name and
must not fail if only one is present.

## 5. What the page shows

A section, `id: 'reachability'`, `title: 'Reachability'`, placed **first** in `sections` —
before device vitals. It answers the question the page is opened for.

Present **only** when `pac-host` holds a unit for this `num`. Absent for every other node,
following the existing rule that a section appears only if it has data
(`src/node-status.js:442`). No placeholder, no "not applicable" card.

Fields, each `{ label, raw, text, ts, desc }` — `text` is the value, `desc` carries kind and
age, both fully formatted server-side:

| label | text | desc |
|---|---|---|
| Delivery | `delivered` / `sent, no ack` / `sent, status unknown` / `refused` / `queued` | `<verb> · <transmitted>/<sends> left the radio · <ago from settledAt>` |
| Delivery *(when `acks` is null)* | `not yet asked` | `no command has been sent to this unit` |
| Next window | `in 4m 12s` / `always listening` / `unknown` / `overdue` | `wakeSource` in words |
| Beat | the interval | `beatSource`; **no age** — services does not record one |
| Wake reliability | `3 of 5` | `since <ago from wakesSince>` |
| Wake reliability *(`wakesExpected === 0`)* | `<wakesSeen> seen` | `none expected in this window yet` |
| Wake reliability *(`wakesExpected === null`)* | *field omitted entirely* | — |
| TX radio | radio short name or id | `<state>`; **no age** — services does not record one |
| Awake | `yes` / `no` / `unknown` | `awakeSource` in words; the four states must read at different strengths — see §4.6 |
| Heard by *(one row per radio)* | `-42 dBm · 6.75 dB` | `direct <ago>` · `<n> direct, <n> relayed`, from `radios{}` |

`wakesExpected` **`0` and `null` must not render identically** (§4.5). `null` omits the field;
`0` renders a bare count with an explanation. Omitting both would collapse two different
statements into the same silence.

`overdue` is used when `nextWake` has passed and services has not yet recomputed it. It is
deliberately not `now` — the predicted window having passed is a fact; the window being open
is a claim we cannot make.

Wording requirements that are not cosmetic:

- `acks: null` renders **"no command has been sent to this unit"**. Peter must be able to tell
  *not yet asked* from *asked and got nothing* at a glance. Not a blank. Not a failure state.
- Delivery must not reduce five numbers to a tick. Where `transmitted < sends`, say so.
- Nothing on this page renders a **verdict**. No "unreachable" pill, no health colour derived
  from these values. The page states facts; judging them is the reader's job — and where a
  judgement genuinely belongs to a server, it belongs to *services'* server, not ours.

## 6. Staleness — the part that is easy to miss

`node_status` is a WS **RPC**: the browser sends `{type:'node_status', num}` and the server
replies. Re-requests are triggered by `node_status_update`, a hint carrying only a `num`
(`src/ws-relay.js:112-131`), and that hint is currently driven **only by mesh-gw packet
events**.

`pac-host.js` already emits a `change` event when its poll produces a different roster
(`src/pac-host.js:83`), and `ws-relay.js:330` rebroadcasts `connectMessage()` on it — but
nothing hints `node_status`.

**Consequence if unaddressed:** a unit's reachability facts would refresh only when a *mesh
packet* happened to arrive — i.e. exactly when the unit is reachable, and never while it is
silent. The section would be freshest when it matters least. `nextWake` counting down is the
sharpest case: it would freeze.

**Required:** `pac-host`'s `change` event hints `node_status` for each unit num it holds, via
the existing throttled `_hintNodeStatus`. This reuses the one-code-path rule rather than
pushing values.

## 7. Domain split — two tasks, and Domain 2 goes FIRST

`CLAUDE.md`: *no fix may span domains in a single task.*

**Domain 2 — `node-page-value-grid-desc`. Implemented FIRST.**
`public/partials/tab-node.html:154-159`: `value_grid` renders only `f.label` and `f.text`. It
has **no `desc` slot**, so the kind-and-age qualifier has nowhere to go. The header stat cards
already render `f.desc` (line 78); `value_grid` needs the same treatment.

Order matters and is not arbitrary. The change is **additive and invisible** — no existing
`value_grid` field carries a `desc`, so rendering one changes nothing on screen until Domain 1
supplies data. Shipping Domain 1 first would instead put a Reachability section on the page
with every qualifier dropped, which violates §3 — the section's own iron rule — for as long as
the two tasks are apart.

Do **not** work around this by folding the qualifier into `text`. That puts provenance in the
value slot and is precisely what the SIGNAL tile pattern avoids.

**Domain 1 — `node-page-reachability` (this task). FOUR files, not three.**

| file | change |
|---|---|
| `src/format.js` | add `fmtUntil()` — a future instant has no formatter and `fmtAgo` clamps it to "0s ago" (§4.1) |
| `src/pac-host.js` | export `unitForNum(num)` and `unitNums()` — read-only views of the last poll |
| `src/node-status.js` | `buildReachabilitySection(num)`; place it first in `sections` |
| `src/ws-relay.js` | on pac-host `change`, hint `node_status` for every unit num (§6) |

`src/format.js` was **not** in the original file list. It was added at Phase 1 on discovering
that no future-safe formatter exists.

Every string, every relative time, and every decision about what to show is computed in
Domain 1. The browser receives finished text.

## 8. Out of scope — raise, do not fix

- The HOPS tile qualifier. A confirmed defect, its own task.
- Images / Camera page — WO2, still on HOLD, blocked on services building a progress source
  that does not exist yet. Predecessor: `reference/alarm-integration/public/push.html`.
- The four "Coming soon" Control submenus.
- Traceroute's universal `timeout`, and the proposed move of traceroute to services.
- The uncommitted `traceroute-header-button` work in `public/`.
- Our own message-feed defect (pac-host-originated sends bypass `src/mesh-send.js`; mesh-gw
  suppresses own-TX echo; 95 replies against 1 recorded send over 12 h).

## 9. Verification

Rendering proves nothing. Per `docs/modules/browser-playwright-audit.md` and the standing
rule that verification must match the claim:

1. `GET http://127.0.0.1:8787/v1/mesh/devices` read directly, and the section's values
   reconciled against it field by field — including the divide-by-1000 at the boundary.
2. Both a sleeping unit (GARG, `slp: 1`, `wakeSource: device`) and an always-listening unit
   (BNCH, `slp: 0`, `wakeSource: always-listening`, `wakesExpected: null`) checked. The two
   must render **differently**, and the always-listening one must show no reliability figure.
3. A unit with `acks: null` shows "no command has been sent to this unit" — not a blank.
4. Playwright at 1600×1000 in **both** themes, with a scroll check (`scrollHeight` vs
   `clientHeight`), and the screenshot actually looked at.
5. `python scripts/check_specs.py` prints `All specs current.`

Completion is reported to services on the xsession item **with evidence**: what changed by
file, and the acceptance **measured after** the change — not predicted. Services verifies
before issuing the next GO.
