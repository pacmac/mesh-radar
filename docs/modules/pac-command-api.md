---
module: pac-command-api
source: src/pac-command-api.js
source_hash: 606d5340dd4b415e37db920a877ed27517af0e2ac03316630abf24d3643e0a6b
updated: 2026-07-25
---

# Module: pac-command-api

## Purpose

HTTP surface for commanding a pac-host unit — the command-channel counterpart
to `messages-api.js`'s chat send, routed through pac-host's queue instead of
a direct mesh-gw send. Owns request/response shape only; carries zero
knowledge of pac-host's URL, verbs, or mesh mechanics — that all lives in
`pac-host.js` (see docs/modules/pac-host.md).

## Responsibilities

- Resolve a node num to pac-host's `!hex` unit id and forward the command
  verb/args untouched.
- Map `pac-host.js`'s thrown errors (status + message) onto the HTTP
  response — no interpretation of what a verb means or whether it succeeded.

## Dependencies

- `pac-host.js` — `queueCommand`, `getQueue`.
- `utils.js` — `numToNodeId`.

## Public interface

```js
export default router   // Express router, mounted at app root (src/index.js)
```

### `POST /nodes/:num/pac-command`

Body: `{ verb: string, args?: any }`. `verb`/`args` pass through to
`queueCommand()` unchanged — no validation beyond "verb is a non-empty
string" (pac-host owns verb semantics). Response: pac-host's raw queue-entry
JSON (`{id, unit, verb, args, status, ...}`), passed straight through.

`400` — missing/invalid `num` or empty `verb`. Any other non-2xx is
pac-host's own status code, forwarded as-is (`502` if pac-host threw without
a status, e.g. connection refused) — includes `504` (unit asleep/out of
range, not a node-dash fault) and `503` (pac-host's mesh module down).

### `GET /nodes/:num/pac-command`

No body. Resolves `:num` the same way, returns that unit's full queue ledger
(array) from `getQueue()` — the receipt-polling primitive for a command sent
via the POST route above. Same error-passthrough behavior.

## State

_N/A — stateless request/response._

## Invariants

- Never talks to pac-host directly — every call goes through `pac-host.js`.
- Never validates or interprets a verb — GARG-specific confirmation (if a
  caller wants one) is a Domain-2 concern, enforced in the browser before
  this route is ever called, not here.

## Test notes

- Verified live 2026-07-25 against the real running pac-host service and the
  real bench unit (`!8cee336b`/BNCH): `POST {verb:"status"}` returned a real
  queued entry (`id`, `status:"pending"`); `GET` on the same node returned
  the full ledger including that entry and prior history from other
  sessions. Did not test against GARG (`!987ab80f`) — live production unit,
  per standing xsession safety rule.

## Out of scope

- Any UI (device picker, shortcuts, confirmation gating) — Domain 2, separate
  task per the two-domain rule.
- SSE-based receipts (`mesh.reply`) — this route polls the REST ledger only.
