---
module: align-api
source: src/align-api.js
source_hash: 85297cd84245130e7d7566f25f69c181596c3b60c52990be0995e5563cdad49b
updated: 2026-07-19
---

# Module: align-api

## Purpose

Backend for the mobile Yagi alignment page: serves `/align`, runs the align
traceroute loop, and pushes a **narrow** sample stream over its own WebSocket.

> **Status: NOT PROVEN TO WORK.** The loop dispatches and the WS delivers status
> frames, but **no traceroute reply has ever produced a sample**. The one live run
> (2026-07-19) failed twice over: sends were rejected 503 because the rotator radio
> was NEED_PAIR/OFFLINE, and the tick interval was shorter than the traceroute
> timeout so every tick JOINED the pending dispatch instead of making a new
> attempt — one request per minute, then a timeout. Both are addressed below;
> neither fix has been observed working.

Exists as a separate surface because the dashboard's `/events` pushes **7.2 MB**
on connect (measured 2026-07-19: `env_history` 3.8 MB, `tilt_history` 3.0 MB).
The alignment page needs ~150 bytes per sample — about 11 KB for a whole
five-minute session. A subscription filter on `/events` would not help: the bulk
lands before any subscribe message could arrive.

## Responsibilities

- Serve `public/align.html` at `GET /align`
- `GET /align/targets` — favourites, for the selector
- `WS /align/events` — one JSON frame per sample, nothing else
- Run the align loop: repeatedly dispatch a traceroute at one target, via the
  radio `transmitterForMode('pasv')` names — NOT a hardcoded rotator
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

### Probe frame (one per dispatch attempt)

```js
{ kind: 'probe', n: 7, at: 1721400000 }
```

Emitted when a traceroute is sent. Without it the page shows a LIVE badge, no
number and no reason — indistinguishable from a broken page while standing at a
mast. The browser turns this into "Probe 7 sent — waiting for reply".

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
- **Timeout must be SHORTER than the tick interval.** `traceroute.dispatch()`
  dedupes by target, so a second dispatch while one is pending merely JOINS it.
  With the 60 s discovery default and a 6 s tick that produced one real attempt
  per minute. Align uses `ALIGN_TIMEOUT_MS 14000` with `ALIGN_INTERVAL_MS 15000`
  so every tick is a genuine new attempt.
- **The transmitting radio is a mode role**, resolved through
  `transmitterForMode('pasv')` (mode-dispatch-ssot). Hardcoding the rotator sent
  every probe into an offline radio while the primary sat READY.
- **Failures are broadcast, never swallowed.** Dispatch rejections and traceroute
  `'cancel'` push a server-side `notice` to every client, cleared when a sample
  lands. A silent failure is indistinguishable from a quiet mesh.
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
- the WS emits only `sample`, `probe` and `status` frames — asserted by type

**Verified so far:** `/align` 200, `/align/targets` returns favourites with real
labels, WS delivers identical status frames to two clients, `/events` unaffected,
both radios report `*_listening: true`.

**NOT verified:** a sample has never been produced. The dead-man stop, the notice
path, `direct:false` rejection and the 15 s retry cadence are all unobserved on
real traffic.

## Out of scope

- The traceroute lifecycle — `traceroute.js` owns it
- Dashboard `/events` — untouched, no regression risk to the main UI
- The 7.2 MB connect payload on `/events` — real, logged separately in the bugs
  backlog. This page routes around it; it does not fix it.
- Storing align samples. They are ephemeral session data, not history.
