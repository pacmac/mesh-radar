---
module: bridge-events
source: src/bridge-events.js
source_hash: 7f34afa36458cf05b670ed221b5d9960f0d3f955e13fab3ec1d6095582e73fe0
updated: 2026-07-09
---

# Module: bridge-events

## Purpose

Registers and handles the `bridge.on('event', ...)` listener. Extracted from
`index.js`. Routes each incoming gw event to the correct backend module. This is
the single dispatch point for all live mesh-gw events entering the backend.

## Responsibilities

- Register `bridge.on('event', handler)` on startup
- For `node_update`: call `handleEvent`, `nodeList.handleNodeUpdate`, and conditionally insert environment metrics (own devices, >60s dedup)
- For `packet`: call `handleEvent`, `activeTracker.handlePacket`, `scanner.handlePacket`, `nodeList.touchLastHeard` + `nodeList.setHopsAway(pkt.from, hopsAway(pkt.hop_start, pkt.hop_limit))` (both under the rotator/yagi-only guard), and traceroute dispatch (V1 inline or V2 via `traceroute.js`)
- For `traceroute` typed event: route to traceroute.js (V2) or inline `nodeList.setTraceroute` (V1)
- For `rangetest` typed event: call `insertRangeTestEntry`
- Accept injected dependencies (bridge instance, broadcastAll, nodeList, etc.) to avoid circular imports

## Dependencies

- `bridge.js` — `bridge` (event source)
- `persist.js` — `handleEvent`
- `node-list.js` — `nodeList`, `hopsAway` (guarded hops-away helper)
- `active-tracker.js` — `activeTracker`
- `scanner.js` — `scanner`
- `traceroute.js` — `traceroute` (FF.SSOT_TRACEROUTE path)
- `db.js` — `stmts`, `insertRangeTestEntry`, `insertEnvHistory`
- `node-filter.js` — `ownDeviceNums`
- `dash-mode.js` — `isListenerForMode('scan', …)` (scan-time last-heard guard)
- `feature-flags.js` — `FF`

## Public interface

```js
export function registerBridgeEvents(bridge)  // call once at startup in index.js
```

## State

```js
_lastEnvTs = new Map()  // num → last inserted ts (env metrics dedup, >60s gate)
```

## Events emitted

_N/A_ (consumes events from bridge; other modules emit downstream)

## Invariants

- `rxDevice = ev.addr || ev.device || null` — v1/v2 compatibility shim.
- Env metrics: only inserted for own devices (`ownDeviceNums().has(node.num)`) and only when `now - last > 60s`.
- Scan-time listener guard: during scan, `yagiOnly = scanner.active && !isListenerForMode('scan', rxDevice)` — packets received by a radio that is NOT a SCAN listener are excluded from `touchLastHeard` and `setHopsAway`. Default SCAN listener is the rotator, so this is the historic yagi-only behaviour; `mode_config` can widen it.
- Hops-away is computed here from the raw packet (`pkt.hop_start`/`pkt.hop_limit`) — the only per-reception source that carries the hop fields and reaches `nodeList`. The gw's aggregate `node_info.hops` is unguarded and stripped in `node-list.js`; see its "Hops-away ownership" section.
- `FF.SSOT_TRACEROUTE` governs both raw-packet and typed-event traceroute paths — they must stay in sync.
- `traceroute` typed event path is additive (parallel to raw packet) in V1; V2 routes both to `traceroute.handlePacket`.
- **A device reply is routed to two consumers, both keyed on `reply_id`.** For a
  `TEXT_MESSAGE_APP` packet carrying `decoded.reply_id` (a device answer to one of
  our addressed commands, `API.md` §3), the handler routes it AFTER persistence to:
  - `handleReply(reply_id, text)` — the node-settings SSOT (config edits).
  - `handleAlignPong(pkt, rxDevice)` — the align ping loop. Align is passed the
    **whole packet**, not just the text, because it needs the per-radio signal:
    `pkt.rx_snr` / `pkt.rx_rssi` are the receiving radio's reading, and align also
    parses the pong payload's own `rssi`/`snr`. This is the live `packet` path, so
    `rx_snr` is genuinely present — unlike the synthetic traceroute packet, it
    needs no fabrication. `handleAlignPong` is a no-op unless an align session is
    active and the `reply_id` matches its pending ping, so routing every reply to
    it is free.

