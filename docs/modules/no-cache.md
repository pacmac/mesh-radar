---
module: no-cache
source:
  - src/index.js
  - public/sw.js
  - public/index.html
source_hash: f257187d9d653c0a77bff89054d8adb45f654f9cc4352d11368d9ab320c579aa
updated: 2026-08-17
---

# Module: no-cache

## Purpose

Nothing this application serves may be cached by a browser. Not assets, not
responses, not the app shell.

Peter, 2026-08-13, after a month-old cached response made a page permanently
dead: **"we need to remove all caching or add cache busters. there is no benefit
to cache in this application in fact it works against us just like in this case.
we should be browser cache free, that needs to be in the headers and response so
that NOTHING is cached."**

## What happened, because the reasoning matters more than the rule

`/devices` returned **410 Gone** in the browser while returning 200 to `curl`,
and no amount of restarting fixed it. The response headers said why:

```
date:  Thu, 16 Jul 2026 15:35:14 GMT      <- FOUR WEEKS OLD
etag:  W/"b7-h2XgXa0LvCGmEf1Cl3pB1Fyo3Zg"
(no Cache-Control at all)
```

The browser was not asking the server. It was replaying a 410 from 16 July,
stored back when the WS-only guard did not yet set `no-store`, kept alive by an
Express-generated ETag and no cache directives. Navigating to `/devices?cachebust=1`
loaded perfectly at the same instant — which is the proof.

**The cache had made a fixed server unreachable.** That is the whole argument: a
dashboard whose entire purpose is showing what is true *now* gains nothing from
caching and loses the ability to correct itself.

There is a second, sharper reason. The WS-only guard deliberately serves
**different responses for the same URL** — the SPA shell to a navigation, 410 to
a browser `fetch()`. Without a `Vary` header, every cache treats those as one
entry, so whichever arrives first poisons the other. `no-store` removes the
problem entirely; `Vary` is kept as well so the response is honest about what it
depends on even to a cache we did not anticipate.

## The four surfaces — all of them, or the exercise is pointless

| surface | before | after |
|---|---|---|
| Express ETag generation | on by default — the poisoned 410 had one | `app.set('etag', false)` |
| every response | nothing, unless a handler set it | global `no-store` middleware, first in the stack |
| `express.static` | `{ etag: true, maxAge: 0 }` | `{ etag: false, lastModified: false, cacheControl: false }` |
| the service worker | `public/sw.js` caches the shell in Cache Storage | a **kill switch**: deletes every cache and unregisters itself |

**A service worker is a cache.** No-store headers do not restrain it — it stores
what it likes in Cache Storage and can serve it forever. Leaving it in place
while claiming "browser cache free" would be false.

## Public interface

No new exports. The policy is a middleware and a static-options object in
`src/index.js`, plus a replaced `public/sw.js`.

Headers set on **every** response:

```
Cache-Control: no-store, no-cache, must-revalidate, max-age=0
Pragma: no-cache
Expires: 0
```

`no-store` alone is the modern instruction; `no-cache`, `Pragma` and `Expires`
are there for intermediaries and older stacks that mishandle it. `must-revalidate`
covers the case where something stored a copy before this shipped.

## The service-worker kill switch

Removing `register()` from `index.html` is **not sufficient** — every browser
that has already installed the worker keeps it, and it keeps intercepting. The
worker must be replaced by one that removes itself:

1. `install` → `skipWaiting()`, take over immediately.
2. `activate` → delete **every** Cache Storage key, then `registration.unregister()`,
   then `clients.claim()` and reload controlled pages.
3. **No `fetch` handler at all** — nothing is intercepted while it winds down.

The registration line goes from `public/index.html`, so new visitors never
install one; existing installs still fetch `/sw.js` on navigation, receive the
kill switch, and destroy themselves. That path is why `sw.js` must keep being
served rather than deleted.

## Invariants

- **No response may omit the no-store headers.** The middleware is registered
  before every route, including the WS-only guard and `express.static`, so a new
  route cannot opt out by being added later.
- **No ETag, no Last-Modified.** Both are conditional-caching machinery; with
  `no-store` they are pointless, and the 410 proved they are harmful.
- **`sw.js` is never re-armed.** If a future change wants offline support it
  must be argued on its merits against this document, not added back quietly.

## State

_N/A_

## Events emitted

_N/A_

## Test notes

`scripts/check_no_cache.mjs`, added to the runner's `service` group: fetches a
representative set of paths — a page navigation, a static asset, an API GET, and
the WS-only guard's 410 — and asserts that **every** response carries
`cache-control: no-store` and carries **no** `etag`. It fails on the first
response that does not, naming it.

That check is the guard against this regressing silently, which is exactly how it
arrived: the `no-store` on the 410 was added at some point and nobody noticed the
other surfaces still had none.

## Out of scope

- Evicting entries already in someone's browser. A `no-store` response cannot
  reach backwards; an existing poisoned entry clears on a hard reload
  (Ctrl+Shift+R) or when the browser evicts it. Stated here rather than left as a
  surprise: **Peter's `/devices` needs one hard reload after this ships.**
- Server-side caches (`_upsertCache`, the geocode cache, prepared statements).
  This document is about the browser.
- Cache-busting asset URLs. With `no-store` and no ETag there is nothing to bust;
  if that ever proves untrue, revisit here.
