---
module: relay-observation
source:
  - src/relay-observation.js
  - src/db.js
  - src/persist.js
source_hash: 28c5ec78fb5f1fe9467830dfb45352fe3cdeb2cd57f33581ef0e920c1a0887c2
updated: 2026-10-11
---

# Module: relay-observation

Task: `packet-provenance-capture`. Unblocks `aim-at-the-first-hop`.

## Purpose

Record, for every received packet, **who relayed it and how it travelled** — so the
relay graph can be built from passive traffic instead of from successful traceroutes.

## Why it exists

The reach work stalled on a circularity. Relay membership is only known from
`traceroute_history.route`, and that column is populated **only on success**:

```
status        rows     with a route
ok           3,383          2,960
timeout     18,908              0
send_failed    187              0
```

So "this target shares a relay with a known-good path" is a restatement of "this target
has answered before". A ranking built on it scores 19.9% against 0.0% and means nothing.
That error was made and caught on 2026-08-03; this module exists so it cannot be made
again.

Every packet already carries the answer. `relay_node` (MeshPacket field 19) is the last
byte of the node that relayed it. It arrives on every reception, relayed or not, and
costs no airtime to collect.

## What is captured, and from where

| field | source | meaning |
|---|---|---|
| `ts` | `rx_time` or ingest time | when we heard it |
| `from_num` | `packet.from` | the ORIGIN node, in the clear even when encrypted |
| `relay_byte` | `packet.relay_node ?? 0` | low byte of the relaying node; `0` = not relayed |
| `rx_device` | event `__ble_addr`/`addr`/`device` | which of OUR radios heard it |
| `hop_start` | `packet.hop_start` | sender's initial hop budget |
| `hop_limit` | `packet.hop_limit ?? 0` | remaining on arrival |
| `transport` | `normaliseTransport(packet.transport_mechanism)` | how it reached us — **normalised**, never the wire value; see the 2026-08-23 section |
| `decoded` | `packet.decoded != null` | did we have the key |
| `portnum_name` | `packet.decoded?.portnum_name ?? null` | what kind of packet, if we could decode it; **added 2026-10-11, see below** |
| `packet_id` | `packet.id ?? null` | header-level, present regardless of decode; **added 2026-10-11** |
| `rx_snr` | `packet.rx_snr ?? null` | header-level; **added 2026-10-11, NOT gated direct-only — see below** |

### proto3 zero-omission — the trap this file must not fall into

mesh-gw serialises with default-omission, so a **zero-valued field is absent entirely**.
`persist.js:115` already documents this for `relay_node`. It applies identically here:

- `relay_node` absent means **0 — not relayed**. Never "unknown".
- `hop_limit` absent means **0**.
- `transport_mechanism` absent means **`TRANSPORT_INTERNAL` (= 0)**. Never "unknown".

Verified against `mesh.proto`: `TRANSPORT_INTERNAL=0, TRANSPORT_LORA=1, LORA_ALT1..3=2..4,
TRANSPORT_MQTT=5, MULTICAST_UDP=6, API=7, UNICAST_UDP=8`.

## `relay_byte` is an indicator, never an identity

One byte. Two nodes sharing a last byte are indistinguishable, so a byte resolves to a
**candidate set**, not a relay. Consumers must treat it that way; this module stores the
raw byte and never guesses. Meshtastic's own zero-cost-hop feature quotes ~2.3% collision
probability in a 1,000-node mesh, which is the right order to expect here.

## Encrypted packets are captured too — that is the point

`handlePacket()` opens with `if (!packet?.decoded) return;`, discarding **15% of live
traffic** (12 of 80 sampled, 2026-08-03). Those packets are on channels we hold no key
for, but `from`, `relay_node`, `hop_start` and the receiving radio are all in the
**unencrypted header**. We do not need to read a packet to learn that one node relayed
another.

Capture therefore happens **before** the decoded gate. That is the whole reason this is
not simply another `registerPacketObserver` — that hook is called after the gate and
would inherit the same blind spot.

## Where it hooks in

`persist.js handlePacket()`, as the first statement, before the `decoded` early return.

Wrapped in try/catch on the same principle as `_notifyPacketObservers`: this runs on the
hot path for every packet, and a throw here must never stop packet ingestion. A failure
logs once and is swallowed.

## Volume and retention

~20 packets/min sustained → ~29,000 rows/day. Left unbounded this outgrows
`signal_history`.

