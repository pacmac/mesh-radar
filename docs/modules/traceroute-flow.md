---
module: traceroute-flow
source:
  - src/traceroute.js
  - src/aim.js
  - src/resolve.js
  - src/traceroute-api.js
source_hash: 889572043b7c387226dc5779ef3845768e89e67d3c0fc8949a3c936459ab0747
updated: 2026-08-18
---

# The traceroute flow, as Peter specified it

## His words, 2026-08-18

> "when traceroute is called it has min 3 args, 1 radio, 2 node, 3 timeout. it
> then resolves the radio, it then looks up the last known info about that node
> to find out if it was direct or relayed. if it is directional <> 360 degrees
> then it determines the rotator and aims the antenna via aim() EITHER at the
> node or it's relay node. aim accepts min 2 args bearing and hold time (ms ???)
> which is the same as the timeout passed to traceroute. once the rotator has
> confirmed it is aimed it starts the traceroute and saves it. of course some of
> this is skipped if the radio is an omni directional."

And: *"aim() resolve() and traceroute() need to be changed to behave like this."*

## The flow

```
traceroute(radio, node, timeout)
  1  resolve(radio)                    -> mac, node_id, beam_deg, rotatorId
  2  beam_deg == 360  ->  skip to 5
  3  last known route for `node`       -> direct, or relayed via X
  4  aim(bearing, hold = timeout)      -> at the node, or at its relay
     CONFIRMED?  no -> do not dispatch
  5  dispatch, await reply or timeout, save
```

## What this CHANGES from what is in the tree today (commit 4971d77)

Three of these were raised as concerns before he gave the instruction. He gave it
anyway; that is the decision, and it is recorded here so the reasoning is not
lost if the behaviour is ever questioned.

### 1. `hold` becomes the traceroute timeout — a 4–6× longer hold on a SHARED rotator

| | today | after |
|---|---|---|
| hold | `discovery.hold_sec` = **15 s** | `timeout` = **60 s** (pasv) / **90 s** (mission) |

Live config read 2026-08-18: `hold_sec 15`, `pasv_config.timeout_sec 60`,
`discovery.mission_timeout_sec 90`.

**The tension, stated once and then set aside.** Peter's own standing rule is
point-and-hold briefly, yield rather than queue, never a long lockout — the
rotator is shared with the garage alarm, which needs it about every 15 minutes
for up to 15 seconds. And the arithmetic runs the wrong way: a 3-hop success
came back in 26.2 s, but a timeout burns the whole window, and timeouts are the
common outcome (639 timeouts to 1 send-failure in one measured 24 h). So the
beam is held longest exactly when nothing is gained.

**Implemented as instructed.** The safety backstop is unchanged and unrelated to
this decision: `rotator.js`'s `HOLD_CEILING_MS` (120 s) still clamps every
caller, and 60/90 s sit under it, so nothing clamps in normal operation.

**The cheaper alternative, for the record, not implemented:** release the hold on
reply-or-cancel with `timeout` only as its ceiling. Same beam coverage during the
transmission and the reply, without holding through the silence.

### 2. A failed aim now ABORTS the dispatch

Today `_resolveAim` records `settled: false` and the trace goes out anyway, under
the older rule *"a rotator that will not move must not stop a trace, it must be
recorded as unaimed."*

Peter: *"once the rotator has confirmed it is aimed it starts the traceroute."*
So confirmation becomes a precondition. If the rotator is busy (the alarm holding
it) or the move fails, there is no dispatch.

**What this costs:** on a busy rotator, directional traces stop happening rather
than happening unaimed. **What it buys:** we never again fire a 35° beam at
whatever azimuth someone else left it — the fault that produced 303 YAGI attempts
across 246 distinct azimuths spanning 0.85–359.98°.

The attempt is still RECORDED, with `status` saying the aim failed, so a rotator
that is never free is visible rather than silent.

### 3. Aim target reduces to node-or-relay

Peter: *"EITHER at the node or it's relay node."*

| rule | today | after |
|---|---|---|
| no known route | aim at the node | **kept** |
| relayed, relay far | aim at the relay | **kept** |
| relayed, relay close, hop 2 proven and better aligned | *bypass* — aim at hop 2 | **retired** |
| relayed, relay close, not on the rotator | do not rotate | **retired** |

