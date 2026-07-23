---
module: align-api
source: src/align-api.js
source_hash: 35875c49b9f858cfe9f996bfcc5cfbebf95cf91d2ef4d413fec938e057adbb2f
updated: 2026-07-23
---

# Module: align-api

## Purpose

Backend for the mobile Yagi alignment page. Serves `/align`, runs the align
**ping** flow, and — per `docs/BROWSER_CONTRACT.md` — **owns the entire align
session view-model**, pushing it complete over its own WebSocket. The browser
renders it and computes nothing.

Separate surface because the dashboard `/events` pushes 7.2 MB on connect; this
page needs a few hundred bytes per update.

## Stimulus: `ping` (see history below)

The alarm firmware is ours and answers `@<4-hex-suffix> ping` → `pong`: `upt,
rssi, snr` (`docs/mt-transport/API.md` §3). Addressing is mandatory (a bare
`@verb` is silently ignored); the target is always the node-id **hex suffix**,
never the editable shortName (Peter). `@*` is forbidden; never channel 0 —
`resolveCommandChannel()` (node-settings) resolves "Private" and refuses 0.

The pong **payload** `rssi`/`snr` is the DEVICE's reading of our ping, measured at
the antenna being turned — the primary signal, and the most stable source
(sd 0.16 dB). The per-radio **envelope** (`pkt.rx_snr`/`rx_rssi`, one event per
receiving radio) is OUR antennas hearing the device back — the secondary readout.
Per-radio data exists only on the live event path (`signal_history` is
`UNIQUE(num, packet_id)` with no device column, so it discards the second radio's
copy). The pong arrives as two events; align consumes `type:'packet'` only (it
alone carries both `reply_id` and per-radio signal).

## Reading = signal QUALITY, not raw dB

Raw rssi/snr are meaningless to the operator (Peter). The displayed value is
**`signalQuality(rssi, snr)`** — the same 0–100 used across the node cards,
messages and node-status — computed **here**, never in the browser. The band
**label** (Excellent ≥76 / Good ≥51 / Fair ≥26 / Poor) and its semantic colour
class are computed here too (bands per `node-status.js`). Raw dB rides along in the
view-model for the record but the page leads with quality.

## Commanded bursts, not a timer

Pings are commanded — the operator points the antenna, presses PING. A reply takes
~16 s, so this is a discrete spot measurement, not a swept meter.

**Each press fires a BURST of N pings** because a single ping jitters at a fixed
position (~0.7 dB measurement noise); averaging N cuts it by √N. Decided from the
measurements, not guessed:

- **N** is a page control, **1–5, default 4** — raw user input, sent with the
  request (the one thing the browser is allowed to originate).
- The N pings fire **~1200 ms apart** (just over the collect window, so each is a
  genuine separate attempt), each correlated by `reply_id` and tagged to the burst.
  As each lands, the progress (`got`/`of`) is pushed so the button shows "gathering 3/4".
- **One burst-level deadline** resolves the whole burst, sized to the reply window:
  `(N−1)·BURST_SPACING_MS + replyWindowMs`. There is **no per-ping timeout** — an
  unanswered ping simply never lands a sample. This is deliberate: a per-ping
  timeout made a mixed burst (some replies, some silent) sit "gathering" for the
  full timeout and reject presses with 409 the whole time, even though the average
  was already available.
- **The reply window is a PERSISTED, operator-set value** (config key
  `align.reply_window_sec`, **default 30 s**, clamped 5–120). It is the "period to
  wait for a reply" field on the page. It matters because a weak node (HOME, −116
  dBm) can answer at **18–43 s** — longer than the old fixed 20 s window, which
  discarded those replies as "too late" (the "align never gets a reply" bug). A
  larger window catches them. `alignStart`/`alignPing` read the config at burst
  creation, so a change takes effect on the next press.
- **The window NEVER blocks a completed burst.** The burst also resolves **early**
  the instant every ping has resolved — all landed, or all sends failed
  (`maybeResolve` on `done >= of`). So if all replies are already in, the reading
  appears at ~reply time, NOT at the window. Only a *partial* burst (some silent)
  runs to the deadline. This is the load-bearing invariant to verify: set the
  window to 30 s, land all replies at ~16 s → resolves at ~16 s.
