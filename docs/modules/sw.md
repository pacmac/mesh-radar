---
module: sw
source: public/sw.js
source_hash: c0b3be6d6abb8ea93516d4f3d4fe44873b510c5ddcb50d050fe97f4e1e4c6921
updated: 2026-07-08
---

# Module: sw

## Purpose

Service worker that caches the app shell so the dashboard loads even when the
backend is briefly unreachable. API calls go cross-origin (mesh-gw on :8001)
so the SW never intercepts them.

## Behaviour

- **Cache name:** `CACHE` (`mesh-gw-dash-vN`). Bumping the version invalidates
  every client's cache — the `activate` handler deletes all non-current caches.
- **Precache (`install`):** `SHELL = ['/', '/app.js', '/style.css', '/config.js']`.
  `skipWaiting()` + `clients.claim()` so a new SW takes over immediately.
- **Fetch strategy — network-first:**
  - **Navigation** (`mode === 'navigate'`): fetch from network; **on a 2xx,
    write the fresh response back to the cached `'/'`** so the shell never goes
    stale; on network failure, fall back to the cached `'/'`.
  - **SHELL assets:** fetch network-first, cache on ok, fall back to cache.
  - Everything else (app-*.js modules, partials, cross-origin CDN/API) is not
    intercepted — served straight from the network / browser HTTP cache.

## Invariants (task `sw-stale-shell-fix`, 2026-07-08)

- **The cached `'/'` MUST be refreshed on every successful navigation.** The
  original navigation handler (`fetch().catch(() => caches.match('/'))`) never
  wrote the fresh `'/'` back, so the cached shell was frozen at install time —
  after an Alpine version change the cache still referenced the old Alpine, and
  any network blip served that stale `index.html`, wedging the page. The handler
  now `caches.put('/', res.clone())` on a 2xx.
- **Bump `CACHE` whenever shell assets change in a way that must invalidate old
  clients.** It was `v1` across many `index.html`/asset edits; `v2` clears the
  frozen caches. Future asset edits self-heal via the navigation put, so routine
  bumps are no longer strictly required — bump only to force a hard purge.

## Test notes

- `curl /sw.js` shows the current `CACHE` version and the navigation `put`.
- New SW installs (byte-changed `sw.js`), `activate` purges the old cache, and
  a fresh navigation re-caches `'/'` with the current asset set.

## Out of scope

- Caching of `app-*.js` mixin modules and partials — served fresh from network
  (browser HTTP cache with `max-age=0` + ETag revalidation).
- API/WS traffic — cross-origin, never intercepted.
