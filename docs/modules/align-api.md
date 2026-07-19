---
module: align-api
source: src/align-api.js
source_hash: 47a5d1474e89b15e9409a336206d7d3fb80ca57c5ad9f4f430a8b643bf2e38f5
updated: 2026-07-19
---

# Module: align-api

## Purpose

Backend for the mobile Yagi alignment page: serves `/align`, runs the align
**ping** loop, and pushes a **narrow** sample stream over its own WebSocket.

Exists as a separate surface because the dashboard's `/events` pushes **7.2 MB**
on connect (measured 2026-07-19: `env_history` 3.8 MB, `tilt_history` 3.0 MB).
The alignment page needs ~150 bytes per sample. A subscription filter on
`/events` would not help: the bulk lands before any subscribe message arrives.

## Stimulus: `ping`, not traceroute (changed 2026-07-19)

The alarm firmware is ours, so it answers a direct command. `docs/mt-transport/API.md`
§3: `ping` → `pong`: `upt, rssi, snr`. This replaces traceroute entirely.

Traceroute was abandoned because it is strictly worse for this job:

| | traceroute | `ping` |
|---|---|---|
| reply correlation | **none** — no request id | `reply_id` = our packet id |
| concurrent sessions | impossible (positional attribution only) | safe |
| signal at the far end | not available | `rssi`/`snr` in the payload |
| depends on dash-mode tx roles | yes | no |

The missing request id is why the old design needed "one session at a time".
That constraint is gone.

### Command grammar — addressing is MANDATORY

```
@<target> ping        target = <shortName> | <4-hex suffix> | *
```

`API.md` §3: there is **no** unaddressed form — a bare `@verb` is **silently
ignored**. Silent is the hazard: an unaddressed ping is indistinguishable from a
dead link.

**The target is always the 4-hex suffix of the node id, never the shortName.**
Peter, 2026-07-19: *"hex suffix is safer, it will never change."* A shortName is
user-editable and a rename would silently break every command.

    HOME !987ab80f → "@b80f ping"        DEPL !8cee336b → "@336b ping"

`@*` is forbidden here — it would make every unit reply to a repeating loop.
These units are `trial-fw-v3` (post-addressing); the legacy bare-`@verb`
fallback does not apply.

## The two signal sources — semantics determined empirically

One ping, both radios heard the reply (2026-07-19):

```
OMNI envelope : rx_snr 5.25  rx_rssi -81
YAGI envelope : rx_snr 0.75  rx_rssi -108
payload       : {"type":"pong","upt":1912,"rssi":-85,"snr":5.5}   ← IDENTICAL in both
```

The payload is **byte-identical in both receiving radios' events**, which proves
it is carried inside the message: it is the **device's** reading of **our** ping
(downlink). The envelope differs per radio: **our** reading of the **device**
(uplink).

### PRIMARY SIGNAL = the pong payload

Measured over 8 pings to DEPL via the OMNI:

| source | stability |
|---|---|
| **device `rssi`** | mean −85.2, **sd 0.37 dB** |
| **device `snr`** | mean 6.0, **sd 0.16 dB** |

Chosen because:

1. It is the most stable source measured, by a wide margin.
2. It is measured **at the antenna being turned** — the direct measure of
   whether the remote Yagi is aimed at us. The envelope measures the far end.
3. It is **immune to the YAGI brownout**, which currently corrupts our own RX
   readings — the 27 dB envelope gap above is not trustworthy while that radio
   faults.
4. One number per ping: no per-radio attribution problem at all.

**Why not read it from the existing capture path** (`signal_history`): that path
cannot supply a per-radio view and never could. `db.js:172` is
`UNIQUE(num, packet_id)` with **no `device` column**, so when both radios hear
one packet the second row is **discarded** — reading it back yields one
arbitrary radio with no way to know which. Per-radio data exists **only** on the
live event path.

The per-radio envelope remains a secondary curve, taken from the live `packet`
event, **never from storage**.

## The pong arrives as TWO events — consume exactly one

| event | `reply_id` | signal location |
|---|---|---|
| `type: 'packet'` | **present** | `ev.data.packet.rx_snr` / `.rx_rssi` |
| `type: 'text'` | `null` | envelope `ev.rx_snr` / `.rx_rssi` |

