---
module: reach
source:
  - src/reach.js
  - src/reach-api.js
source_hash: 077a6b7af4a14e77d4c2a1bde77946133d4d055c0c3717fbd2e6caf4fef7a1aa
updated: 2026-08-05
---

# Module: reach

Peter, 2026-08-05:

> the antenna beam / reach arc or whatever should be based on what has actually
> been CONTACTED or heard. but another series of plots could also show the
> potential reach in that direction based on the terrain that we now have

Two series, never merged: **achieved** (evidence) and **potential** (geometry).

## There is no theoretical RF reach here, and that is measured, not assumed

Peter: *"theoretical is irrelevant"*, then *"BUT theoretical constrained by
Terrain is useful!"*. Both were tested.

| model | result |
|---|---|
| link budget alone, n=3 | **554 km** |
| link budget + knife-edge diffraction over the horizon ridge | **343–400 km on every bearing** |
| furthest PROVEN direct link | **48.4 km** |

The terrain-constrained model spans **1.2×** across bearings whose obstruction
spans **36×**. It flattens to a circle at ~370 km and is wrong by 8×.

The arithmetic says why: budget ≈158 dB, free-space loss at 400 km ≈143 dB, and
knife-edge loss over 0.16–2.5° shallow angles does not consume the remainder.
LoRa at SF11, 27 dBm and 12 dBi is not stopped by hills of this size at these
ranges.

**SRTM is bare earth.** Buildings, hedgerows and tree lines — which dominate 868
MHz over the first kilometre — are invisible to it. The model is missing the only
terms that matter, so it is not built.

## Achieved — what counts as proof

| evidence | proves |
|---|---|
| `first-hop` — `route[0]` of a completed traceroute | **uplink**, two-way |
| `0-relay` — completed traceroute with an empty route | **uplink**, two-way |
| `heard` — `signal_history.hops = 0` | **downlink only**, and the gate is unverified |

**Proven and heard are separate series.** The first cut concatenated them and
produced **143.2 km "achieved"** on a bearing where the furthest proven link is
48.4 km. That 143 km came from `hops = 0`, which this module's own header
documents as untrustworthy — hop arithmetic, not a relay-identity test, and a
relayed packet satisfies it (`direct-gate-relay-node`). The warning was written
and the data merged anyway.

`furthest_km` is proven only. `heard_km` rides alongside as the weaker claim.

**Not counted at all:** RSSI/SNR on a relayed packet, which describes the last
hop rather than our path (`signal-provenance-mixed-source`).

## A sector with no evidence serves `null`, never zero

Unknown is not unreachable. Drawing a shoreline where we have simply never looked
is the same class of error as the 400 km circle.

## Measured 2026-08-05

15 proven direct links, 9 of 12 sectors with evidence.

| sector | proven | heard* | terrain horizon |
|---|---|---|---|
| 0° | 0 km | 143.2 km* | 6.67 km |
| 30° | 0.9 km | 116.7 km* | 1.45 km |
| 60° | 3.1 km | 3.1 km | 1.90 km |
| **90°** | **—** | — | **5.01 km** |
| 120° | 2.5 km | 2.5 km | 3.59 km |
| **150°** | **—** | — | **4.27 km** |
| **180°** | **48.4 km** | — | 5.01 km |
| **210°** | **43.8 km** | 30.1 km | **8.56 km** |
| 240° | 24.7 km | — | 0.74 km |
| 270° | 5.3 km | 5.3 km | 1.45 km |
| 300° | 1.7 km | 1.7 km | 4.27 km |
| **330°** | **—** | — | 2.40 km |

Proven reach is **one lobe, S–SW, 24–48 km**, and 0–5 km everywhere else.

The gap between the columns is the point. **90°, 150° and 330° have the ground
for it and no evidence at all** — 5.01, 4.27 and 2.40 km of clear horizon, never
converted into a proven link. That is where probing has never been tried, not
where it has failed.

## API

| route | purpose |
|---|---|
| ~~`GET /reach`~~ | **DELETED 2026-08-13.** Live data over HTTP is forbidden. Both series arrive per sector in the `radar` WS message, replayed on connect. The achieved/potential split moved unchanged — proven and ground-allowed remain two kinds of claim and are still never merged |
| `GET /reach/links` | the individual proven and heard links |
