---
module: push-viewer
source: public/push.html
source_hash: f3c2d3621b3178e2e5c800cf852479835ea372b91efe4eaad2ed1217dee7b90e
updated: 2026-07-20
---

# Module: push-viewer

## Purpose

A **standalone page** for watching a single chunk-push transfer live: progress, stall
state, and the resulting image. Its audience is Peter during a bring-up window, when
there is no gallery yet and the alternative is reading a terminal.

Deliberately standalone (`/push.html`, like `/align.html`) rather than folded into the
node tab: the real gallery is the eventual product but is frozen until mt-transport's
push receiver exists, and building it now would invite a second rewrite. This page can
be deleted the day the gallery lands, and nothing else depends on it.

**Presentation only** — `docs/BROWSER_CONTRACT.md`, referenced as that document requires.

## Data sources

| what | where from | why it is contract-clean |
|---|---|---|
| progress, stall, outcome | WS `/events` — `chunk_progress`, `chunk_done`, `chunk_error` | all page data over the WS |
| image location | `chunk_done.url` (server-computed, task `chunk-done-image-url`) | the browser never builds a path |
| the image bytes | `<img src="{url}">` → `/chunk-images/...` | an ASSET fetch, the same class as `app.js`; not page data |

No `fetch()`/`GET` for page data. The page holds only the last values it was told.

## BROWSER_CONTRACT — permitted formatting, and why no exception is claimed

Permitted by the contract's "render and format data it receives" clause:

- percentage = `received / count` rendered as a bar width — arithmetic on two
  server-supplied numbers, no decision
- elapsed seconds formatted from `elapsedMs`
- frames-per-chunk ratio displayed from counted 261 frames

**No exception is claimed, and that is a deliberate change from the first draft.**

I initially specced a client-side **stall verdict** (no 261 frame for N seconds → declare
"STALLED"). That is the browser deciding state, and the contract requires such an
exception to be approved *before* implementation. Rather than seek an exception, the page
does the contract-clean thing: it displays **"last event: N s ago"** — a formatted
elapsed time from data it was told — and renders **no verdict at all**.

The distinction is the whole point of the contract: showing *how long it has been quiet*
is formatting; declaring *that the transfer has stalled* is a judgement, and a judgement
belongs to the server, which knows the deadline and the transfer's real state.

**Follow-up raised, not silently skipped:** node-dash should emit `chunk_stalled` (it
owns `deadlineMs` and the in-flight record), after which the page renders that verdict
like any other pushed state. Until then, a long "last event" figure is visible enough to
catch a quiet death — which was the requirement — without the browser pretending to know
why.

The 261 frame counter is retained as display aggregation of events the page already
receives (counting rendered items, not deriving state). If even that is judged too far,
the server can supply the count; noted rather than assumed.

## Layout

Single column, dark/light per `prefers-color-scheme` (same inline theme switch as
`align.html`, daisyUI `business`/`corporate`).

1. **Status line** — idle / running / done / error, plus node + pid, all server-stated.
   "Last event: N s ago" sits here — a formatted figure, never a stall verdict.
2. **Progress bar** — `received / count` with a percentage; indeterminate stripe while
   `count` is `null` (before the manifest lands), because a bar that fakes a percentage
   it does not have is a lie.
3. **Facts row** — elapsed, bytes, 261 frames seen, frames/chunk ratio.
4. **Image panel** — placeholder until `chunk_done`; then `<img src="{url}">`. If
   `url` is `null` the panel says "stored — location unknown (server could not resolve
   the file)", never a guessed path.
5. **Event log** — the last ~50 raw events, newest first, so anomalies are visible
   rather than smoothed away.

## Progressive rendering — not yet, and why

Verified feasible: a truncated baseline JPEG renders its prefix in a browser (25/50/75%
all draw). But node-dash never sees a byte mid-transfer — `onProgress` carries counts
only and `PayloadStore` writes on completion. Blocked on mt-transport exposing the
contiguous prefix (channel item `[partial-render]`); when it lands, the server adds
`partUrl` to `chunk_progress` and this page points the same `<img>` at it. No rework.

**Design constraint recorded for that day:** at ~17% loss the contiguous prefix stalls at
the first gap and jumps when REPAIR fills it, so the picture can sit frozen at 30% while
`received` climbs to 90%. The image must never be the progress indicator — image for
satisfaction, numeric bar for truth.

## Invariants

- Zero decisions: no classification, no filtering, no verdicts — only the permitted
  formatting above. No contract exception is claimed.
- No page-data GET. WS only.
- Never constructs an image path — renders `chunk_done.url` or says it is unknown.
- Missing state renders as unknown, never as a guess or a zero.

## Test notes

Playwright at 1600x1000, both themes. Because a real transfer needs mt-transport's
receiver and a DEV1 window, validation drives the page with **synthetic events injected
into its own handler** — started → running (count null) → running (count known) →
done-with-url, done-with-url-null, and error — and confirms each render. That proves the rendering, and explicitly NOT
that a real push works; the harness (`push-observer`) covers the live run.

## Out of scope

- Triggering a fetch (the page is read-only; `POST /nodes/:num/chunk-fetch` is deliberate
  and manual — it puts frames on air and the bench unit is shared).
- The eventual node-tab gallery + `image_grid` section.
- Any `src/` change — none required; `chunk_done.url` already shipped (fe84ca5).
