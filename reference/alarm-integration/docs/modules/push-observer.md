---
module: push-observer
source: scripts/push-observer.mjs
source_hash: 3fbeb1e8ae2987f83a73f805c9dcaf8615765f3735340ac2a56b9df550d8fafc
updated: 2026-07-20
---

# Module: push-observer

## Purpose

Read-only instrumentation for observing a live **chunk-push** transfer end to end.
It answers "did the transfer work, and if not where did it stop" from evidence,
without adding anything to the runtime.

It is a **test harness**, not a dashboard feature. It belongs to neither domain: it
subscribes to node-dash's own `/events` exactly as a browser would, and changes
nothing in `src/` or `public/`.

**It never transmits.** Triggering a fetch is a separate, deliberate act (the script
prints the exact `curl` for it). This matters because a transfer puts frames on air
and the bench unit is shared with mt-transport.

## Responsibilities

- Report every terminal outcome of a transfer: completion, error, deadline, stall.
- Verify the delivered image independently of the event that announces it
  (size on disk + CRC32), rather than trusting `chunk_done`.
- Count raw 261 frames crossing the relay to produce a **receiver-side**
  frames-per-chunk ratio, independent of mt-transport's own accounting.
- Detect silence explicitly. A push that dies quietly must produce a line.
- Assert the tilt gate stays closed under real push load.

## Dependencies

- `ws` (already in node_modules; same client the browser uses)
- node-dash running on :8000 with the alarm-transport plugin loaded

## Public interface

```
node scripts/push-observer.mjs [--host localhost:8000] [--stall-sec 45] [--expect-crc <hex>]
```

Exit 0 on a verified transfer, 1 on error/stall/CRC mismatch, so it can gate a test.

## Events consumed (exact shapes, verified 2026-07-20)

| event | shape | emitted by |
|---|---|---|
| start | `{type:'chunk_progress', num, pid, received:0, count:null, state:'started'}` | `chunk-api.js:59` |
| running | `{type:'chunk_progress', num, pid, received, count, batch, elapsedMs, state:'running'}` | `chunk-api.js:75` |
| done | `{type:'chunk_done', num, pid, bytes, elapsedMs}` | `chunk-api.js:79` |
| error | `{type:'chunk_error', num, pid, error}` | `chunk-api.js:82` |
| raw frame | `{type:'packet', data.packet.decoded.portnum: 261}` (NUMERIC) | ws-relay catch-all `:613` |
| typed frame | `{type:'private_app', portnum:261, payload_b64}` | gw AppRouter |
| tilt | `{type:'tilt_update', ...}` | `ws-relay.js:207` |

`_broadcastChunkProgress = (ev) => broadcast(ev)` (`ws-relay.js:402`) is a verbatim
passthrough, so these arrive unmodified.

## Reported lines

- `START num=<n> pid=<p>` — and `MANIFEST count=<c>` the first time `count` is non-null
  (proves manifest-first worked; `count` is `null` on the `started` event).
- `PROGRESS received/count (pct) elapsed=<s> frames261=<f>` — throttled, not per frame.
- `STALL no 261 frame for <n>s (received=<r>/<c>)` — **the important one.**
- `DONE bytes=<b> elapsed=<s> frames261=<f> ratio=<f/c> file=<path> crc32=<hex>`
  with `CRC-MATCH` / `CRC-MISMATCH` when `--expect-crc` is given.
- `ERROR <msg>` from `chunk_error`.
- `TILT-GATE-VIOLATION` if any `tilt_update` fires while 261 traffic is in flight.
- `NO-VERDICT ...` heartbeat while idle, so silence is never mistaken for success.

## Invariants

- **Read-only.** Subscribes to a WS; performs no POST and no mesh send.
- **Silence is never success.** Every terminal state prints; idle prints a heartbeat.
- **Verify, don't trust.** `chunk_done.bytes` is cross-checked against the file on disk
  and its CRC32 recomputed.
- **Does not decode 261 payloads.** Frame *counting* only — the codec is mt-transport's
  and duplicating it is explicitly out of scope. Consequence: per-chunk `seq` is not
  visible, so gaps cannot be attributed to specific chunks from this side.

## Test notes

Dry-run with no transfer in flight: must emit the idle heartbeat and NOT a false
success. That is the acceptance test for "silence is reported as silence" — the failure
mode that recurred three times on 2026-07-20 (a length filter never exercised, a
mechanism that explained an absence, and a watcher that could only match the benign case).

## Out of scope

- **Progressive JPEG display** — verified feasible (a truncated baseline JPEG renders its
  prefix in a browser: 25/50/75% all draw), but node-dash never sees a byte mid-transfer.
  `onProgress` carries counts only and `PayloadStore` writes on completion, so this is
  BLOCKED on mt-transport exposing the contiguous prefix (raised as `[partial-render]`).
  Note for whoever builds it: with ~17% loss the contiguous prefix stalls at the first
  gap and jumps when REPAIR fills it, so the image must NOT be the progress indicator —
  pair it with the numeric `received/count` bar.
- Triggering the fetch (deliberate, manual, transmits).
- Any `src/` or `public/` change — none required.

## 261 frame counting — corrected (task `push-viewer-frame-dedupe`, 2026-07-20)

**Bug as shipped:** every physical 261 frame reaches `/events` in BOTH shapes — a raw
`packet` AND a typed `private_app`. Counting both **doubled** the figure. Proven live:
in one sample `raw:261 = 3`, `typed:261 = 3`, and 3/3 raw frames had a typed twin with
the same `from` and the same 231-byte length within 2 ms. Peter saw "22 frames" for ~11.

**Fix:** count the RAW shape only (it is the one carrying `pkt.id`) and additionally
dedupe by that id, because several gateway radios each report the same transmission.

**What the number can honestly claim — this is narrower than first specced.** A mesh
REBROADCAST preserves the packet id, so deduping by id also collapses the gateway's
rebroadcasts. A receiver cannot separate "one transmission heard by two radios" from
"the same frame rebroadcast". Therefore:

- `frames` = DISTINCT packet ids seen on 261 — logical frames, NOT frames on air.
- `receptions` = raw events seen — inflated by both extra radios and rebroadcasts.

Neither is an independent measurement of mt-transport's ~2.8x frames-per-chunk, and the
page must not imply that it is. The earlier claim that node-dash could supply a
"receiver-side ratio" was wrong and has been withdrawn to them. The frames/chunk figure
is therefore labelled `receptions/chunk` and carries the caveat in the UI.

## Observing a transfer we did NOT initiate

`count`, `elapsed` and `bytes` all originate in `chunk-api`'s `onProgress`, which only
runs for a fetch triggered through `POST /nodes/:num/chunk-fetch`. When mt-transport
drives the device directly (the normal case during their bring-up — they own DEV1), 261
frames flow but no `chunk_*` event ever arrives. As shipped the page showed a ticking
frame counter beside blank fields, which reads as broken.

The page now states the distinction explicitly: with 261 frames seen but no `chunk_*`
event, it shows **"observing external 261 traffic — this transfer was not started here,
so there is no manifest, progress or byte count"**. That is reporting the ABSENCE of
received data (contract: missing state renders as an unknown indicator), not a deduction
about who is transmitting.
