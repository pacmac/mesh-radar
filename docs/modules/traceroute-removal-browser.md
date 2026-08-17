---
module: traceroute-removal-browser
# NOT a pure doc, deliberately. CLAUDE.md's pure_doc_rule ("source_hash = the
# SHA-256 of the doc file itself") cannot converge for a doc that names itself:
# writing the hash into the frontmatter changes the file, invalidating the hash.
# This is the only self-referencing spec in docs/modules/, so the rule had never
# been exercised. It points at the files it actually governs instead, which is
# what every other spec here does and what keeps it honest — edit any of them
# and this spec goes STALE until it is re-read.
source:
  - public/app-perf.js
  - public/app-radar.js
  - public/app-ws.js
  - public/app-nodes.js
  - public/app-components.js
  - public/feature-flags.js
  - public/partials/tab-perf.html
  - public/partials/tab-shared.html
source_hash: 38f30e722d5439691380465f4bb43f1a4684cd95781f3cc6f2029972d69389c5
updated: 2026-08-17
---

# Removal spec: every trace of traceroute in `public/`

## Purpose

Peter, 2026-08-17: *"well I want all traces of it removed, browser and backend.
it will be re-designed with no fragments remaining."*

This is the **Domain 2** half. `CLAUDE.md` forbids a fix spanning domains in one
task, so the backend half is its own task and its own spec.

This spec removes code. It designs nothing. Peter, earlier the same day: *"no
re-implementation logic will be decided until all existing calls to it are
completely removed from code. then we will decide how it will work."*

## Why the browser goes FIRST

The browser is not passive here. Measured 2026-08-17 22:58 BST:

```
curl -X POST localhost:8000/%212687afb1/traceroute -d '{"to":646426545}'
-> HTTP 200
```

`src/index.js:379` — `app.use(/^\/![0-9a-f]+/i, proxyToBridge)` — is a catch-all
that forwards any `/!hex/…` path to mesh-gw. When the backend task deleted
node-dash's own `POST /:nodeId/traceroute`, requests stopped matching it and fell
through to that proxy instead. So the two browser call sites did not become dead
buttons; they became **unmediated transmitters**: no cooldown, no
point()-before-send, no `beam_deg`, and **no row in `traceroute_history`**, so
node-dash can transmit with no record that it did.

`public/app-perf.js:90` makes it worse than a button — it is a
`setInterval` that fires the POST for every scheduled node every 5 minutes,
unattended. That is also a standing-rule violation in its own right: *"NO TIMERS,
NO POLLING FULL STOP"*.

Removing the browser half stops transmission. Everything after it is tidying.

## Decisions taken by Peter, 2026-08-17

| question | answer |
|---|---|
| does `src/traceroute.js` go? | **kept, unwired** — zero importers. The scar tissue stays readable in place |
| `traceroute_history` (37,424 rows) | **rows kept, reads dropped** — the GET, the WS feed, and the browser history panel go |

## What is removed, file by file

### `public/app-perf.js`

The whole auto-traceroute scheduler and the history store it fed.

- `perfAutoNodes`, `_perfAutoTimer`, `perfAutoIntervalMin` state
- `_perfAutoTick()` — holds the POST at line 80
- `perfAutoStart()`, `perfAutoStop()`, `perfAutoToggleNode()`
- `_trHistAll`, `perfHistory`, `perfFailureEpoch` state
- `perfHistorySlice()`, `perfSuccessRate()`, `perfSuccessRateClass()`,
  `perfTrendChange()` and the chart builders that read them
- `perfDev()`'s `hasData`/`withData` fallback, which ranks radios by how many
  traceroute rows they produced

`perfBudget()`, `perfDevCfg()`, `perfSetDevice()`, `adoptPerfLoraCfg()` and the
served `link_budget` STAY: they are radio configuration, not traceroute.

### `public/app-radar.js`

- `sendTraceroute()` — holds the POST at line 1233
- `_drawRadarTraceroute()` and its `radar-traceroute-g` layer
- `tracerouteNode` / `tracerouteActive` context fields, and the highlight and
  animation branches that read them
- `tracerouteResult`, `traceroutePending`, `tracerouteNodeName()`