`pruneRelayObservations(days)` deletes rows older than `relay_observation.retain_days`
(default **30**, clamped 1–365).

**Called inline, every 5,000 inserts — not on a timer and not from `auto-purge`.**
`startAutoPurgeScheduler` purges the *radio's* NodeDB over the air on a per-device
schedule; it has nothing to do with local table retention, and hooking it there would
have coupled a database concern to a mesh operation. A counter in this module needs no
scheduler, cannot drift, and does the work only when there is work to do — roughly once
every four hours at the observed ~20 packets/min.

Rows are **not** deduplicated. Two radios hearing the same packet is two observations of
two different links and both are wanted — the same reasoning that made
`signal_history` key on `(num, packet_id, rx_device)`.

## Why not `signal_history`

`db.js:155` states the invariant plainly: *"hops is recorded so the direct-only rule stays
auditable rather than merely asserted: any row with hops != 0 is a bug, and can be found."*

`signal_history` is a **direct-only link-quality** table, because relayed RSSI describes
the last hop rather than the origin (`persist.js:303`). Relay edges are precisely the
relayed packets it exists to exclude. Writing them there would destroy the one dataset
whose meaning is currently unambiguous.

## Exact changes

### `src/db.js`

- `CREATE TABLE IF NOT EXISTS relay_observation` with the original columns above.
- Indexes: `(from_num, ts DESC)`, `(relay_byte, ts DESC)`, `(ts)`.
- `insertRelayObservation(entry)` and `pruneRelayObservations(days)`.
- At creation time, **no migration guard was needed** — new table,
  `CREATE TABLE IF NOT EXISTS` only. The 2026-10-11 column addition (above) DOES
  use one: `PRAGMA table_xinfo` (never `table_info`, which omits generated
  columns and re-`ALTER`s every boot), matching the repo-wide pattern.

### `src/relay-observation.js` (new)

- `captureRelayObservation(packet, device, ts)` — pure field extraction plus one insert.
  Applies the zero-omission defaults above explicitly.

### `src/persist.js`

- Import and call it as the first statement of `handlePacket`, inside try/catch, **above**
  the `decoded` early return.

### `src/config-api.js`

- `DEFAULTS['relay_observation.retain_days'] = 30`. Flat dot-notation, matching every
  other key in that map — `DEFAULTS` is not nested. Clamping to 1–365 is applied at the
  READ site in `relay-observation.js`, not by a PUT validator, because nothing writes this
  key over the API yet.

## Explicitly NOT changed

- `signal_history`, `isDirectPacket()` and the direct-only rule — untouched.
- `registerPacketObserver` and its existing observers.
- `traceroute_history`. RTT capture, per-attempt `channel_util`/`air_util_tx`, and the
  B61 `from_num` defect are a separate follow-up: different table, different lifecycle.
- Any targeting or ranking logic. This task only records; `aim-at-the-first-hop` consumes.

## Invariants

- Capture never throws into the ingest path.
- Absent `relay_node` is stored as `0`, never null — absent means not-relayed.
- Absent `transport_mechanism` is stored as `TRANSPORT_INTERNAL`, never null.
- `relay_byte` is never resolved to a node here.
- No row is written for a packet with no `from`.
- Encrypted packets are recorded with `decoded = 0`, not skipped.

## Test notes

Phase 4, live traffic, ~3 minutes after deploy (2026-08-03):

```
rows 66     decoded 52 | encrypted 14      (21% — the traffic previously dropped)
            relayed 25 | direct 41         (38%, against 33% sampled pre-build)
            OMNI 45 | YAGI 21
            nulls in relay_byte / hop_limit / transport:  0 / 0 / 0
            hop_limit spread 0..7, with 32 rows at 7
```

**The 14 `decoded = 0` rows are the proof that capture runs above the gate.** Those
packets hit `return` at `if (!packet?.decoded) return;`, so they could only have been
recorded by code executing before it. Were the call moved below, that count would be
exactly zero — which makes this a real reached-test, not merely a presence check.

**Non-circularity, the reason the module exists:**

```
distinct origins seen VIA A RELAY that have never answered a traceroute: 4
  origin 2527340562  relayed by byte 2   (4 observations)
  origin 117300438   relayed by byte 2   (3)
  origin 3676957164  relayed by byte 2   (2)
```

Relay membership for nodes with no successful traceroute — structurally unobtainable
before this change.

