---
module: app-helpers
source: public/app-helpers.js
source_hash: ecbb9892e52e525f14a225d13e93774882e886530b13fa345cf55e9959676a89
updated: 2026-08-03
---

# Module: app-helpers

## Purpose

Browser-only utilities shared across the Alpine mixin modules. Pure functions and thin
re-exports; no state, no fetching policy, no rendering.

Geographic and node-id helpers are **not** defined here — they come from `src/utils.js`,
which is served to the browser verbatim as `GET /utils.js` and is the cross-domain SSOT
for those. This module re-exports them so mixins can `import` rather than reach for
`window`.

## Responsibilities

- Re-export the `/utils.js` window globals under module scope
- HTTP helper (`fetchJSON`) with a uniform error shape
- Small pure formatters and DOM/SVG constructors used by more than one mixin
- **Decode Meshtastic quarter-dB SNR to dB — the single decoder for the browser**

## Dependencies

- `/utils.js` window globals (`haversine`, `bearing`, `signalQuality`, `numToNodeId`,
  `nodeIdToNum`)
- Browser DOM (`fetch`, `atob`, `TextDecoder`, `document`, `requestAnimationFrame`)

## Public interface

Existing exports are unchanged by this task: `haversine`, `bearing`, `signalQuality`,
`numToNodeId`, `nodeIdToNum`, `fetchJSON`, `b64ToUtf8`, `nextFrame`, `rssiPercent`,
`ageColor`, `svgElem`, `themeColor`, `PORTNUM_LABELS`, `FEED_FILTER_OPTIONS`,
`summarizeEvent`.

### `SNR_UNKNOWN` — `-128`

The `INT8_MIN` sentinel the firmware writes into a route SNR slot it could not measure.
Exported so the meaning is nameable rather than a bare magic number at a comparison.

### `snrDb(raw) -> number | null`

Decode one wire value.

- `raw == null` -> `null`
- `raw <= -127` -> `null` (the sentinel; the `<=` is deliberate, see Invariants)
- otherwise -> `raw / 4`

### `snrDbList(arr) -> Array<number|null>`

Decode a whole `snr_towards` / `snr_back` array elementwise via `snrDb`. A non-array
input returns `[]`, so a missing field and an empty field behave identically downstream.

## State

_N/A_

## Events emitted

_N/A_

## Invariants

- **The wire carries quarter-dB, not dB.** `meshtastic/protobufs` `RouteDiscovery`:
  `repeated int32 snr_towards = 2;  // The list of SNRs (in dB, scaled by 4)`.
  Same for `snr_back = 4`. Division by 4 is a protocol fact, not a display preference.

- **`-128` is not a measurement.** It is `INT8_MIN` meaning "this hop's SNR is unknown".
  Decoded it would read `-32 dB`, which is below LoRa's demodulation floor and therefore
  cannot be a real reading. It must become `null`, never a number.

- **The guard is `<= -127`, not `=== -128`.** A value that low cannot be a valid
  measurement either way, so the range test is safe and survives any neighbouring
  sentinel the firmware may add.

- **Decoding happens ONCE, at the WS ingest boundary.** `public/app-ws.js` is the sole
  entry point for traceroute data into the browser (`app-perf.js`: "History arrives
  EXCLUSIVELY over WS"). Every `snr_towards` / `snr_back` is decoded there, so
  **everything downstream of ingest holds dB and nulls — never raw wire units.**
  No renderer, mixin or template may divide by 4 or test for `-128`. If a consumer
  needs to do either, the boundary has been bypassed and that is the bug.

- `null` means "not measured" and is distinct from `0`, which is a real 0 dB SNR.

## Test notes

- `snrDb(24) === 6`, `snrDb(-46) === -11.5`, `snrDb(-72) === -18`
- `snrDb(-128) === null`, `snrDb(-127) === null`, `snrDb(null) === null`
- `snrDb(0) === 0` — must NOT be swallowed as falsy
- `snrDbList([-128,-128,16])` -> `[null, null, 4]`
- `snrDbList(undefined)` -> `[]`

## Out of scope

- **Storage.** `src/traceroute.js` and `src/passive-tracer.js` store the raw wire value
  and `db.js` keeps it as TEXT JSON. That is correct — the store holds what the wire
  said — and this task does not change it. No backfill is required or performed.

- **Backend conversion.** Under `docs/BROWSER_CONTRACT.md` the strictly correct home for
  this decode is the backend, so the browser is handed dB and decides nothing. That is a
  Domain 1 change and may not share a task with this one (CLAUDE.md: no fix may span
  domains). Raised separately; until then the browser ingest boundary is the SSOT.

- Any change to `signalQuality`, which scores live RSSI/SNR from a different source and
  is already in dB.


## The SNR decoder has LEFT the browser (2026-08-04)

`snrDb` / `snrDbList` / `SNR_UNKNOWN` are gone from this module. They encoded the
Meshtastic wire format — quarter-dB scaling and an `INT8_MIN` sentinel — which is
gw API knowledge, and `CLAUDE.md` Domain 2 says the browser has none of it.

Peter: *"that is a blant violation of the UI rule."* It now lives in `src/snr.js`,
a **backend-only** module, applied at the WS emit boundary. Deliberately not
`src/utils.js`, which is served to the browser verbatim and would have reproduced
the violation.

Traceroute SNR now arrives **already in dB**, `null` for unmeasured hops.
**Nothing in `public/` may divide by 4 or test for `-128` again.**
