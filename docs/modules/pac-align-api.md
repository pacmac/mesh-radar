---
module: pac-align-api
source: src/pac-align-api.js
source_hash: 399cc8b0e9380cd8312665c20dfff1d6d726b415e6a2bb20e733bc6d4f9cb3a5
updated: 2026-07-25
---

# Module: pac-align-api

## Purpose

HTTP surface for the Yagi Align feature's browser-originated actions —
opening/retargeting a session, ending it, and setting the persisted
reply-wait window. Task `yagi-align-rebuild`, 2026-07-25. Owns request/
response shape only; carries zero mesh knowledge — that lives entirely in
`pac-host.js` (see docs/modules/pac-host.md) and, upstream of it, pac-host's
own align module (API.md "Antenna alignment").

**POST only, deliberately — same invariant as `pac-command-api.js`.** No GET
route; the align view-model is page data and arrives over WS
(`pac_host_align`), never fetched.

## Responsibilities

- Validate the three browser-originated values this feature has (`target`,
  `n`, `replyWindowSec`) are present/well-typed, then pass them through
  unchanged to `pac-host.js`.
- Map `pac-host.js`'s thrown errors (status + message) onto the HTTP
  response — no interpretation of what they mean (e.g. a `409` means a burst
  is already active; this router does not special-case it).

## Dependencies

- `pac-host.js` — `alignPing`, `alignStop`, `alignConfig`.

## Public interface

```js
export default router   // Express router, mounted at app root (src/index.js)
```

### `POST /align/ping`

Body: `{ target: number, n?: number }`. `target` is a raw node **num**
(not a `!hex` id — align's target addressing differs from the command
surface's unit addressing; confirmed against the live API.md example). `400`
on a non-integer `target`. Response: pac-host's raw ping-accepted JSON,
passed straight through.

### `POST /align/stop`

No body. Response: pac-host's raw stop JSON, passed straight through.

### `POST /align/config`

Body: `{ replyWindowSec: number }` (5-120, pac-host-validated — this router
does not re-validate the range). Response: pac-host's raw JSON, passed
straight through.

All three: `400` on missing/malformed input; any other non-2xx is pac-host's
own status code, forwarded as-is (`502` if pac-host threw without a status).
A `409` from `/align/ping` means a burst is already active on that session —
surfaced to the browser as-is, no special handling here.

## State

_N/A — stateless request/response._

## Invariants

- Never talks to pac-host directly — every call goes through `pac-host.js`.
- Never validates or interprets the align model — Domain 2 rendering
  concerns live in `app-align.js`/`tab-control.html`.
- **No GET route, and none should be added** — same reasoning as
  `pac-command-api.js`'s Invariants: the view-model is page data, pushed by
  `pac-host.js`'s poll-and-push loop (`pac_host_align`), replayed on connect.

## Test notes

- Verified live 2026-07-25 against the real running pac-host service: a real
  `/align/ping` against BNCH (`!8cee336b`, num `2364420971`) opened/retargeted
  the already-running session, the pushed `pac_host_align` WS message showed
  `burst.active:true` moments later, and after the burst window elapsed the
  model correctly returned to `burst:null` with `warning:"No replies — try
  again."` (BNCH did not answer this burst — expected per mt-transport's own
  caveat, not a bug; see `docs/modules/app-align.md`).
- `/align/stop` and a successful (non-"no replies") reading were **not**
  exercised live in this task: the session tested against was pac-host's own
  live in-progress session (not one this task opened), and BNCH had not yet
  produced a real on-air reading (mt-transport, xsession `[align-backend]`:
  "no completed READING has been observed on air yet — neither test target
  answered"). Both paths are otherwise identical passthroughs to already-
  verified `pac-host.js` functions (`queueCommand`'s pattern), so the risk is
  low, but this is recorded as unverified rather than assumed working.

## Out of scope

- Any UI (target picker, N/reply-window controls, reading rendering) —
  Domain 2, `app-align.js`/`tab-control.html`.
- PASV interlock (forcing dash mode during an active session) — that lives
  in `pac-host.js`'s `_pollAlign()`, not this router; see its own spec.
- Signal computation of any kind — pac-host computes the entire view-model.
