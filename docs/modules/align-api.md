---
module: align-api
source: src/align-api.js
source_hash: 125077ee3c7544c88929542cfa6c3c07e6093f1721582d7d4fbd6cd682353efd
updated: 2026-07-19
---

# Module: align-api

## Purpose

Backend for the mobile Yagi alignment page: serves `/align`, runs the align
traceroute loop, and pushes a **narrow** sample stream over its own WebSocket.

Exists as a separate surface because the dashboard's `/events` pushes **7.2 MB**
on connect (measured 2026-07-19: `env_history` 3.8 MB, `tilt_history` 3.0 MB).
The alignment page needs ~150 bytes per sample — about 11 KB for a whole
five-minute session. A subscription filter on `/events` would not help: the bulk
lands before any subscribe message could arrive.

## Responsibilities

- Serve `public/align.html` at `GET /align`
- `GET /align/targets` — favourites, for the selector
- `WS /align/events` — one JSON frame per sample, nothing else
- Run the align loop: repeatedly dispatch a traceroute at one target
- Attribute each reception to the radio that heard it, **in flight**
- Own start/stop, including a dead-man stop

## Dependencies

- `traceroute.js` — `traceroute.dispatch()` and its `'result'`/`'cancel'` events.
  **Not modified.** Its header states callers pass args and mode logic stays in
  the caller; align is just another caller.
- `device-config.js` — `getRotatorAddress()` / primary MAC, to label YAGI vs OMNI
- `dash-mode.js` — read `isListenerForMode('pasv', mac)` to warn when a radio is
  excluded
- `db.js` — favourites only. **Never reads `signal_history`** (see Invariants)

## Public interface

```js
export default router          // GET /align, GET /align/targets
export function attachAlignWs(server)   // mounts WS /align/events
export function alignStart({ num })     // → {ok, state}
export function alignStop()             // → {ok, state}
```

### Sample frame (the only thing `WS /align/events` emits)

```js
{ t: 1721400000, yagi: 11.2, omni: 4.8, delta: 6.4, hops: 0, direct: true }
```

`yagi`/`omni` are SNR in dB, null when that radio did not hear this reply.
`delta` is null unless both are present. Server computes `delta` and `direct` —
the browser calculates nothing (BROWSER_CONTRACT).

### Status frame (on connect and on state change)

```js
{ kind:'status', running:false, target:null, yagi_listening:true,
  omni_listening:true, warning:null }
```

`warning` carries a pre-formatted string when PASV's `rx` role excludes a radio —
that is the failure that would otherwise leave one curve silently empty.

## State

Module-level: the active align session (`{num, device, startedAt}`), the WS client
set, and the `traceroute` event subscriptions. One session at a time, globally.

## Events emitted

`WS /align/events` frames only. No EventEmitter.

## Invariants

- **Per-radio attribution comes from live events, never from storage.**
  `signal_history` is `(ts, num, packet_id, rssi, snr, hops)` — it has **no
  `device` column**, and `idx_sig_dedup` is `UNIQUE(num, packet_id)`, so when both
  radios hear a packet the second row is discarded. Reading it would give one
  arbitrary radio with no way to know which. Verified empirically: mesh-gw emits
  one event per receiving radio, each with its own `__ble_addr` (40 s sample,
  2 of 15 packet ids heard by both `F4:12:FA:39:F7:B6` YAGI and
  `E9:B0:3F:17:27:91` OMNI).
- **`traceroute.js` is not modified.** Align passes `cooldownMs: 0` and
  `cooldownKey: 'align'` to the existing `dispatch()`. No second dispatcher, no
  duplicated lifecycle, no change to existing behaviour.
- **One align session at a time**, and it must not run concurrently with a
  competing trace of the same target — replies carry no request id, so two in
  flight cannot be attributed.
- **Dead-man stop.** The loop stops when the last WS client disconnects. A phone
  that locks, loses signal or navigates away must not leave the mesh transmitting.
- **Never PRIMARY.** Dispatch goes through `traceroute.dispatch()`, which already
  resolves its own channel; align adds no new transmit path.
- The narrow feed carries samples and status only. No node lists, no history
  dumps, no telemetry.

## Test notes

- `/align/targets` returns only favourites
- a sample frame with one radio missing has that key null and `delta: null`
- `direct: false` when route length > 0 — a relayed reading is not alignment data
- stopping disconnects cleanly and dispatches no further traceroutes
- last-client-disconnect stops the loop (dead-man)
- `warning` is populated when PASV `rx` excludes the rotator radio
- the WS emits nothing but `sample` and `status` frames — asserted by type

## Out of scope

- The traceroute lifecycle — `traceroute.js` owns it
- Dashboard `/events` — untouched, no regression risk to the main UI
- The 7.2 MB connect payload on `/events` — real, logged separately in the bugs
  backlog. This page routes around it; it does not fix it.
- Storing align samples. They are ephemeral session data, not history.