`packet` is the only event carrying **both** correlation and per-radio signal.
Align consumes `packet` only. Consuming both double-counts every sample.

## Responsibilities

- Serve `public/align.html` at `GET /align`
- `GET /align/targets` — favourites, for the selector
- `WS /align/events` — sample / probe / status frames, nothing else
- Run the ping loop against one target; correlate replies by `reply_id`
- Own start/stop, including a dead-man stop

## Dependencies

- `node-settings.js` — `resolveCommandChannel()`. **Reused, not reimplemented**:
  it refuses index 0 by construction and resolves "Private" by name.
- `ws-relay.js` — `getDeviceChannelsByNodeId()`
- `device-config.js` — `resolvePrimaryNodeId()`, `getRotatorAddress()`,
  `getPrimaryMac()`
- `dash-mode.js` — PASV forcing on start
- `db.js` — favourites only

## Public interface

```js
export default router                    // GET /align, /align/targets, POST /align/start|stop
export function attachAlignWs(server)    // mounts WS /align/events
export function alignStart({ num })      // → {ok, state}
export function alignStop()              // → {ok, state}
export function handleAlignPong(pkt, rxDevice)  // called from bridge-events
```

### Sample frame

```js
{ t: 1721400000, dev_rssi: -85, dev_snr: 6.0, yagi: 0.8, omni: 5.3, delta: -4.5 }
```

`dev_*` is the primary signal. `yagi`/`omni` are the secondary per-radio envelope
SNR, null when that radio did not hear this reply. The server computes `delta`;
the browser calculates nothing (BROWSER_CONTRACT).

## Loop timing — measured, not assumed

```js
ALIGN_INTERVAL_MS = 20000   // mean reply latency measured at 16.1 s
ALIGN_REPLY_TIMEOUT_MS = 30000
```

Measured 2026-07-19, 8 pings to DEPL: **reply rate 6/8**, latency mean **16.1 s**
(min 11.9, max 18.6, sd 2.5).

Two consequences, both load-bearing:

- The interval must exceed the mean latency, so 20 s — **not** the 15 s the
  traceroute design used, and emphatically not the 14 s "a round trip is a few
  seconds" guess, which was never measured and was wrong.
- **A missed reply is normal, not an error.** At a 25% miss rate a UI that
  reports every miss as a failure would cry wolf continuously. Only report
  after `MISS_LIMIT` consecutive misses.

## Invariants

- **Never channel 0.** Commands are channel broadcasts, not DMs (Meshtastic 2.8
  rejects PSK direct texts). `channel` defaults to 0, so it is **always** passed
  explicitly, and `resolveCommandChannel()` refuses 0 by construction.
  Confirmed live: index 2, name `"Private"`.
- **Target is the hex suffix**, never the shortName. Never `@*`.
- **Consume `type:'packet'` only** — see the two-event table.
- **Correlate on `reply_id`.** An uncorrelated pong is another operator's or a
  stale reply; it must not become a sample.
- **Per-radio attribution comes from live events, never from storage.**
- **The transmitting radio defines what `dev_rssi` means** — it is the device's
  reading of *that* radio's transmission. It is therefore recorded in the status
  frame, and must not change mid-session or the curve becomes meaningless.
- **Failures are broadcast, never swallowed**, but only after `MISS_LIMIT`.
- **START forces PASV; STOP restores the previous mode.** In ACTV the rotator is
  driven by `active-tracker`, so the home Yagi swings while the operator turns
  the remote one — that perturbs the secondary envelope curves.
- **Dead-man stop.** The loop stops when the last WS client disconnects.

## Test notes

- `/align/targets` returns only favourites
- a pong whose `reply_id` matches no pending ping produces **no** sample
- both radios hearing one pong produces **one** sample with two envelope values
- a single missed reply produces no warning; `MISS_LIMIT` consecutive misses do
- stopping sends no further pings
- last-client-disconnect stops the loop

**Verified 2026-07-19:** `@336b ping` on channel 2 answered first attempt;
`reply_id` correlated to our packet id; both radios reported distinct envelope
readings; payload identical across both.

## Out of scope

- `public/align.html` / `app-align.js` — Domain 2. The frame gains `dev_rssi` /
  `dev_snr` **additively**, so the existing page keeps rendering; leading the
  chart with the device reading is a separate browser task.
- Dashboard `/events` — untouched.
