---
module: terrain
source:
  - src/terrain.js
  - src/terrain-api.js
source_hash: 58bb4531ccc5438208e7cce12baf664a634c18336ee9ce91606bdc7f70340f88
updated: 2026-08-05
---

# Module: terrain

Peter, 2026-08-05:

> what I am looking at is the terrain, i.e the hills and valleys that surround me

> I can already see by looking at the node distribution that we have walls / dead
> zones, my gut feeling is these will most likely correlate with terrain

Not a derived horizon line — the **relief itself**, sampled as a polar grid
centred on home so the shape of the ground and the distribution of nodes can be
read together.

## Why this site needs it

A coarse 12-bearing probe measured the line-of-sight horizon from our 35 m
antenna at **0–5 km in every direction except due east (20 km)**. We are in a
bowl. Every link we hold — including a 42.9 km *direct* contact — is a
diffraction path over a ridge. That is the most important physical fact about
this site and nothing in the dashboard showed it.

It also makes the dead-zone question answerable without circular reasoning. An
earlier attempt correlated our own node observations against each other and found
nothing (r = −0.09), because the denominator was "nodes we know about" and we
mostly know about them *because we heard them*. A terrain grid derived purely from
elevation data has no such dependency.

## Model

```
terrain_grid(bearing_deg, km, elev_m)          PRIMARY KEY (bearing_deg, km)
terrain_meta(home_lat, home_lon, home_alt, bearings, max_km, rings, source,
             sampled_at, points)
```

Defaults: **180 bearings** (every 2°), **60 km**, **45 rings**, `srtm30m`.
8,100 points, sampled in 104 s.

**Radii are quadratic, not linear.** The near field decides whether we get out at
all — a 200 m knoll at 1 km blocks more than a 300 m hill at 30 km — so linear
spacing would put most samples where they matter least.

**60 km** because beyond that terrain stops mattering at our antenna height.

## Staleness is explicit

Terrain does not move; the **origin** does. `home.lat/lon` and the antenna height
were wiped and restored on 2026-08-05, and a grid computed from a position 450 m
away would look entirely plausible and be wrong. `isStale()` compares the stored
origin and grid shape against current config, so a stale grid is detectable rather
than silently trusted.

## Sampling is never automatic

`sample()` is a POST and is **not** run at boot. It calls a third-party elevation
service, and a process restart must not decide by itself to go and do that. Rate
limited to 1 request/1.1 s against opentopodata's published 1/sec, 100 points per
request.

## API

| route | purpose |
|---|---|
| ~~`GET /terrain/visibility`~~ | **DELETED 2026-08-13.** The mask the radar draws now arrives in the `radar` WS message. It was the most defensible of the three to leave — it changes only when the home position or the grid does — but BROWSER_CONTRACT names page data as WS-only without carving out slow-moving data |
| `GET /terrain` | the whole grid: `elev_m[bearing][ring]`, `radii_km`, `bearings_deg`, min/max, home |
| `GET /terrain/status` | sampling flag, staleness, meta, config |
| `POST /terrain/sample` | run the one-time sample (~90 s) |

`elev_m` is **null** where the source had no data (sea, or outside coverage) —
never zero, which would render as land.

## Limits, stated rather than discovered later

- **SRTM 30 m, bare earth.** Trees and buildings are not in it, and at 868 MHz
  they matter over the last kilometre. The real horizon is worse than this
  everywhere.
- One elevation source, no cross-check.
- 2° spacing is ~2 km of arc at 60 km; fine detail at range is not resolved.

## Measured 2026-08-05

Elevation range across the grid: **−1 m to 484 m**. Home ground 30 m.

| bearing | highest ground | at |
|---|---|---|
| 0° N | 313 m | 6.7 km |
| 150° SSE | 311 m | 10.7 km |
| **300° WNW** | **425 m** | 40.6 km |
| 270° W | 283 m | 18.5 km |
| 210° SSW | 258 m | 52.3 km |
| **90° E** | **144 m** | 45.1 km — the open direction |
| **330° NNW** | **135 m** | 13.1 km |
