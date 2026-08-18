---
module: traceroute-decode-restored
source:
  - src/bridge-events.js
source_hash: 8b8a38c38fcb31250012ec7ebdcc97e74ff9d64de5fdb235daf2cb7f69394b2b
updated: 2026-08-18
---

# Replies were never decoded, so every traceroute timed out

## The fault

`traceroute.handlePacket()` — the function that decodes a `TRACEROUTE_APP` reply,
matches it to the pending dispatch, resolves the caller and writes the `ok` row —
**was called by nothing**.

Both call sites were removed from `src/bridge-events.js` in `c297b9d`
(2026-08-17), correctly at the time: every dispatcher had been removed, so
nothing could be pending and a decoder had nothing to match. Dispatch came back
on 2026-08-18 as `POST /traceroute`. **The decode did not come back with it.**

So from the moment the POST route went live, a traceroute could not succeed. The
reply could arrive perfectly, on the right radio, from the right node — and
nothing would look at it. Every dispatch ran to its full timeout and recorded
`status='timeout'`.

## What it cost, and what it did NOT cost

Every traceroute since the POST landed: 5 attempts on 2026-08-18, both radios,
all timeouts, including T4 / Preston~Bowyer which has 113 attempts at 70% and had
been **heard on RF 60 seconds before it "failed"**.

**It does NOT explain the 12–17 August decline**, which predates all of this
work:

```
day          OMNI att/ok      YAGI att/ok
2026-08-12   392 / 68         528 / 0     ← YAGI step change
2026-08-15   406 / 97         595 / 0
2026-08-17   818 / 13         108 / 0     ← OMNI slide
```

Those are real and separate. This bug sits on top of them and made every
measurement taken after it meaningless.

## How it was missed

Everything about the dispatch path was verified on air — the aim reached the
right bearing, the frame was handed to the gateway, the row was written, the
status feed emitted all its phases. **The one thing never verified was a
reply**, because no reply ever arrived to verify, and its absence was attributed
to the mesh: the YAGI's 0.2% and the OMNI's 1.6% made a timeout the expected
outcome. A broken decoder and a silent mesh produce identical evidence.

Peter's instinct is what broke the tie: *"my gut feeling tells me there is nothing
wrong with either RADIO, this is a node-dash issue."*

**The lesson worth keeping: a component removed as dead must be re-checked when
the thing that made it dead comes back.** The dispatcher's removal is what made
the decoder dead code; restoring the dispatcher should have restored the
decoder, and nothing linked the two.

## The change

Restore the V2 decode in `bridge-events.js`, both paths that existed before:

- raw `TRACEROUTE_APP` packets → `traceroute.handlePacket(pkt, rxDevice)`
- the gw's typed `traceroute` event → same, via a synthetic packet

The V1 legacy branch is NOT restored — it decoded `route_discovery` inline and
resolved relay positions itself, duplicating what `traceroute.js` owns.

## Test notes

1. `grep handlePacket src/bridge-events.js` finds a live call, not a comment.
2. A real traceroute to a live node produces `status='ok'` with a route, rather
   than running to timeout.
3. The status feed emits `answered` rather than `timeout`.
4. An OVERHEARD reply (no pending dispatch of ours) is still recorded with null
   attribution — decoding is not gated on having dispatched.