### `public/app-ws.js`

- the `traceroute_history` replay handler
- the `traceroute_failed` handler
- the `route_discovered` handler
- the `!FF.SSOT_TRACEROUTE` legacy block that patched `last_traceroute` straight
  off the raw packet feed
- the second raw-packet `last_traceroute` patch

### `public/app.js`

- `tracerouteResult`, `traceroutePending` root state

### `public/app-nodes.js`, `public/app-components.js`

- `nodeHopsVerified` / `nodeHopsFresh` and the "traceroute-verified
  (fresh|stale)" badge text and colour. Nothing will write the underlying fields
  once the backend half lands, so a badge reading "verified" would be asserting a
  measurement that can no longer be taken.

### `public/feature-flags.js`

- `SSOT_TRACEROUTE` — its only consumer was the legacy raw-packet block in
  `app-ws.js`, deleted above.

**`SSOT_ROUTE_RENDER` STAYS**, corrected during implementation: this spec first
listed it for removal on the strength of its name. It is not traceroute — it
gates whether the radar builds its display context from the backend's
`radar_context` event or decides locally, and three live call sites still branch
on it (`app-radar.js:137`, `app-ws.js:601`, `app-components.js:21`). Removing it
made those read `undefined` — falsy — which would have silently dropped the radar
onto the V1 path. Caught by grepping for consumers before committing, not by a
test.

### Partials

- `tab-shared.html` — the TRACE button, its pending state and the result block
- `tab-perf.html` — the history table, success-rate card and auto-trace controls
- `tab-radar.html` — the `radar-traceroute-g` SVG layer and trace controls
- `tab-cfg.html` — the "PASV — Passive traceroute" card and the per-mode TX/RX
  text that describes which radio "transmits the traceroute"
- `tab-node.html` — the traceroute figure in the node card's example text

## What STAYS, and why

| kept | reason |
|---|---|
| `app-helpers.js` `TRACEROUTE_APP` label + packet filter | a **received** packet type. We still overhear other people's traceroutes and must name them in the packet log; that is not our dispatch |
| `app-observatory.js` traceroute wording | the Observatory is already disabled (`3b39449`) and is being kept for re-use, not deleted. Untouched here |
| `tab-observatory.html` | same |
| `link_budget` and everything that reads it | radio configuration, served by the backend, independent of traceroute |

## The consequence, stated plainly

**The Performance page loses its RF analytics.** Success rate, the history table,
the trend chart and the per-row link-budget margins were all computed from
traceroute rows. The page keeps its radio selector, antenna/chain config and the
served link budget — the theory — but it will show no measurements.

**The radar loses route rendering.** No route lines, no trace highlight, no
animation.

**PASV stops meaning anything.** The mode remains in the mode selector but its
only behaviour was passive tracing. It becomes a mode that does nothing. Naming
that is the backend task's job; this spec only stops the browser describing it.

The 37,424 stored rows are untouched and remain queryable in
`data/node-dash.db`. Nothing in the UI reads them.

## Invariants

- No `fetch`/`fetchJSON` in `public/` may reference `traceroute` after this.
- No `setInterval`/`setTimeout` may be introduced; the one removed here is not
  replaced.
- The browser decides nothing about traceroute, because there is nothing left to
  decide about.

## Test notes

1. `grep -rn "traceroute" public/ --include=*.js --include=*.html` returns only
   the kept items listed above.
2. `grep -rn "setInterval\|setTimeout" public/` — `_perfAutoTimer` is gone.
3. Load the dashboard at 1600x1000 and 1280x800, both themes. Perf, Radar, Nodes
   and Config render with no console error and no empty card whose title promises
   traceroute data.
4. Network tab shows no POST to any `/…/traceroute` path during a full page
   session including a radar node click.

## Out of scope

- `src/` — the backend half, its own task.
- `src/index.js:379`, the catch-all proxy that made this urgent. It forwards any
  unknown per-device verb to mesh-gw unexamined; traceroute was simply the one we
  found. Its own Domain 1 task.
- `src/traceroute.js` — kept by Peter's decision above.
- Deleting `traceroute_history` — rows kept by Peter's decision above.
