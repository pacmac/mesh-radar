---
module: alarm-image-api
source: src/alarm-image-api.js
source_hash: ad933879713e32aeef05231dfb79e6a49e06114c2838c6be1907247c924c9f50
updated: 2026-07-31
---

# Module: alarm-image-api

## Purpose

**ALARM PLUGIN — not core.** Serves the *bytes* of an image pac-host already
holds on disk, so the Camera page can put one in an `<img src>`. Delete this
file and its one mount line in `index.js` and node-dash is unchanged.

Peter, 2026-07-30: *"well the camera page shows nothing at all"*. Live progress
shipped in `44e9ca5`, but the Image card was still a placeholder. Real garage
photos have been on disk since 2026-07-23 — this is what makes them visible.

## Why a route exists at all, when the queue deliberately has none

`pac-command-api.js` carries an explicit note that it has **no GET route**,
because queue/receipt data is *page data* and page data arrives over the WS
(BROWSER_CONTRACT). That rule is not being bent here, because image bytes are
not page data.

The distinction is the one the core guard already makes. `src/index.js`'s
WS-only guard keys on `Sec-Fetch-Dest: empty`, which a browser sets on `fetch()`
and cannot forge. An `<img src>` sends `Sec-Fetch-Dest: image`. A JPEG is a
binary asset — the same category as a font or an icon, both of which node-dash
already serves over HTTP — and there is no mechanism by which a WS text frame
can be the `src` of an image without base64-inflating it through the page-data
channel.

**The list of images is page data and goes over the WS** (`alarm_images`, see
`alarm-images.md`). Only the bytes come from here, and only for a pid the server
has already published in that list.

## Responsibilities

- Serve `GET /alarm/image/:num/:pid` as `image/jpeg` from pac-host's local store
- **Refuse any pid the server has not itself published** in the current
  `alarm_images` payload
- Bound every upstream call with an abort timeout so no request can hang

## Dependencies

- `alarm-images.js` — `isStoredPid(num, pid)`, the allowlist (plugin-internal)
- `pac-host.js` — `getImageBytes(unit, pid)`
- `utils.js` — `numToNodeId`

## Public interface

```js
export default router   // GET /alarm/image/:num/:pid
```

| response | when |
|---|---|
| `200 image/jpeg` | pid is in the last-polled stored list and pac-host returned bytes |
| `400` | `num` or `pid` not an integer |
| `404` | pid is not in the last-polled stored list for that unit |
| `502` | pac-host errored |
| `504` | the upstream call exceeded `FETCH_TIMEOUT_MS` |

`Cache-Control: private, max-age=300` — the bytes for a given `(unit, pid)` are
immutable while that pid is stored, and re-fetching a 2.7 kB JPEG on every
re-render is waste. Not `immutable`: pid recycling means the same URL can later
mean a different picture (see below).

## Invariants

- **NEVER blind-proxy a browser-supplied pid.** This is the whole reason the
  allowlist exists, and it is not a theoretical concern — see Test notes for the
  measurement.
- **`?refresh=1` is never sent, and never reachable from a page.** It forces
  pac-host's radio path: minutes, and it costs the device a wake window. This
  route hard-codes the plain form and takes no query parameters at all.
- **Every upstream call carries an `AbortController` timeout.** The allowlist
  closes the common case; the timeout closes the race where a pid is evicted
  between the poll that published it and the request that asks for it.
- Core must never import or name this module. The only permitted reference is
  the single mount line in `index.js`.
- This route serves bytes only. It never returns a list, and never becomes the
  transport for anything the WS should be pushing.

## The hazard this module is shaped around

Measured 2026-07-31 05:02Z, against the running pac-host:

| request | result |
|---|---|
| pid 50108, 45886, 60780, 1 (all stored) | `200`, 1.4–14 ms, logged `served from store — no radio` |
| pid 99999 (above uint16) | `400` in 1.3 ms |
| pid `abc` | `400` in 3.5 ms |
| pid 0 | `502` after **3.46 s** — reached the device, logged `ENOIMG` |
| **pid 12345 — valid uint16, not stored** | **no response in 45 s**, killed by the client |

The 12345 request produced **no `[images]` log line at all**, while every store
hit logs one. It did not take the store path.

*Not* established: what it did on air. A butler push appears in the log 45 s
later, but a routine stat poll runs on that cadence, so causation is not shown
and is not claimed — raised with services rather than guessed.

The design consequence stands either way: a stale page holding an evicted pid
must not be able to hang a connection for minutes.

## pid recycling — why the URL is not a permanent identity

services, on shipping the store read: a pid is a **uint16 and recycles**, so a
cached pid is not guaranteed to be what the device holds under that pid now.
They serve from disk by default deliberately — the alternative was a four-minute
radio pull to render a thumbnail.

Two consequences this module lives with:

1. `Cache-Control` is bounded (`max-age=300`), never `immutable`.
2. **A pid is not unique within one unit's stored list.** `!987ab80f` currently
   lists 7 images under **3 distinct pids** — pid 1 appears five times,
   separated only by `savedAt`. `GET /images/<t>/1` returns exactly one of them
   (the newest — verified: pac-host logs `saved 2026-07-23T19:41:55.953Z`, and
   two consecutive fetches returned an identical sha256). So four of those seven
   rows are **listable but not individually addressable**.

That is a property of the upstream contract, not something this module can fix.
`alarm-images.js` marks the unaddressable rows so the page can say so rather
than serving the wrong picture under the right label.

## Test notes

Measured 2026-07-31 against the running service, through node-dash on :8000:

| request | result |
|---|---|
| `/alarm/image/2558179343/45886` (stored) | **200** `image/jpeg`, 13.5 ms, 8257 B — decodes as JPEG 320×240 |
| `/alarm/image/2364420971/12345` (valid uint16, NOT stored) | **404 in 5.5 ms** |
| `/alarm/image/2364420971/abc` | **400 in 1.5 ms** |

The middle row is the one that matters: the same pid asked of pac-host directly
does not answer in 45 s. Through this route it is refused in 5.5 ms, which is
the allowlist doing its job.

Rendered end to end in a real browser at 1600×1000, both themes, 0 console
errors: GARG's 7 stored images render as a large view plus a thumbnail strip,
the 4 rows sharing pid 1 with a newer row show as `superseded` and are
non-clickable, and selecting a thumbnail swaps the large view.

## Out of scope

- The image *list* — `alarm-images.js` owns it and pushes it over the WS.
- Transfer progress — same module, already shipped.
- Deleting or managing stored images. node-dash does not own that store.
- `?refresh=1` / re-capture. Taking a new photo is the existing `cam` verb
  through `pac-command-api.js`.
