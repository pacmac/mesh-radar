---
module: snr
source: src/snr.js
source_hash: 5f25cefd592e10e900dca97ac839f78ca3849ced5e7275e56d77ea6d254bed68
updated: 2026-08-04
---

# Module: snr

## Purpose

Decode Meshtastic quarter-dB SNR to dB. **Backend only.**

## Why it is its own module

Peter, 2026-08-04, on finding the decoder in `public/app-helpers.js`: *"that is a
blant violation of the UI rule."* Then, on the first fix attempt — which put it
in `src/utils.js` — *"but this is supposed to be a stand alone module and NOT
mixed in with core?"*

Both corrections were right, and the second matters more than it looks:
`src/utils.js` is **served to the browser verbatim** as `GET /utils.js`, so moving
the decoder there would have shipped the Meshtastic wire format straight back into
the presentation layer — the same violation by a different route.

`CLAUDE.md`, Domain 2: the browser *"does not know that mesh-gw exists. Zero gw
API knowledge."* A quarter-dB scaling factor and an `INT8_MIN` sentinel are gw API
knowledge.

## The wire contract

`meshtastic/protobufs`, `mesh.proto`, `RouteDiscovery`:

```
repeated int32 snr_towards = 2;  // The list of SNRs (in dB, scaled by 4)
repeated int32 snr_back    = 4;  // ditto
```

`-128` is `INT8_MIN`, written when the firmware could not measure that hop.
Decoded it reads −32 dB, below LoRa's demodulation floor, so it cannot be a
measurement and becomes `null` — meaning *not measured*, which is not zero.

## Public interface

- `SNR_UNKNOWN` — `-128`, named so it is not a bare magic number
- `snrDb(raw)` — one value to dB, or `null`. Guard is `<= -127`, a range test
  rather than `=== -128`, because nothing that low is real either way
- `snrDbList(arr)` — a whole array; a non-array yields `[]`

## Where it is applied

At the **emit boundary** in `ws-relay.js`, never at storage:

- the `traceroute_history` replay
- `route_discovered` (both `traceroute.result` and `passiveTracer.traced`)
- `traceroute_failed`

The store keeps **raw wire units** because that is what the wire said. The browser
is handed dB and decides nothing.

## Invariants

- Nothing in `public/` may divide by 4 or test for `-128` again
- `src/utils.js` must stay protocol-free — it is shipped to the browser
- `null` is "not measured" and is distinct from `0`, a real 0 dB reading

## Test notes

`snrDb(24) === 6`, `snrDb(-46) === -11.5`, `snrDb(-128) === null`,
`snrDb(-127) === null`, `snrDb(0) === 0`, `snrDbList([-128,-128,16]) === [null,null,4]`

Verified on the wire after the move: 36 rows carrying SNR, range −20 to +7.25,
26 nulls, **0** raw sentinels, 0 values above LoRa's +12 dB ceiling, and
`window.snrDb` undefined in the browser.

## Out of scope

- Live packet `rx_snr` / `rx_rssi`, which are already dB and come from a
  different field
- Storage format — unchanged, and no backfill is required
