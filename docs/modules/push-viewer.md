---
module: push-viewer
source: public/push.html
source_hash: 16040167b2772d9cf7d8ed2750bf70960eef0f3c3249f906275dc198b7f7f6f5
updated: 2026-07-20
---

# Module: push-viewer

## Purpose

A **standalone page** for watching a single chunk-push transfer live: progress, stall
state, and the resulting image. Its audience is Peter during a bring-up window, when
there is no gallery yet and the alternative is reading a terminal.

Deliberately standalone (`/push.html`, like `/align.html`) rather than folded into the
node tab: the real gallery is the eventual product but is frozen until mt-transport's
push receiver exists, and building it now would invite a second rewrite. This page can
be deleted the day the gallery lands, and nothing else depends on it.

**Presentation only** — `docs/BROWSER_CONTRACT.md`, referenced as that document requires.

## Data sources

| what | where from | why it is contract-clean |
|---|---|---|
| progress, stall, outcome | WS `/events` — `chunk_progress`, `chunk_done`, `chunk_error` | all page data over the WS |
| image location | `chunk_done.url` (server-computed, task `chunk-done-image-url`) | the browser never builds a path |
| the image bytes | `<img src="{url}">` → `/chunk-images/...` | an ASSET fetch, the same class as `app.js`; not page data |

No `fetch()`/`GET` for page data. The page holds only the last values it was told.

## BROWSER_CONTRACT — permitted formatting, and why no exception is claimed

Permitted by the contract's "render and format data it receives" clause:

- percentage = `received / count` rendered as a bar width — arithmetic on two
  server-supplied numbers, no decision
- elapsed seconds formatted from `elapsedMs`
- frames-per-chunk ratio displayed from counted 261 frames

**No exception is claimed, and that is a deliberate change from the first draft.**

I initially specced a client-side **stall verdict** (no 261 frame for N seconds → declare
"STALLED"). That is the browser deciding state, and the contract requires such an
exception to be approved *before* implementation. Rather than seek an exception, the page
does the contract-clean thing: it displays **"last event: N s ago"** — a formatted
elapsed time from data it was told — and renders **no verdict at all**.

The distinction is the whole point of the contract: showing *how long it has been quiet*
is formatting; declaring *that the transfer has stalled* is a judgement, and a judgement
belongs to the server, which knows the deadline and the transfer's real state.

**Follow-up raised, not silently skipped:** node-dash should emit `chunk_stalled` (it
owns `deadlineMs` and the in-flight record), after which the page renders that verdict
like any other pushed state. Until then, a long "last event" figure is visible enough to
catch a quiet death — which was the requirement — without the browser pretending to know
why.

The 261 frame counter is retained as display aggregation of events the page already
receives (counting rendered items, not deriving state). If even that is judged too far,
the server can supply the count; noted rather than assumed.

## Layout

Single column, dark/light per `prefers-color-scheme` (same inline theme switch as
`align.html`, daisyUI `business`/`corporate`).

1. **Status line** — idle / running / done / error, plus node + pid, all server-stated.
   "Last event: N s ago" sits here — a formatted figure, never a stall verdict.
2. **Progress bar** — `received / count` with a percentage; indeterminate stripe while
   `count` is `null` (before the manifest lands), because a bar that fakes a percentage
   it does not have is a lie.
3. **Facts row** — elapsed, bytes, 261 frames seen, frames/chunk ratio.
4. **Image panel** — placeholder until `chunk_done`; then `<img src="{url}">`. If
   `url` is `null` the panel says "stored — location unknown (server could not resolve
   the file)", never a guessed path.
5. **Event log** — the last ~50 raw events, newest first, so anomalies are visible
   rather than smoothed away.

## Progressive rendering — not yet, and why

