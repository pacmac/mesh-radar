---
module: geocode
source: src/geocode.js
source_hash: cd3161f53121a154cb46b27619b3e275a5a1ae34f93fa42831c0562732ea4d09
updated: 2026-06-30
---

# Module: geocode

## Purpose

Queued Nominatim reverse-geocode with SQLite cache. Extracted from `index.js`.
Exposes a single Express route handler for `GET /geocode?num=` and enforces a
server-side 1.1s inter-request delay to respect Nominatim usage policy.

## Responsibilities

- Serve `GET /geocode?num=` — return cached or freshly fetched address string
- Maintain a serial promise queue (`_geocodeQueue`) to enforce 1.1s between Nominatim requests
- Cache results in SQLite via `setCachedGeocode` after successful fetch
- Fetch node position from SQLite (`stmts.getNodePos`) to build the Nominatim URL
- Parse Nominatim `jsonv2` response into a human-readable address string
- Fall back to `lat,lon` string on fetch error or empty result

## Dependencies

- `db.js` — `getCachedGeocode`, `setCachedGeocode`, `stmts.getNodePos`

## Public interface

```js
export default router  // Express Router with GET / — mounted at /geocode by index.js
```

Or alternatively, a single route handler exported and registered directly in index.js.
(Exact shape TBD during implementation.)

## State

```js
_geocodeQueue = Promise.resolve()  // serial queue — chained for 1.1s pacing
```

## Events emitted

_N/A_

## Invariants

- `num=0` or missing → `{ address: null }` immediately (no queue entry).
- Cache hit → immediate return, no queue entry, no Nominatim call.
- Node has no lat/lon → `{ address: null }` immediately.
- Queue serialises all cache-miss requests; a slow Nominatim response delays subsequent requests.
- On Nominatim error: falls back to `"lat.toFixed(4),lon.toFixed(4)"` string; still cached.
- Address assembly priority: `[road, place, postcode, county, country]`, deduped; falls back to first 3 parts of `display_name`; falls back to coordinate string.
- User-Agent header: `'node-dash/1.0'`. Accept-Language: `'en'`.

## Test notes

- **Cache hit**: no Nominatim call; immediate response.
- **num=0**: `{ address: null }`.
- **No position**: `{ address: null }`.
- **Nominatim error**: `{ address: 'lat,lon' }` (coordinate fallback).
- **Queue serialisation**: two concurrent requests fire Nominatim ≥1.1s apart.

## Out of scope

- Forward geocoding.
- Geocode invalidation — cache entries persist until DB is cleared.
