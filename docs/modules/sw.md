---
module: sw
source: public/sw.js
source_hash: e23ed75ceab4e084e5351215b0763938faf09bd5c65f450b897c933f43b8f377
updated: 2026-07-08
---

# Module: sw

## Purpose

Service worker that caches the app shell so the dashboard loads even when the
backend is briefly unreachable. API calls go cross-origin (mesh-gw on :8001)
so the SW never intercepts them.

## Behaviour

- **Cache name:** `CACHE` (`mesh-gw-dash-vN`, currently `v4`). Bumping the version invalidates
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
  clients.** `v1` → `v2` cleared the original frozen caches; **`v2` → `v3`**
  (task `sw-cache-bump-shell`, 2026-07-09) invalidates the stale `index.html`
  shell after the lazy-tabs change (`46649b7`). **Lesson: the navigation `put`
  self-heal is NOT sufficient when a shell change must land atomically with JS
  module changes** — a client on the old cached shell + new modules (or vice
  versa) is a broken *mix* (lazy-tabs split the perf mount/teardown across
  `index.html` + `app-nav` + `app-perf`, so a partial update showed "perf: no
  data"). Any `index.html` edit that pairs with module changes MUST bump `CACHE`.
- **`v3` → `v4`** (`browser-page-playwright-audit`, 2026-07-23) atomically
  delivers the local Alpine/Chart/Tailwind assets, route migration, and mobile
  shell changes.

## Test notes

- `curl /sw.js` shows the current `CACHE` version and the navigation `put`.
- New SW installs (byte-changed `sw.js`), `activate` purges the old cache, and
  a fresh navigation re-caches `'/'` with the current asset set.

## Out of scope

- Caching of `app-*.js` mixin modules and partials — served fresh from network
  (browser HTTP cache with `max-age=0` + ETag revalidation).
- API/WS traffic — cross-origin, never intercepted.
