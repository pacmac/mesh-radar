---
module: alarm-images
source: src/alarm-images.js
source_hash: 2d2838bae1a76281c4aede17fb3a75804ea5108ea212704d77dd8840da5519a2
updated: 2026-08-01
---

# Module: alarm-images

## Purpose

**ALARM PLUGIN — not core.** Polls pac-host for image-transfer progress, formats
every displayed string server-side, and pushes `alarm_images` over the WS. Delete
this file and its one import in `index.js` and node-dash is unchanged.

Peter, 2026-07-29: *"so I have some visibility"* — the point of the Camera page is
to watch a picture arrive from the garage instead of guessing whether anything is
happening. From GARG a single image is a ~20 minute operation.

Companion to `alarm-sections.js` and `alarm-ws.js`. See `docs/CAMERA_PAGE_SPEC.md`.

## Responsibilities

- Poll `GET /v1/mesh/images/<unit>/progress` **and** `/stored` for every
  pac-host unit every 2 s — both are local reads (~1.2 ms and ~1.5 ms)
- Shape each transfer and each stored image into display-ready strings — the
  browser formats nothing
- **Remember attempts that ended**, because pac-host does not
- Own the stored-pid allowlist (`isStoredPid`) that `alarm-image-api.js` gates on
- Broadcast `alarm_images` on change, and contribute it to the connect replay
- Distinguish IDLE (`transfers: []`) from "we cannot say" (fetch failed)

## Transfer history — why this module keeps state at all

Peter, 2026-07-31: *"no previus failed/ succeeded tests. basically it looks the
same as it did 12 hours ago"*.

pac-host's `/progress` describes only what is **in flight**. The instant a
transfer ends — saved or abandoned — it vanishes from that endpoint and there is
no route that returns past attempts (probed `/list`, `/history` and
`/images/history` — all 400/502; `/stored` lists *images*, not *attempts*).

So a transfer seen in one poll and absent from the next has **ended**, and if
this module does not record that, nothing does. `_recordEndings()` captures the
last-seen counters and records three states:

- `complete` — this attempt received every chunk of its own manifest
- `partial` — it did not, but the image is in `/stored` from an earlier transfer
- `ended` — it did not, and we do not hold the image

**None of them is a diagnosis.** This module does not know or claim *why* a
transfer stopped, and must never grow a "failed"/"stalled"/"timed out" verdict —
those are judgements about a radio link this side cannot see.

### Keyed by `pid + startedAt`, and that is load-bearing

pac-host **auto-adopts any push it sees**, so a second transfer of the same pid
can begin seconds after the first one succeeds. Keying in-flight transfers by
`pid` alone let the newcomer occupy the completed transfer's slot: the real
ending was never recorded, and the row that eventually appeared carried the
*re-pull's* numbers.

Measured 2026-07-31, and this is exactly what Peter saw:

```
09:52:59Z  pid 18137 completes 11/11, 1 repair, 10 dupes, saved 2466 B
09:53:00Z  pac-host auto-adopts pid 18137 again — one second later
09:58:07Z  that second attempt EXFERs at 3/0 chunks
page showed: "saved · 3 chunks, total unknown · 0 repairs · 0 dupes"
```

Peter: *"the transfer succeeded, BUT: … it says total unknown"*. Fixed by
keying on `pid + startedAt`; verified by reproducing the whole scenario
(captured pid 35560, pushed it) and confirming the row reads
`complete · 11 / 11 chunks · 0 repairs · 11 dupes`.

**`outcome` must never be derived from the store alone.** The old code set
`saved` from "is this pid in `/stored`", which was true because an *earlier*
attempt delivered it — so an aborted 3-chunk re-pull reported success.
"This attempt succeeded" and "the bytes exist" are different facts.