The two retired rules had measurements behind them — the bypass had 155 cases,
PJ1 alone 44 (endpoint 62°/3 km, hop 1 T4 at 274°, hop 2 WLCD at 62°/3 km) — so
they are named here rather than deleted silently. Re-adding either is then an
informed choice, not a rediscovery.

## What does NOT change

- **`resolve()` keeps its shape.** Peter's flow needs exactly what it already
  returns: the radio, `beam_deg`, and `rotatorId`. No change is required to it
  beyond what shipped in 4971d77.
- **Traceroute takes no channel, confirmed.** mesh-gw exposes
  `send_traceroute(to: int)` — `to` only (`docs/gw/modules/ble_device.md:66`) —
  where `send_text` validates channel 0–7 (`docs/gw/modules/methods.md:21`). The
  channel is the firmware's choice, not ours, so `resolve()`'s `channels` half is
  simply unused on this path. It stays on the bundle because resolve is also
  called by things that DO send text.
- The `directional` test is `beam_deg != 360`, which is Peter's own wording.
  Unknown beam width (`null`) stays not-directional: we do not claim a radio
  needs aiming on the strength of a missing number.

## The entry point: `POST /traceroute`

Peter, 2026-08-18: *"you should be able to call this via post but no dashboard
automation will be added for this yet."*

```
POST /traceroute
  { "radio": "rotator", "node": "!da5af428", "timeout_ms": 45000 }
```

`radio` defaults to `'auto'`. `node` accepts `!hex` or a node num. `timeout_ms`
is required — it is argument 3, not an option, and for a directional radio it is
also the hold.

**THE PATH DELIBERATELY CARRIES NO NODE ID.** The old route was
`POST /:nodeId/traceroute`, and deleting it on 2026-08-17 did not stop dispatch —
it made it *unmediated*. `src/index.js` has a catch-all
`app.use(/^\/![0-9a-f]+/i, proxyToBridge)`, so once the handler was gone the
request fell through to mesh-gw and the browser's TRACE button kept transmitting
with none of the guards and no row recorded. A body-carrying `/traceroute`
cannot match that regex, so this cannot regress the same way. It is also mounted
at `index.js:361`, ahead of the proxy at `:390`.

Status codes distinguish outcomes that used to be one word:

| code | meaning |
|---|---|
| 200 | answered — the result is in the body |
| 400 | bad arguments, with the accepted radio vocabulary listed |
| 409 | **aim not confirmed** — the rotator was busy or would not move, so nothing was transmitted |
| 429 | cooldown |
| 504 | dispatched, no reply within `timeout_ms` |

`GET /traceroute_history?to_num&limit` is restored alongside it: a dispatch you
cannot read back is not testable. The per-device variant stays removed — that
served the Performance page, which is still gone.

**No dashboard automation.** Nothing in `public/` posts here and nothing calls it
on a schedule, by instruction.

## Signatures

```js
// traceroute.js
run(radio, node, timeoutMs, opts = {})      // three positional args, then options

// aim.js
aimAt(bearing, holdMs, opts = {})           // two positional args
```

`aimAt` resolves its own rotator, which is unambiguous while one rotator is
connected. Verified 2026-08-18: `connected: true, variant: v4, active_target:
v4`; v5 (`ws://192.168.10.195:81`) is a CONFIGURED target and is **not** live —
Peter, same day: *"v5 is NOT live ATM."* When v5 returns, `aimAt` needs to be
told which rotator, and `resolve()` already carries `rotatorId` for that.

## Test notes

1. `resolveRadio('non-rotator')` (OMNI, 360) → traceroute dispatches with no aim
   call at all. Assert `rotator.point` is never invoked.
2. Directional radio, aim confirmed → dispatch proceeds, row carries the aim
   provenance.
3. Directional radio, aim NOT confirmed (rotator stubbed busy) → **no dispatch**,
   and the attempt is recorded with the aim failure.
4. `hold` passed to `rotator.point` equals the `timeout` given to `traceroute`.
5. Node with a known relayed route → aim bearing is the relay's, not the node's.
   Node with no route → the node's own bearing.

All of these are testable with the rotator's transport stubbed. **Dispatching a
real traceroute is not, and is not attempted:** it puts a frame on air on a
channel we do not choose, and pointing moves an antenna shared with the garage
alarm.

## Out of scope

- Wiring anything to call `traceroute.run()`. Still nothing does, by Peter's
  sequencing rule.
- Which channel the firmware picks for a traceroute — an mt-transport/mesh-gw
  question, to be asked of the device.