## Test notes

- **node_update — env metrics**: own device with temp → `insertEnvHistory` called once; second call within 60s → skipped.
- **packet — yagi-only**: scanner active, packet from non-rotator device → `touchLastHeard` NOT called.
- **rangetest**: `insertRangeTestEntry` called with correct fields extracted from typed event.
- **traceroute V2**: `traceroute.handlePacket` called for both raw TRACEROUTE_APP packet and typed event.
- **reply routing**: a `TEXT_MESSAGE_APP` packet with `decoded.reply_id` set calls both `handleReply(reply_id, text)` and `handleAlignPong(pkt, rxDevice)`; a packet without `reply_id` calls neither.
- **packet — hops-away**: packet with `hop_start:3, hop_limit:1` → `setHopsAway(from, 2)`; `hop_start:0` → `setHopsAway(from, null)` (prior value preserved); scanner active + non-rotator device → `setHopsAway` NOT called.

## Out of scope

- `bridge.on('connected')` — `startup.js` owns that.
- Scanner/dashMode/rotator event wiring — `lifecycle.js` owns that.
- WS broadcast to browser — `ws-relay.js` owns that (it has its own `bridge.on('event')` listener).

## V2 field alignment (2026-07-02, task `v2-backend-alignment`)

Range-test DB persistence listens for the V2 `range_test` event name (was `rangetest`).

## V2 node_info routing (task `node-filter-fix`)

Live node updates route to `nodeList.handleNodeUpdate` on the V2 event name
`node_info` (plus legacy `node_update`). Previously only `node_update` was
wired, so live rssi/snr/hops/via_mqtt/device_metrics never reached the node
cache — six of nine node filters matched no field and the node-card signal
bars were blank.

## Push-refusal inspection (task `push-publish-first`, 2026-07-20)

The reply-correlation block gained one more read-only consumer. Alongside
`handleReply` (settings) and `handleAlignPong` (align), device replies are now passed to
`notePushReply(pkt.from, text)` in `chunk-api.js`.

It exists because `{"start":N,"ok":0}` — the device explicitly REFUSING a push START —
was arriving here, being persisted to the message feed, and rendering as a blank progress
bar. A flat refusal was indistinguishable from a dead radio. `notePushReply` turns it into
a `chunk_error`.

Same contract as the other two consumers: it is a no-op unless a transfer is in flight,
it only reads the reply text, and it transmits nothing. Wrapped in its own try/catch so a
malformed payload cannot break settings or align correlation.

## Grab-reply dispatch (task `cam-grab-capture-route`, 2026-07-21)

The reply-correlation block gained a fourth consumer alongside `handleReply` (settings),
`handleAlignPong` (align) and `notePushReply` (push): `handleGrabReply(pkt.decoded.reply_id,
text)` from `capture-api.js`.

A `cam grab` reply threads by `reply_id` (the SAME machinery settings verbs use, verified on
the wire), but is classified by `type` (`grab`/`err`), not `ok` — so it needs its own
correlator rather than `handleReply`, which gates on `ok:true` and would misread a grab
success. Independent `_pendingGrab` map, own try/catch, so a malformed grab reply cannot
break settings or align correlation.

## Scope bug: `text` out of scope for grab correlation (2026-07-21)

`const text` was declared INSIDE the settings `try` block; `handleGrabReply` referenced it
from a sibling `try`, throwing `ReferenceError: text is not defined` on EVERY reply. So a
`cam grab` reply arrived correctly (reply_id matched the sent packet) but was never
correlated — the capture route timed out and the button reported "no reply from the camera"
while the reply sat in the message feed.

`text` is now decoded once in the shared `if (reply_id)` scope; all three consumers
(`handleReply`, `handleGrabReply`, `notePushReply`) use it, and the duplicate `text2` is
gone.

Caught by Peter pressing the button live — NOT by the injection tests, which stubbed the
browser `fetch` and never exercised this backend reply path. The lesson: a feature that
spans browser→route→reply is not verified by testing the browser half alone.
