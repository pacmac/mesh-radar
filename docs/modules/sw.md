---
module: sw
source: public/sw.js
source_hash: 133e990a50a60bbc72ab26b2936e396c3440865cc422dad8e2e67f621a8e6ca1
updated: 2026-08-13
---

# Module: sw

## Purpose

**This service worker no longer caches anything. It exists only to delete itself
and every cache it ever created.**

Retired 2026-08-13. The policy that replaced it is `docs/modules/no-cache.md`;
this file remains because the module still exists on disk and must be described
truthfully, not because there is a worker doing useful work.

## Why it was retired

Peter, 2026-08-13: *"we should be browser cache free, that needs to be in the
headers and response so that NOTHING is cached."*

The trigger was `/devices` returning 410 in the browser and 200 to `curl`, with
no restart fixing it. The browser was replaying a response dated **16 July**,
four weeks old. A cache had made a working server unreachable — on a dashboard
whose entire purpose is showing what is true now.

A service worker is a cache that response headers cannot restrain: `no-store`
governs the HTTP cache, while a worker stores what it likes in Cache Storage and
may serve it indefinitely. So the headers alone would have left the claim
"browser cache free" false.

## Behaviour

1. `install` — `skipWaiting()`, so it takes over without waiting for tabs to close.
2. `activate` — deletes **every** Cache Storage key (not just this app's; the old
   shell lived under a versioned name and older deployments left their own),
   calls `registration.unregister()`, claims clients, then navigates each
   controlled window to itself so the user lands on an uncached document.
3. **No `fetch` handler.** While winding down it intercepts nothing.

## Invariants

- **This file must keep being served.** Deleting it does not remove the worker
  from browsers that already installed it — those keep running the old one
  forever. A browser re-fetches `/sw.js` on navigation within scope, so a
  self-destructing worker is the only thing that reaches them. It may be deleted
  once no client can plausibly still hold a registration, and not before.
- **No `fetch` handler may be added back.** Any caching here is invisible to the
  server and to `scripts/check_no_cache.mjs`, which can only see headers.
- **`public/index.html` must not call `register()`.** It calls
  `getRegistrations().unregister()` instead, for a tab that holds a worker but
  never navigates.

## Test notes

`scripts/check_no_cache.mjs` asserts `/sw.js` is itself served `no-store` with no
validators. It CANNOT verify the worker's behaviour — that needs a real browser:
load the page, confirm `navigator.serviceWorker.getRegistrations()` returns empty
and `caches.keys()` is empty.

Verified 2026-08-13 in Chromium: one registration existed at scope
`http://localhost:8000/`, state `activated`, and was removed.

## Out of scope

- Offline support. It is gone deliberately. Restoring it means arguing against
  `docs/modules/no-cache.md`, not quietly adding a `fetch` handler.
- Entries already in a user's HTTP cache, which no server change can reach —
  they clear on a hard reload.
