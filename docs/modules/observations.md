---
module: observations
source: src/observations.js
source_hash: 4ac6179364863c4fc5d5b8ddb8e53e89a78cf3909f14735b7ac2ff3faa880370
updated: 2026-08-02
---

# Module: observations

## Purpose

Turns domain events into observations for the observatory (`MESH_REACH_SPEC`
§7f). **Pure** — no database, no clock, no network, and no imports from `src/`
at all.

Today it handles one event: a received packet, carrying **where the antenna was
pointing when it arrived**.

## Why this file exists separately

`persist.js` is core and may not name a plugin —
`tests/test_observatory_boundary.mjs` permits exactly two importers of the
engine, and neither is core. So the pieces are:

```
persist.js        registerPacketObserver(fn)      core EMITS
observations.js   packet -> observation           pure mapping (this file)
index.js          observe(packetObservation(…))   composition root wires it
```

This file does **not** import `observatory.js`. It is a function of its inputs,
so the allowlist stays at two and the mapping is testable with plain objects.

## The capture point

`persist.js:294` `handlePacket()` — one chokepoint every packet passes through,
direct or relayed.

**Relayed packets are recorded, deliberately.** `_captureSignal` (`:129`)
excludes them and is right to: a relayed packet's RSSI describes the last hop,
not the origin. But that gate is why `signal_history` held only **17 nodes in 7
days**, and the distant relayed nodes it excludes are exactly the ones worth
locating. The observations store has no such gate — where the antenna pointed is
a fact about *us*, true regardless of how many hops the packet took.

## `packetObservation(packet, device, ts, replay, rotatorStatus, deviceCfgs)`

Returns an observation, or `null` when there is nothing worth recording.
`rotatorStatus` and `deviceCfgs` are passed **in**; reading them here would make
the function untestable without a live rotator and a database.

```
kind    'reception'
entity  packet.from
source  receiving radio MAC
data    { rx_device, az, beam_deg, rssi, snr, hops, portnum, packet_id }
```

**A replay returns `null`.** Re-ingesting July's packets must never be stamped
with today's antenna position — that would manufacture bearings that were never
measured, fabricating the very data this exists to start collecting.

## `antennaBearing()` — null unless it means something

**Null, never 0.** North is a real bearing, and a wrong one is indistinguishable
from a measurement once stored. Same class as B41 (`fmtAgo` clamping a future
instant to "0s ago") and services' bytes-0-vs-null correction: a plausible wrong
value is worse than an absent one, because nothing downstream can tell it apart.

A genuine `az: 0` **is** recorded as `0` — the rule is about *unknown*, not about
zero being invalid.

Null unless all hold:

| condition | why |
|---|---|
| radio `is_rotator` and `beam_deg` in (0, 360) | an omnidirectional antenna's bearing is noise; storing it invites averaging the two radios later |
| rotator settled (`moving`/`busy` false) | a bearing mid-slew is a smear, not a value |
| `az` present | — |

### `held` is deliberately NOT a disqualifier

**The rotator has two users** — node-dash and the garage alarm — and the alarm
periodically points the yagi and holds it (Peter, 2026-08-02). A *held* antenna
is stationary at a known azimuth, so every packet heard during that hold carries
a perfectly good bearing. Only **commanding** is blocked while held; measuring is
not.

That makes the alarm's use of the rotator a **gift rather than an obstacle**: it
donates azimuth diversity we did not have to ask for, and azimuth diversity is
the entire input the bearing estimator currently lacks (B54 — 305 bearings
spanning two degrees, because nothing has moved it).

Anything that later *drives* the antenna must be a good citizen of a shared
resource: check `busy`/`held`, back off on a busy response, resume where it left
off, and never fight the alarm for control.

Read from the **stored per-device profile**, never a hardcoded MAC. It already
exists:

```
E9:B0:3F:17:27:91  OMNI  beam_deg 360  is_rotator false
F4:12:FA:39:F7:B6  YAGI  beam_deg  35  is_rotator true
```

`beam_deg` is stored **on the observation**, so a later estimator knows how wide
the wedge was without trusting that today's config matches the day the packet
arrived. Configuration drifts; observations do not.

### This is not a bearing to the node

For whoever writes the estimator. A yagi's front-to-back ratio means a strong
nearby node is heard whichever way it faces — measured errors up to **108°**
against known-position nodes. The signal lives in **marginal** receptions near
the noise floor, and the usable statistic is the azimuth at which RSSI *peaks*
across a sweep. See `MESH_REACH_SPEC` §7c.

## Invariants

- Pure. No `db.js`, no clock, no randomness, no `src/` imports.
- Never throws — it runs on the packet hot path.
- A replay produces nothing.
- Azimuth is null or a real measurement. Never a stand-in.

## Test notes

Unit, 2026-08-02, plain objects, no database:

| case | result |
|---|---|
| YAGI, settled | `az 122, beam 35` |
| YAGI, mid-slew | `az null` |
| OMNI, settled | `az null, beam null` |
| YAGI, replay | nothing recorded |
| unknown radio | `az null` |
| no rotator status | `az null` |
| `az: 0` | **`0`** — a genuine north bearing survives |

Live, after a pm2 restart, 2026-08-02 08:58: node `334195949` heard by **both**
radios on the same packet —

```
F4:12:FA:39:F7:B6   az 119   beam 35   -113 dBm   5 hops
E9:B0:3F:17:27:91   az —     beam —    -112 dBm   5 hops
```

— while `GET /rotator/status` independently reported **az 119**. The stored value
matches where the antenna actually was, not merely that a field was populated.

Coverage in the first two minutes: **7 distinct nodes**, against
`signal_history`'s 12 over seven days; 10 rows were relayed packets that
`signal_history` discards. No observer errors in the boot log.

## Out of scope

- Any estimator, any fact, any UI. Capture only.
- Promoting `az` to a generated column — worth doing when the query load
  justifies an index, not before.