Verified feasible: a truncated baseline JPEG renders its prefix in a browser (25/50/75%
all draw). But node-dash never sees a byte mid-transfer — `onProgress` carries counts
only and `PayloadStore` writes on completion. Blocked on mt-transport exposing the
contiguous prefix (channel item `[partial-render]`); when it lands, the server adds
`partUrl` to `chunk_progress` and this page points the same `<img>` at it. No rework.

**Design constraint recorded for that day:** at ~17% loss the contiguous prefix stalls at
the first gap and jumps when REPAIR fills it, so the picture can sit frozen at 30% while
`received` climbs to 90%. The image must never be the progress indicator — image for
satisfaction, numeric bar for truth.

## Invariants

- Zero decisions: no classification, no filtering, no verdicts — only the permitted
  formatting above. No contract exception is claimed.
- No page-data GET. WS only.
- Never constructs an image path — renders `chunk_done.url` or says it is unknown.
- Missing state renders as unknown, never as a guess or a zero.

## Test notes

Playwright at 1600x1000, both themes. Because a real transfer needs mt-transport's
receiver and a DEV1 window, validation drives the page with **synthetic events injected
into its own handler** — started → running (count null) → running (count known) →
done-with-url, done-with-url-null, and error — and confirms each render. That proves the rendering, and explicitly NOT
that a real push works; the harness (`push-observer`) covers the live run.

## Out of scope

- Triggering a fetch (the page is read-only; `POST /nodes/:num/chunk-fetch` is deliberate
  and manual — it puts frames on air and the bench unit is shared).
- The eventual node-tab gallery + `image_grid` section.
- Any `src/` change — none required; `chunk_done.url` already shipped (fe84ca5).

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

## HARD CONSTRAINT — never poll `push stat` while `upst = 2`

This page does not poll and must not start. Control traffic is TEXT at hop 3 and gets
rebroadcast; chunk frames are hop 0 and are not — so polling the device *during* a
transfer measurably SLOWS the transfer being watched. That inverts the usual instinct
(poll harder while busy), which is why it is written here rather than left in a task note.

Progress during a transfer comes ENTIRELY from the `chunk_progress` events already on the
WS. Any future "is an image waiting" discovery probe polls only at `upst` 0 / 1 / 3.

Source: mt-transport, measured on the bench 2026-07-20.

## Why there is no START button here (yet)

The page is read-only, and that is not merely conservatism. A push transfer is NOT
fire-and-forget: something must run the receiver for the whole ~3 minutes — hold
`store[seq]`, then drive PROGRESS_Q, REPAIR (explicit id list) and COMPLETE. A button
that only fires START gets 32 chunks into the void AND leaves the device holding its
buffer.

That loop is mt-transport's to own (it needs their binary 261 codec; duplicating it here
is explicitly out of scope). The wiring on our side already exists — `POST
/nodes/:num/chunk-fetch` answers 202 and then awaits the transfer for its full duration,
so the route handler IS the long-lived process the loop runs inside. The missing piece is
their single `push` entry point on `Client`, same `{onProgress, deadlineMs}` shape as
`fetch`. When it lands, the button is one call and nothing else moves.

## The START control (task `push-start-button`, 2026-07-20)

Peter: *"I still see no start button and the waiting for manifest just keeps on running."*
Both were real.

**Bug: the idle page claimed to be mid-transfer.** The progress card was `x-show`n
whenever `state !== 'done'`, so a page with no transfer sat on "waiting for manifest…"
with an animated indeterminate bar, forever. It is now shown only while
`state === 'running'`. This was visible in a screenshot I had already looked at.

**The start control.** The page is no longer read-only. It carries a target select, a pid
field and a Start button, POSTing `/nodes/:num/chunk-fetch` — a submission workflow,
which BROWSER_CONTRACT sanctions; everything the page *renders* still arrives over the WS.

- **Targets** come from the server's `node_list`, filtered to `client_role === 'PAC_ALARM'`.
  `client_role` is server-computed (`src/client-role.js`); choosing which rows to offer is
  display filtering, not classification. The browser sends only `num` + `pid` — gateway
  and channel remain server decisions.
