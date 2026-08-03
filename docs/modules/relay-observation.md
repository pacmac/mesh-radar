---
module: relay-observation
source: src/relay-observation.js
source_hash: abe87df69e1165b36b9ef7f1f5cbb998543d22d97e167f6f49295f4782665220
updated: 2026-08-03
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
| `transport` | `packet.transport_mechanism ?? 'TRANSPORT_INTERNAL'` | how it reached us |
| `decoded` | `packet.decoded != null` | did we have the key |

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

- `CREATE TABLE IF NOT EXISTS relay_observation` with the columns above.
- Indexes: `(from_num, ts DESC)`, `(relay_byte, ts DESC)`, `(ts)`.
- `insertRelayObservation(entry)` and `pruneRelayObservations(days)`.
- **No migration guard needed** — new table, `CREATE TABLE IF NOT EXISTS` only. Nothing
  here uses `PRAGMA table_info`, which omits generated columns and re-`ALTER`s every boot.

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