> services hit the identical bug from their side, independently, and filed it as
> their B109: their per-pid stats sidecar is overwritten by a later attempt on
> the same pid, so `pid43238.stats.json` claims `outcome: ENOIMG, chunks: 0`
> for a transfer that completed 12/12. Same shape, same cause. Passed to them
> with our fix (xsession #60). **When their history endpoint lands it becomes
> the authority and this drops to a fallback.**

Bounded to `HISTORY_MAX` (12) per unit, in memory. **Restart-lossy, and the page
says so** (`history_note`): a process restart empties it, and attempts made
while node-dash was down were never observable. Stating that beats implying a
complete record.

## What the device is holding — NOT a list

`GET /images/<t>` returns a **single descriptor**, not a catalogue: the device
holds one payload and a new publish replaces it. Measured 2026-07-31 against the
bench unit — `{"pid":35560,"state":3,"chunks":11,"crc":…,"ready":true}` in 4.30 s.
services confirmed independently: *"a one-item dropdown would imply a catalogue
exists and none does."*

So the page renders one line — *"device is holding pid N, not yet downloaded
[Download]"* — and that line reports `already downloaded` instead when the pid is
in `/stored`.

Separately, the **dropdown** lists everything *services* holds, which is what
Peter actually asked for: *"a drop down listing the images that the services says
are available"*. I first read "available" as "on the device", measured the
single-descriptor route, and built a view-only strip instead — then put that
misreading to services, whose agreement confirmed nothing because the framing was
mine.

`_device[num]` is populated ONLY by a user-initiated check (`setDeviceImage`).
There is no poller and there must not be one — see `alarm-image-api.md`.
`checked_text` always states when the check happened, because the device can
publish a new payload immediately afterwards and this is never live.

## Stored images

`/stored` rows are shaped into `images[]`, newest first, each carrying a
server-built `url` pointing at `alarm-image-api.js`.

- **`key` is `pid-savedAt`, never `pid`.** A pid is a uint16 and recycles;
  `!987ab80f` currently lists 7 images under 3 distinct pids, with pid 1
  appearing five times. A duplicate `x-for` key is what froze the message feed
  in `message-flow-audit`.
- **`url` is ID-ADDRESSED** (`/alarm/image/<num>/by-id/<id>`), falling back to
  the pid form only for a row with no id. Every stored row is therefore
  reachable. Before this, four of GARG's seven were greyed out as `superseded`,
  because `GET /images/<t>/<pid>` returns only the newest row for a pid.
- **`on_device`** says whether the DEVICE still holds that pid — the only row an
  over-the-air re-pull can satisfy, since it keeps one payload at a time. Every
  other answers `ENOIMG`, so `fetch_text` says *"not on the device any more —
  view only"* rather than offering a button that cannot work.
- **`saved_*`, never `captured_*`.** `savedAt` is when *we* stored the bytes,
  not when the shutter fired. It is epoch **milliseconds** and `fmtAgo`/
  `fmtStamp` take **seconds** — `msToSec` exists for exactly that divide.
- **`images: []` is a real answer** (`images_empty_text`): that unit has sent
  nothing. `!18a01fc4` was genuinely empty when this shipped, and it must not
  render as an error.

### pid 1 is the device's embedded test image — and this is firmware, not a guess

```
main.cpp:489             TEST_IMAGE_PID = 1
include/test_image.h:22  TEST_IMAGE_LEN = 7156
main.cpp:521             camPidFromCrc() excludes 0 and TEST_IMAGE_PID
```

pid 1 is **reserved**; a real capture can never be assigned it. Rows matching
`pid === 1 && bytes === 7156` are labelled `device test image, not a capture`.

**This label was written, removed, and restored, and the removal is the lesson.**
It was removed on 2026-07-31 because the image "decodes to a real photograph of
buildings and sky" — which it does. It is a real photograph *used as embedded
test data*. Appearance was never the test, reasoning from it produced the wrong
answer, and it led to contradicting services who were right. The firmware was
readable the whole time. See `device-capabilities-live-in-firmware-not-docs`.

## Dependencies

- `ws-relay.js` — `registerWsWiring`, `registerConnectReplay` (host services only)
- `pac-host.js` — the plugin's own boundary module
- `format.js` — `fmtAgo`, `fmtStamp`, `fmtUptime`, `fmtCount`

## Public interface

Self-registers on import. Exports exactly one function, for its sibling plugin
module only:

```js
export function isStoredPid(num, pid)   // → boolean — in the last /stored poll
export function isDevicePid(num, pid)   // → boolean — the pid the DEVICE reported holding
export function setDeviceImage(num, info)  // record a user-initiated device check
```

The allowlist `alarm-image-api.js` gates every byte fetch on. **Core must never
call this** — it exists because asking pac-host for an unstored pid does not
404, it hangs (>45 s measured).

## State

- `_byNum` — node num → display-ready unit model. Rebuilt each poll; broadcast
  only when it differs from the previous poll (`JSON.stringify` compare).
- `_stored` — node num → `Set` of stored pids. Backs `isStoredPid`.
- `_history` — node num → ended attempts, newest first, capped at `HISTORY_MAX`.
- `_live` — node num → pid → last raw transfer seen. Diffed each poll to detect
  a transfer that has ended.
- `_timer` — the 2 s interval. Guarded so repeated wiring cannot start two.
- `_broadcast` — captured from the wiring callback.

## Message shape

```js
{ type: 'alarm_images',
  units: { "<num>": {
    id, label, state, idle_text,
    transfers: [ … ],          // in flight now
    images:    [ … ],          // stored on disk, newest first
    images_empty_text,         // set only when images is empty
    history:   [ … ],          // attempts that ended, newest first
    history_note,              // the restart-lossy caveat, verbatim
  } } }
```

`state` is `'idle'` or `'running'`. Each **transfer** carries `pid`,
`chunks_text`, `percent_text`, `percent`, `counts_text`, `cursor_text`,
`started_text`, `last_rx_text`, `aborted`. Each **image** carries `key`, `pid`,
`url`, `size_text`, `saved_text`, `saved_stamp`, `addressable`. Each **history**
row carries `key`, `pid`, `outcome`, `outcome_text`, `chunks_text`,
`counts_text`, `ended_text`, `ended_stamp`, `duration_text`.

## Invariants

- **Core must never import, name or branch on this module.** The only permitted
  reference is `index.js`'s single import.
- **The import must be STATIC and top-level**, above `attachWsRelay`. See
  `alarm-ws.md` Test notes — a dynamic import measured 0 live broadcasts in 110 s
  while the connect replay still worked, which is invisible from the UI.
- **`transfers: []` MEANS IDLE.** 200 and nothing in flight — not an error, not
  unknown. A fetch failure keeps the last-known model instead of blanking, because
  a blank reads as "idle", which is a different and wrong statement.
- **`count` is null until the MANIFEST arrives, and `percent` is null whenever
  `count` is.** Never substitute 0, never derive a percentage from one. Renders
  `"6 chunks, total unknown"`, never `"6 / 0"` and never `"100%"`. Measured
  2026-07-30: on pid 17602 the manifest did not arrive until chunk 6 of 12, so the
  null-count window is half the transfer, not an instant.
- **Every displayed string is computed here**, including relative times. The
  browser must not tick them locally (BROWSER_CONTRACT).
- **No verdicts.** `last_rx_text` is a formatted elapsed time. Whether a gap means
  the transfer has stalled is a judgement, and nothing here publishes one.
- **Never "your transfer".** auto-adopt starts a transfer for any pid seen pushed,
  so a row is not necessarily one anybody requested.
- The unit label carries the id (`"BNCH !8cee336b"`) because short names are not
  unique — one firmware image flashed to two boards, same root cause as the PKI
  failure. `id` is unique and stable.

## The pac-host key defect — why the poller looks over-cautious

Until services' commit `e7e8492` (2026-07-30) `images.progress(node)` filtered by
**raw string equality** against whatever string reached `_startTransfer`, and that
string differed by origin: a *requested* pull stored the caller's path segment
verbatim (`336b`), an *adopted* push stored the gateway's sender id
(`!8cee336b`). Same unit, two keys, decided by whoever started the transfer.

**Measured consequence, 2026-07-30 20:54:41Z–20:58:41Z.** pid 17602 ran
1/12 → 12/12 and saved a 2696-byte JPEG. Across that entire window this module
polled `/progress/!8cee336b`, received `{"transfers":[]}` on every one of ~90
polls, and broadcast **zero** live `alarm_images`. The Camera page displayed
`no transfer in flight` throughout a complete, successful image download.

services fixed it at both ends with a canonical resolver; `!8cee336b`, `8cee336b`
and `336b` now all resolve to the same transfer, and each row carries a canonical
`unit` beside the verbatim `node`. **This module deliberately still polls the full
`!hexid`** — services confirmed no client change was needed, and pattern-matching
around a server-side defect would have broken the moment they fixed it.

## Test notes

**Live progress proven end to end, 2026-07-30 22:14:53–22:15:52** (pid 50108, the
first transfer after `e7e8492` landed). ~20 consecutive live broadcasts, not a
replay:

| time | pushed |
|---|---|
| 22:14:53 | `running`, `0 chunks, total unknown`, `percent: null` |
| 22:15:28 | `0 / 12 chunks`, `0%` — manifest lands |
| 22:15:34 | `1 / 12 chunks`, `8%` |
| 22:15:52 | `5 / 12 chunks`, `42%`, `4 dupes` |

`started_text` ticked 36s → 1m 4s across the run. Screenshots 20 s apart with no
interaction show the card advancing `0 / 12 · 0%` → `6 / 12 · 50%`. **This closes
the interval-fires verification that `CAMERA_PAGE_SPEC.md` §8.2 required and that
was previously unproven** — the same failure mode that bit `alarm-ws.js`.

**Plugin-absent test.** With all three `alarm-*` imports unwired: zero
`alarm_images`, zero `pac_host_*`, core WS set intact.

**Idle rendering.** `transfers: []` renders `IDLE` / "no transfer in flight",
verified against all three units.

## Out of scope

- The image bytes themselves. This module reports **progress only**. Serving a
  stored image is `GET /v1/mesh/images/<t>/stored` plus `/<t>/<pid>`, which
  services shipped in `160a4a1` on 2026-07-30 and which is a separate task.
- `POST /nodes/:num/pac-command` — Take photo reuses `pac-command-api.js`.
- Anything about why a transfer fails. Chunk duplication (~1 dupe per chunk on
  every completed transfer measured) is raised with services as xsession #47.
