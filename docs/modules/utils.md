---
module: utils
source: src/utils.js
source_hash: 61de23a3d295e139e2609a09621e2f3a4078ba880541f8baa411c9ac80a031e9
updated: 2026-06-30
---

# Module: utils

## Purpose

Pure, stateless utility functions shared between backend and browser. No Node.js-specific
imports. This file is the single source of truth for geographic calculations and
Meshtastic node ID conversions. It is served to the browser verbatim via `GET /utils.js`.

## Responsibilities

- Compute great-circle distance between two coordinates (Haversine formula)
- Compute initial bearing between two coordinates
- Score LoRa signal quality as a percentage from SNR and RSSI
- Convert between Meshtastic numeric node num and `!hex` node ID string

## Dependencies

_N/A_ — no imports. Browser-safe.

## Public interface

```js
haversine(lat1, lon1, lat2, lon2)  // → number  — great-circle distance in km
bearing(lat1, lon1, lat2, lon2)    // → number  — initial bearing in degrees [0, 360)
signalQuality(rssi, snr)           // → number  — signal score 0–100
numToNodeId(num)                   // → string  — e.g. 4198102964 → "!fa39f7b4"
nodeIdToNum(id)                    // → number  — e.g. "!fa39f7b4" → 4198102964
```

### `haversine(lat1, lon1, lat2, lon2)`

Returns great-circle distance in kilometres using the Haversine formula with Earth
radius 6371 km. Inputs are decimal degrees.

### `bearing(lat1, lon1, lat2, lon2)`

Returns initial bearing in degrees from point 1 to point 2. Result is always in
`[0, 360)` — north is 0, east is 90.

### `signalQuality(rssi, snr)`

Returns a score 0–100 representing link quality. SNR is weighted 60%, RSSI 40%,
because SNR is the dominant LoRa link indicator.

- SNR score: `clamp((snr + 20) / 30, 0, 1)` — maps [-20 dB, +10 dB] → [0, 1]
- RSSI score: `clamp((rssi + 120) / 70, 0, 1)` — maps [-120 dBm, -50 dBm] → [0, 1]
- If only one value is provided, that value alone determines the score (no weighting).
- If both are null/undefined, returns 0.

### `numToNodeId(num)`

Converts a 32-bit unsigned integer node num to Meshtastic node ID format.
Uses `>>> 0` to ensure unsigned 32-bit treatment before hex conversion.
Always produces an 8-character hex string prefixed with `!`.

### `nodeIdToNum(id)`

Converts a `!hex` node ID string to a numeric node num.
Strips the `!` prefix, parses as hex integer.
Returns `0` on null, empty string, or invalid hex input (never throws).

## State

_N/A_ — stateless.

## Events emitted

_N/A_

## Invariants

- No Node.js imports. This file must remain browser-safe at all times.
- `bearing` always returns a value in `[0, 360)`.
- `signalQuality` always returns an integer in `[0, 100]`.
- `numToNodeId` always returns a string matching `/^![0-9a-f]{8}$/`.
- `nodeIdToNum(numToNodeId(n)) === (n >>> 0)` for all valid 32-bit inputs.
- `nodeIdToNum` never throws — returns 0 on invalid input.

## Test notes

- `haversine(0, 0, 0, 1)` ≈ 111.19 km
- `bearing(0, 0, 0, 1)` === 90 (due east)
- `bearing(0, 0, 1, 0)` === 0 (due north)
- `signalQuality(null, null)` === 0
- `signalQuality(-85, 5)` — both values → weighted result
- `signalQuality(null, 5)` — SNR only → `clamp((5+20)/30, 0, 1) * 100` = 83
- `signalQuality(-85, null)` — RSSI only → `clamp((-85+120)/70, 0, 1) * 100` = 50
- `signalQuality(-200, -30)` — out-of-range inputs clamp to 0 and 100 respectively
- `numToNodeId(4198102964)` === `'!fa39f7b4'`
- `numToNodeId(0)` === `'!00000000'`
- `nodeIdToNum('!fa39f7b4')` === 4198102964
- `nodeIdToNum(null)` === 0
- `nodeIdToNum('invalid')` === 0
- Round-trip: `nodeIdToNum(numToNodeId(n)) === n >>> 0` for arbitrary n

## Out of scope

- Any stateful behaviour
- Node.js-specific APIs (fs, path, crypto, etc.)
- DB access or network calls
- Browser rendering logic
