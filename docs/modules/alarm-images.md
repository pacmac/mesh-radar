---
module: alarm-images
source: src/alarm-images.js
source_hash: 609dee5264a23fb4b090c72548720425b5fdb7b3319558e55b7b95b9e13c9e9d
updated: 2026-07-30
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

- Poll `GET /v1/mesh/images/<unit>/progress` for every pac-host unit every 2 s
- Shape each transfer into display-ready strings (chunk counts, percentage,
  elapsed times) — the browser formats nothing
- Broadcast `alarm_images` on change, and contribute it to the connect replay
- Distinguish IDLE (`transfers: []`) from "we cannot say" (fetch failed)

## Dependencies

- `ws-relay.js` — `registerWsWiring`, `registerConnectReplay` (host services only)
- `pac-host.js` — the plugin's own boundary module
- `format.js` — `fmtAgo`, `fmtUptime`, `fmtCount`

## Public interface

None. Self-registers on import, exports nothing.

## State

- `_byNum` — node num → display-ready unit model. Rebuilt each poll; broadcast
  only when it differs from the previous poll (`JSON.stringify` compare).
- `_timer` — the 2 s interval. Guarded so repeated wiring cannot start two.
- `_broadcast` — captured from the wiring callback.

## Message shape

```js
{ type: 'alarm_images',
  units: { "<num>": { id, label, state, idle_text, transfers: [ … ] } } }
```

`state` is `'idle'` or `'running'`. Each transfer carries `pid`, `chunks_text`,
`percent_text`, `percent`, `counts_text`, `cursor_text`, `started_text`,
`last_rx_text`, `aborted`.

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