- On resolve, one **averaged reading** is appended — mean quality, mean rssi/snr,
  **spread** (max−min of the quality samples, the answer to "is a gap real or just
  noise"), `got`/`of`, and per-radio RX quality averaged over the samples each
  radio heard (null when a radio heard none — an honest gap, not a zero).
- `got === 0` appends no reading and sets a warning; the page re-enables PING.

## The view-model (the only thing the WS pushes)

One frame, broadcast complete on every change (connect, burst start, each reply,
burst resolve, stop). `GET /align/state` returns the exact same complete model
for clients whose reverse proxy cannot upgrade the WebSocket.

```js
{
  kind: 'align',
  running, target, channel,
  tx: 'OMNI',                       // which home radio transmits (label)
  nBurst: 4,                        // configured burst size (echo of the control)
  replyWindowSec: 30,               // persisted reply-wait period (the page field)
  burst: { active: true, got: 2, of: 4 } | null,   // in-flight progress
  warning: null,
  best: { n: 8 } | null,
  current: { ...currentReading, gapToBest, bestN, bestAgo } | null,  // the headline,
                                    // last reading + its relationship to the best
  readings: [ {
    n,                              // reading index + on-screen label
    quality, label, cls,           // averaged 0–100, band label, semantic class
    spread,                        // ± quality points across the burst
    got, of,                       // samples averaged / attempted
    rssi, snr,                     // averaged raw, small/for the record
    yagi_q, omni_q,                // per-radio RX quality, null if not heard
    barPct,                        // session-relative bar height 0–100
    isBest, isCurrent,
    trendDir: 'up'|'down'|'same',  // vs the previous reading
    trendDelta                     // signed quality points vs previous
  } ]
}
```

- **`barPct` is computed here** — session-relative scaling (min…max of the
  readings, padded, floored at 8) is a decision, not formatting, so it belongs to
  Node. The browser only sets a height from the number it is given.
- **`isBest` / `isCurrent` / `trend*` are computed here.** Recomputed across the
  whole list whenever a reading is appended (a new best re-flags the old one, new
  min/max rescale every bar).

## Session lifecycle

- `POST /align/ping { num, n }` opens/re-targets the session (forces PASV, resolves
  tx radio + Private channel), then fires a burst of `n`. One button, no separate
  start.
- `GET /align/state` returns `computeView()` without changing the session. It is
  the authoritative polling fallback, not a second model implementation.
- `alignStart` forces PASV (restored on stop); ACTV would swing the home Yagi and
  perturb the per-radio readout.
- Dead-man stop when the last WS client disconnects.
- **Known foot-gun (bug backlog #29):** the session is in-memory; a process
  reload/crash mid-session strands dash mode at PASV. Out of scope here.

## Dependencies

- `mesh-send.js` — `sendMeshText()`. Each ping is sent through the shared record-on-send
  path (`category: 'ping'`), not a raw `fetch` — so every probe lands in the message
  feed. `sendMeshText` throws on a gateway error, which `sendPing` treats as a
  resolved (missed) ping.
- `utils.js` — `signalQuality()` (the shared 0–100)
- `node-settings.js` — `resolveCommandChannel()` (refuses 0, resolves "Private")
- `ws-relay.js` — `getDeviceChannelsByNodeId()`
- `device-config.js` — `resolvePrimaryNodeId()`, `getRotatorAddress()`, `getPrimaryMac()`
- `dash-mode.js` — PASV forcing
- `db.js` — favourites only

## Public interface

```js
export default router                    // GET /align/targets|state; POST /align/ping|stop|reply-window
export function attachAlignWs(server)    // mounts WS /align/events; pushes the view-model
export function alignStop()              // → {ok, state}
export function handleAlignPong(pkt, rxDevice)  // called from bridge-events
```

`POST /align/reply-window { sec }` clamps 5–120, `setConfig('align.reply_window_sec', sec)`,
pushes the updated view-model, returns `{ ok, sec }`. The value is server-owned and
persisted; the browser field is raw input that calls this (BROWSER_CONTRACT).

## Invariants

- **Browser renders, never decides.** Every derived value — quality, label,
  colour, best, trend, gap, bar height, burst progress — is computed here and
  pushed. `docs/BROWSER_CONTRACT.md`. The only browser-originated value is the N
  control (raw input).
- **Never channel 0**; target is the hex suffix; never `@*`.
- **Consume `type:'packet'` only** — the two-event pong; the text copy would
  double-count.
- **Per-radio attribution from live events, never storage.**
- **TX radio is fixed for the session** (OMNI — the YAGI is unreliable since its
  WiFi→BLE swap and cannot transmit dependably); it defines what the quality means.
- One session at a time; dead-man stop.
- `GET /align/state` and WS frames are byte-equivalent serializations of the one
  `computeView()` result; transport choice cannot change displayed state.

## Test notes

- a burst of N against DEPL yields ONE reading whose `quality` is the mean and
  `spread` the max−min of the landed samples; `got/of` reflects real losses
- both radios hearing a pong populate `yagi_q` and `omni_q`; a radio that missed
  is null, not 0
- two WS clients receive byte-identical view-models
- `got === 0` yields a warning and no reading
- appending a new best re-flags `isBest` and rescales every `barPct`
- block WS upgrade: `GET /align/state` still exposes burst start, progress,
  resolution and stop without initiating or mutating a session

## Out of scope

- `public/*` — Domain 2, its own step; renders this view-model only.
- Dashboard `/events`; rotator control.