- **Disabled** when no target is chosen, while `starting`, and whenever
  `state === 'running'` — including a transfer replayed on connect that this browser never
  saw begin (`chunk-inflight-replay`). The server's one-in-flight `409` remains the real
  guard; the disabled button is presentation of server-stated state, not an alternative to it.
- **Confirms before firing**, because it transmits on the Private channel for ~3 minutes.
- **No cancel**, and the footer says so: `deadlineMs` (4 min) is the only stop. That is a
  property of `Client.fetch`, not a UI omission.

**It drives the pull path today.** `chunk-api` calls `chunkFetch`, which is still
`Client.fetch`. When mt-transport ships the single `push` entry point the route swaps to it
and this control does not change.

Verified in the browser: targets populate from the live feed (`U33B` / 2364420971);
button disabled with no target, enabled once chosen, and reading "transfer in progress"
while a transfer runs.

## Corrections from mt-transport 2026-07-20 (bench now fw 260720-11)

**Cancel copy withdrawn.** The footer said a transfer "cannot be cancelled". mt-transport
is shipping `signal` (AbortSignal) on the push entry point and asked explicitly that the
copy not go out. It now reads "cancel is not available yet", which is true today and does
not contradict what is coming. When `signal` lands: add a cancel control and a route to
abort the in-flight transfer.

**DISCOVERY IS NOT AVAILABLE — do not build on `up`/`upst` yet.** An earlier note in this
repo recorded them as arriving in the device's periodic status frame. They are NOT. Today
they exist ONLY in the on-demand `push stat` reply. Combined with the rule that we must
not poll while `upst = 2`, discovery of "an image is waiting" is genuinely BLOCKED until
mt-transport ships the status-frame half. Treat it as pending, not working — a UI built
on it now would query a frame that is never sent.

**`push q` and `push rep` are now SILENT (fw 260720-11).** Neither returns a text ack any
more: the binary PROGRESS frame on 261 is the answer to `q`, and the resent chunks are the
answer to `rep`. Anything waiting for a text reply to either will hang. `push` (start),
`push done` and `push stat` still reply in text. The acks were removed because each was a
second transmission at hop 3, rebroadcast mesh-wide, landing in the middle of the transfer
it was asking about.

**Push entry point, confirmed signature:**
`push(target, pid, { onProgress, deadlineMs, payloadDir, signal })` — positional
`target, pid` exactly as `fetch`; resolves with the assembled Buffer; rejects on
deadline/abort/CRC failure; `onProgress({received, count, elapsedMs})`, no `batch`.

**mt-transport owns START — node-dash must not also send `push <pid>`.** Two STARTs
restart the pass and waste ~2 minutes of air.

**No "device busy" UI state is needed.** If the device is already sending (`upst=2`) or
awaiting COMPLETE (`upst=3`), their client ADOPTS the transfer rather than rejecting —
and adopting at `upst=3` is a fast resume (query + one repair round instead of
re-streaming 32 chunks). Our one-in-flight `409` still matters, but it guards against two
callers inside OUR server, not against the device.

**`.part` naming confirmed:** `<final name>.part` beside the final file in `payloadDir`,
removed on success. Predictable, so progressive render needs no new API from them.

## The Publish control (2026-07-20)

Sits beside Start. POSTs `{command: 'push pub'}` to the existing `/nodes/:num/command`
route — no new backend, and the server still owns gateway and channel.

**Deliberate, never automatic.** COMPLETE clears the device's pending upload, so after a
successful transfer the next START is refused until the image is re-published from flash
(the JPEG never leaves flash; it is the pending *upload* that is cleared). But publishing
blindly is unsafe: during a live transfer it resets the cursor under the stream, and at
`upst=3` it discards a finished pass and re-sends all 32 chunks. So the operator decides,
with a confirm that says exactly that, and the conditional version lives in
`Client.push()` where `upst` is already known.