Regression: `signal_history` still writing (6 rows / 5 min), `obs_observation` 101 / 5 min,
zero `[relay-obs] capture failed` lines in 300 log lines, and
`tests/test_observatory_boundary.mjs` passes.

Not yet exercised: `pruneRelayObservations` — it fires at 5,000 inserts, roughly four
hours in. Untested at time of writing and recorded as such.

## `transport` is normalised on the way in — 2026-08-23

Found by mesh-gw while querying our store with Peter's read-only permission, and
reported rather than touched. They called it the urgent one and they were right.

### What happened

`captureRelayObservation` stored mesh-gw's field **verbatim**:

```js
transport: packet.transport_mechanism ?? 'TRANSPORT_INTERNAL',
```

mesh-gw changed `transport_mechanism` from a string enum **name** to its numeric
**value** at 2026-08-22 17:06. We passed it straight through, so one column now
holds two encodings:

```
TRANSPORT_INTERNAL  text  491412   2026-08-03 08:39:39 → 2026-08-22 17:06:26
TRANSPORT_LORA      text  261371   2026-08-03 08:39:43 → 2026-08-22 17:06:07
1.0                 text    6261   2026-08-22 17:06:12 → still arriving
0.0                 text   11917   2026-08-22 17:06:17 → still arriving
```

Accruing at ~1,145 rows/hour across both radios.

### Why it was blocking rather than untidy

**Six** queries compare this column to a string literal, so every one of them has
silently excluded every row since 17:06:

| site | literal |
|---|---|
| `callout-runner.js:60` | `'TRANSPORT_LORA'` |
| `callout.js:218` | `'TRANSPORT_LORA'` |
| `standing-tasks.js:740` | `'TRANSPORT_INTERNAL'` |
| `standing-tasks.js:893` | `'TRANSPORT_INTERNAL'` |
| `snapshot-api.js:109` | `'TRANSPORT_LORA'` |

`snapshot-api.js` is the one that matters most: it feeds `snapshot.distribution`
on `/events`, which is the derived model other consumers read. So the published
reach model has been computing from a truncated view.

### The canonical form is the NAME, and the mapping is not a guess

This module's own comment already carried the answer, verified against
`mesh.proto`:

> `INTERNAL=0, LORA=1, LORA_ALT1..3=2..4, MQTT=5, MULTICAST_UDP=6, API=7,
> UNICAST_UDP=8`

So `0 → TRANSPORT_INTERNAL`, `1 → TRANSPORT_LORA`. Corroborated independently by
proportion — 491k/261k ≈ 65/35 before the change, 11,917/6,261 ≈ 66/34 after — but
the enum is the authority and the ratio is only a check on it.

**Names, not numbers**, for three reasons: 97.6 % of rows already are names, all
six queries already expect names, and a name is self-describing in a feed where a
bare `1` is not.

### The rule

**Never store a peer's enum verbatim.** Storing the wire value made this module
correct only for as long as mesh-gw happened to send strings, and nothing here
would have noticed the day that changed — it took a peer reading our database to
find it.

`normaliseTransport()` maps every known enum value, numeric or name, to the
canonical name. An unrecognised value becomes `TRANSPORT_UNKNOWN_<n>`: stable,
greppable, impossible to confuse with a real name, and visible instead of silently
passed through.

### Backfill

The 18,178 numeric rows are rewritten to their names.

**I first wrote here that "the mapping is bijective, so nothing is lost and the
change is reversible". That is true of the VALUE and false of the PROVENANCE, and
the distinction matters more than the sentence did.**

The bijection means no *meaning* was lost: `0` and `TRANSPORT_INTERNAL` denote the
same thing, and either can be recovered from the other. What was lost is the
record of **which rows arrived in which encoding**. There is no column holding the
raw wire value — `PRAGMA table_xinfo` gives `id, ts, from_num, relay_byte,
rx_device, hop_start, hop_limit, transport, decoded` — so after the rewrite the
table reads:

```
TRANSPORT_INTERNAL  505754  2026-08-03 07:39:39 -> 2026-08-23 09:45:03
TRANSPORT_LORA      268824  2026-08-03 07:39:43 -> 2026-08-23 09:44:34
```

Two clean rows, continuous ranges, **no seam**. The instant mesh-gw changed
encoding is no longer answerable from the data. It survives only in this
paragraph.

