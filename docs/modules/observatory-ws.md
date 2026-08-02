---
module: observatory-ws
source: src/observatory-ws.js
source_hash: 94f424f5d3a1d8168d22829c62863e8df00c2105c1c06e5cc94300a153cc0ced
updated: 2026-08-02
---

# Module: observatory-ws

## Purpose

Pushes each observation to the browser as it is recorded, and replays the recent
past to every new connection. **Plugin wiring, not core.**

Peter, 2026-08-02: *"a new page in the main menu, below radar, so that I can see
the page growing with live data as it is added"* and, on watching me read numbers
out of a terminal, *"you can see data, I see nothing at all."*

## Why it is a separate file

Identical reasoning to `alarm-ws.js`. `src/ws-relay.js` is core — it serves the
WS for every page — and must not name a plugin. This file knows the observatory;
core does not know this file. Delete it and its one import in `index.js` and core
is unchanged. Verified: `grep -c observatory src/ws-relay.js` → **0**.

**It is the third file permitted to import `observatory.js`**, and that is a
decision rather than a boundary slipping. The rule the test encodes is *core must
not reach into the engine*. This is a plugin — the engine's own WS wiring, as
`alarm-ws.js` is the alarm's. The allowlist names it explicitly so a fourth entry
is again a visible choice.

## Messages

| type | when | payload |
|---|---|---|
| `observations_replay` | every new connection | `observations[]`, newest first, ≤ 200 |
| `observation` | each write | one `observation` |

```
{ id, ts, kind, entity, source, data:{ rx_device, az, beam_deg, rssi, snr, hops, portnum, packet_id } }
```

`data` is **re-parsed** before sending — the browser must never be handed
JSON-inside-JSON to unpick. A parse failure yields `null` rather than throwing;
one malformed payload must not stop the feed.

### Why replay exists

On a quiet channel a page that waits for the next packet shows nothing for
minutes and reads as broken. A new connection opens with the recent past already
on screen and grows from there. An empty array is the same code path as "plugin
not installed", so a page with no observations and a node-dash without the
observatory behave identically.

## BROWSER_CONTRACT

This is **raw observation data**, not display values. Anything the page needs
*formatted* — relative ages, labels, counts — is a server-computed field and must
be added here, never derived in the browser.

## Invariants

- Core (`ws-relay.js`) never names the observatory.
- Both the broadcast and the replay are wrapped. The broadcast runs inside
  `observe()` → `handlePacket()`, the hot path for every packet: a dead socket
  must not reach packet ingestion.
- Replay is capped and newest-first.

## Test notes

Live against a real WS client, 2026-08-02 09:11–09:13:

```
REPLAY on connect: 200 observations, 20 carrying a bearing
LIVE  09:12:25  node 862529744  radio E9:B0:3F  az null  rssi -115  hops 3
LIVE  09:12:25  node 862529744  radio F4:12:FA  az 119   rssi -112  hops 3
```

The same packet through both radios, one with a bearing and one without — and at
**3 hops**, which is the distant relayed population `signal_history` discards.
Boundary test passes with the three-file allowlist; `ws-relay.js` names the
observatory zero times.

## Out of scope

- The page itself — Domain 2, its own task.
- Any derived or formatted value. This module forwards what was recorded.