Disabled while a transfer is running, and while publishing.

## Progress log records TRANSITIONS, not ticks (2026-07-20)

`onProgress` fires about once per second, and the event log called `note()` on every one —
so a transfer waiting out its tail produced fifty identical `progress 31/32` lines and
buried START, MANIFEST and every error. Peter saw exactly that.

The log now records a line only when `received/count` CHANGES. The numeric readouts above
it still update every tick, and an unchanged tick still counts toward liveness (it feeds
"last event: N s ago"), so nothing is lost except the repetition.

Verified: 40 identical ticks now produce ONE line, and the surviving log reads
`progress 32/32 · progress 31/32 · progress 30/32 · MANIFEST count=32 · START …`.

## Interrupted transfers, and `count: 0` is not a manifest (2026-07-20)

**`chunk_idle`:** if the server reports no transfer while this page believes one is
running, the transfer was interrupted — a restart or a crash — and the page now says so
(`error`, with "received chunks are not resumable across a restart") instead of leaving a
frozen bar that looks live. A page already idle is unaffected.

**`count: 0` is no longer treated as the manifest.** The client emits an early progress
tick with `count: 0` before the manifest lands; taking it as the first real count logged
`MANIFEST count=0` and then SUPPRESSED the true manifest when 32 arrived. Now a manifest
requires `count > 0`, and the early tick renders as `progress 0/?`.

Verified against the exact sequence from a real run: `START · progress 0/? · MANIFEST
count=32 · progress 0/32 · progress 20/32`, then `chunk_idle` → `error`.

## Abandoned partials are cleared when a new transfer starts

A `.part` left by a failed transfer was announced to every new session forever — Peter
opened a fresh session hours later and was still shown `pid-1.jpg.part · incomplete`.

Cleared at the START of a new transfer for that pid, not on failure: immediately after a
failure the partial is genuinely useful (it renders as half a picture, which is how the
16/32 stall was diagnosed). It becomes clutter only once superseded.

The caption also no longer prints `?` for the node — push writes to the payload root, so
there is no node directory and the placeholder invented an unknown that was not one — and
now carries age, so a stale partial reads as `pid-1.jpg.part · incomplete · abandoned
11 min ago`.

## One image, not two (2026-07-20)

`chunk_done.url` and the `chunk_images` entry point at the SAME file once the route saves
it, so a successful transfer rendered the picture twice. The standalone render is now
suppressed when the stored listing already contains that URL — verified: a `chunk_done`
naming an already-listed file leaves the count at one.

## Arriving vs stored (2026-07-20)

Peter: *"the current image must not show the last download."* The image panel now splits on
what the SERVER labelled each file:

- `arriving` = `partial` — rendered FIRST, warning border, "receiving now", filling as the
  server re-announces the growing `.part` every ~4 s with an mtime-versioned URL.
- `stored` = completed — below, under "previously fetched" while a transfer runs.

History is kept (Peter is fine with that); it simply cannot occupy the current slot. The
split is on the server's `partial` flag — the browser classifies nothing.

## Why the live image stops growing at ~10% (2026-07-20)

Peter: *"the dynamic render only happens in the first approx 10% of the transfer, the
remaining 90% only renders at the end."* That is inherent, and worth stating in the UI
rather than leaving it to look like a stall.

A JPEG decodes only up to its FIRST missing byte, and the `.part` holds the CONTIGUOUS
PREFIX. So the picture fills until the first lost chunk — chunk 3 of 32 gives ~10% — then
freezes while later chunks land where they cannot be drawn, then jumps to the full image
when the repair round closes the gap. At ~17% loss, an early gap is the norm.