The backfill was still the right call and is **not** being reverted: six consuming
queries compare this column to string literals, and consistency in a working
column is what they depend on. The defect was the claim, not the change.

### A tape and a working table are two artefacts

Found by **device**, on 2026-08-23, by applying our own enum warning back at us.
We told them never to store a peer's enum verbatim; they checked their tree, found
it clean, and volunteered a caveat about their own `meshgw-tap.py`, which writes
our events verbatim on purpose — because a witness log that normalises has
destroyed the evidence it exists to hold.

Which is the opposite requirement to this table's. So they are two artefacts:

> **Never store a peer's enum verbatim in a table you QUERY.**
> **Never rewrite it in a log you keep as EVIDENCE.**
> **If you hold only one of those, you are missing the other.**

**node-dash holds only the first, and that is an open gap** — recorded here rather
than closed over. Do not reach for device's tap as the general record either: it
runs `--only !987ab80f`, so it witnesses one node, not mesh-gw's surface, and it
writes into **tmpfs**, so it does not survive a reboot. It does cover the 17:06
instant (running continuously since 2026-08-10), but for one node only.

Two errors worth keeping, because they are the same error twice:

- device warned the tape might be at a path that does not survive. I checked that
  the file **existed**, found it was not at the default path, and reported that the
  worry did not apply. The specific path was wrong; the **class** of problem was
  right — it is in tmpfs. Answering a narrower question than the one asked, then
  reporting the reassuring conclusion.
- I then called that tape "the authority on our peer surface" without checking its
  **filter**. Verify a witness's scope, not merely its existence.

Whether node-dash should keep its own verbatim tape of the gw surface is a real
question and is **not decided here** — mcpp task
`backfill-claimed-lossless-but-destroyed-provenance`, step "Decide".

### Test notes

- `SELECT DISTINCT transport` returns only canonical names — no `0.0`, no `1.0`
- `normaliseTransport` maps `0`, `'0'`, `0.0` and `'TRANSPORT_INTERNAL'` alike
- an unknown value yields `TRANSPORT_UNKNOWN_<n>` rather than passing through
- absent still means `TRANSPORT_INTERNAL` — proto3 omits zero-valued fields, so
  absence is enum 0, **never** "unknown". Same rule as `relay_byte ?? 0` and
  `hop_limit ?? 0`; `hop_start` stays `null` because absent there is genuinely no
  information
- the row count for `'TRANSPORT_LORA'` after backfill exceeds the pre-fix count

## No packet type, no packet id, no signal — 2026-10-11

Relayed from fun via mesh-gw, idiot entry `relay-observation-keeps-no-packet-type`:
this table recorded relay/hop provenance but nothing about **what** was heard,
so "what did we hear from X" was unanswerable from it alone — a NodeDB-replay
burst and a real reception looked identical.

`captureRelayObservation` now also captures `portnum_name`, `packet_id` and
`rx_snr`, via `ALTER TABLE` (guarded by `PRAGMA table_xinfo`, never
`table_info` — the generated-column trap). Historic rows stay `NULL`:
genuinely unknown, not backfilled.

**`portnum_name` is optional-chained, not assumed**: `packet.decoded` can be
absent entirely for the 15% of live traffic this module already captures
above the decoded gate (encrypted-only packets). `packet.id` and `packet.rx_snr`
are header-level — present regardless of decode status.

**`rx_snr` is deliberately NOT gated direct-only**, unlike `signal_history`'s
`pktSnr` (`persist.js`'s `isDirectPacket` rule). `signal_history` exists
specifically for the trustworthy-direct-signal use case and must stay
unambiguous; this table's whole purpose is "how did this packet reach us",
relayed hops included, and a consumer that wants direct-only signal can
already filter on the already-present `relay_byte = 0`. Storing it raw here
rather than re-deriving directness keeps the two tables' responsibilities
separate instead of duplicating `signal_history`'s rule with a second, looser
copy of it.

`via_mqtt` was asked for too but was NOT added as a separate field — it is
already derivable from `transport === 'TRANSPORT_MQTT'`.

Test: `tests/test_relay_observation_packet_type.mjs` — a decoded packet
carries all three fields; an encrypted-only packet (no `decoded` at all) is
still captured, with `portnum_name` staying `null` rather than throwing.

_Hash resynced 2026-10-11: `src/persist.js` changed again for an unrelated
reason (`isDirectPacket`'s `packet.replay` gate — see `persist.md`); nothing
in this document changed further._