Nothing fixes this: zero-filling the hole does not help, because the decoder still stops
at the corrupt byte. mt-transport predicted exactly this ("the image must NOT be the
progress indicator") and the design already follows it — numeric bar for truth, picture
for satisfaction. The missing piece was simply telling the viewer, so the caption under an
arriving image now explains it.

## The live image toggled between the picture and nothing (2026-07-20)

Peter: *"it toggles between the dynamic image and nothing … it should only update if the
new size > last size?"* Right on both counts, and there were two causes.

**1. The `x-for` key was the URL, which changes on every announce** (it carries an mtime
cache-buster). Alpine therefore destroyed the `<img>` and built a new one each time — a
guaranteed blank until the bytes arrived. Keyed on `name` instead, the element persists.

**2. A stable key still cannot survive a mid-write fetch.** The client rewrites the
`.part` wholesale (`writeFileSync` of the concatenated prefix), so a fetch landing inside
that window gets a truncated or empty body. Alpine cannot help with that, so the swap is
done in plain JS: the candidate is loaded off-screen with `new Image()` and promoted to
`liveSrc` ONLY on a successful decode. A failed or partial fetch keeps whatever is on
screen and retries on the next announce.

Net effect: **the picture can only ever go forwards.**

Verified: 13 samples across 4 growing announces — zero blank frames; and an announce
pointing at a genuine 404 leaves `liveSrc` unchanged with the previous frame still
painted. (The first attempt at that negative test was invalid — it used a bogus query
string, which express ignores, so the real file was served and nothing was proven.)

Server side, per Peter's suggestion: the periodic re-announce is skipped unless a partial
has actually GROWN, so viewers never re-fetch identical bytes.

## The live frame is a CANVAS, not an `<img>` (2026-07-20)

Third attempt at the flicker, after two that failed:

1. `x-for` keyed on the URL — which changes every announce (mtime cache-buster) — so
   Alpine destroyed and rebuilt the element each time. Blank until load.
2. Stable key plus preload-and-swap-`src`. Still blanked, because `.part` is served
   `no-store`: assigning `src` triggers a SECOND fetch, and that fetch can land while the
   client is rewriting the file (`writeFileSync` of the whole prefix), yielding a
   truncated body.

A canvas removes the refetch entirely. The candidate is decoded ONCE off-screen via
`new Image()`, and on success blitted with `drawImage`. Nothing ever clears the canvas, so
a failed or partial load simply leaves the last good frame — the picture can only move
forwards. Before the first successful decode a placeholder is shown instead
("waiting for the first decodable chunk…"), so an empty canvas is never mistaken for a
blank image.

Peter's steer — *"if alpine can't handle it use js instead"* — was the right call; the
mistake was trying two more declarative variants first.

**NOT yet verified during live streaming.** The canvas painted (`livePainted` true) but the
transfer reached 32/32 before the streaming phase could be sampled, and the `.part` is
removed on success. Confirm on the next transfer: sample the canvas while chunks arrive
and check for blank frames.

## The Image panel states its own state (2026-07-20)

Peter reported a blank panel for an entire transfer, with a hard refresh before every run,
while a freshly-loaded Chromium here painted the canvas. Three different failures look
identical from outside: nothing announced, announced but not decoded, decoded but not
drawn.

A permanent one-line readout now distinguishes them without devtools:

    arriving 1 · stored 1 · decoded yes

plus `· decode FAILED (browser refused the truncated JPEG)` in red when `probe.onerror`
fires — the case a strict JPEG decoder produces, which otherwise yields an empty panel and
no console error.

**Standing correction on method:** I attributed the blank panel to a stale tab, having
never observed Peter's browser. It was an assertion with no evidence behind it, and it was
wrong. The readout exists so the next report carries data rather than another guess.

## pid is optional; a mismatch offers the real one (2026-07-21)

The pid box defaults to BLANK (placeholder "auto"). Blank omits `pid` from the request, and
the server uses whatever the device actually holds. The old default of `1` is what produced
the refusal loop once the device superseded it with a fresh capture.

On a 409 carrying `available`, the device's real pid is placed in the box — so the next
press is one click, but the operator makes the choice. The server does not substitute.
