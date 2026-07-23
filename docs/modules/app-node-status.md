---
module: app-node-status
source: public/app-node-status.js
source_hash: d2e1088553d9b199a3fd2871e3e39e64219b62fd10619510ada74af4bdf3aefc
updated: 2026-07-18
---

# Module: app-node-status

## Purpose

Node focus page (Domain 2). Renders an ordered list of server-supplied sections
for ANY node in the mesh. Presentation only.

Mandatory reading: `docs/BROWSER_CONTRACT.md`.

## Responsibilities

- Request `node_status` over the WS RPC and hold the reply for display
- Re-request on a `node_status_update` hint for the focused node
- Render three section kinds; manage Chart.js lifecycle for `series`

## Dependencies

- `app-ws.js` — `wsSend`
- `app-nav.js` — `setNav`
- Chart.js 4 (CDN, loaded in index.html)

## Public interface

```js
openNodeStatusPage(num)   // from the summary modal: close it, nav to the page
focusNode(num)            // set focus, push /node/!hexid, request
requestNodeStatus()       // WS RPC
applyNodeStatus(msg)      // reply → state + chart rebuild
onNodeStatusUpdate(num)   // hint → re-request (focused node only)
_destroyNodeCharts()      // called on tab leave by navMixin
```

## The browser decides nothing

- **No formatting.** Every value is bound from the server's `text`. There is no
  unit string, no rounding and no date math in this module or its partial.
  `BROWSER_CONTRACT.md` permits browser formatting in general, but
  `NODE_STATUS_SPEC` iron rule 1 is stricter for this page and governs.
- **No presence logic.** Sections render in the order received; nothing tests
  whether a section has content. `x-if="section.fields.length"` would be the
  browser deciding.
- **Hints carry no values.** `node_status_update` carries only `num`; the page
  re-requests, so one code path produces every displayed value.

## NOT implemented: the step title's "1s liveness tick"

A browser timer recomputing relative ages would be the browser computing a
displayed value. The server sends `ago` as text; freshness comes from
re-requesting on the hint.

## Visible time axis without date math

Chart.js `type: 'time'` needs a date adapter this app does not load, and the
perf charts' workaround (a tick callback calling `new Date(...)`) is browser-side
date formatting — forbidden here. So the x axis is `type: 'linear'` with tick
labels suppressed, and the axis range is printed beneath the chart from the
server's pre-formatted `t_min_text` / `t_max_text`. Tooltip titles are blanked
for the same reason.

## Chart lifecycle

`Chart.getChart(el)?.destroy()` immediately before each `new Chart(el)` — NOT
only the tracked instances. Live hints arrive ~1 s apart, so two
`applyNodeStatus` calls can each queue a `$nextTick` render; both destroys run
before either render and the second would hit a canvas the first claimed
("Canvas is already in use", observed 2026-07-18). `Chart.getChart` is the
authority on what currently owns a canvas.

`navMixin.setNav` calls `_destroyNodeCharts()` on leaving the tab, mirroring
`destroyPerfCharts` — lazy-mounted `x-if` tabs leak canvases otherwise.

## Layout

The partial root is `flex-1 min-h-0 overflow-y-auto`. The parent is a flex
column with `overflow-hidden`; without `min-h-0` the content is CLIPPED rather
than scrolled and the lower sections become unreachable (observed 2026-07-18:
`Position` at y=978 inside a 428 px container).

## Test notes

- `/node/!hexid` deep link loads the node directly and survives reload
- Reconnect re-requests (`app-ws.js` onopen) — a deep link may beat the socket
- Unknown node → "No record of this node", no throw
- Zero console errors across several live update cycles
- Scroll to bottom reaches the last section

## Out of scope

- Building the payload — `src/node-status.js`
- Favourites (a pinned node's own left-menu item) — separate task; the page is
  reachable from the modal for every node regardless

## Chart lifecycle (revised — backlog #7)

Three rules, each learned from a bug observed on 2026-07-18:

1. **Chart instances live at module scope, never on `this`.** Anything on an
   Alpine data property is wrapped in a reactive Proxy; Chart.js walks its own
   internals during `update()` and through a Proxy that recurses until
   "Maximum call stack size exceeded", or corrupts scale config
   ("Cannot set properties of undefined (setting 'fullSize')").
2. **Update in place; never destroy on refresh.** An active node hints ~1/sec,
   so destroying and rebuilding tore charts down mid-animation and Chart.js drew
   to a dead context ("Cannot read properties of null (reading 'save')") — the
   reason the charts appeared blank. Assign `chart.data.datasets`, then
   `update('none')`. `animation: false` closes the window entirely. Destroy only
   on tab leave, or when the set of section ids changes.
3. **Recolour on theme change via MutationObserver.** Chart.js bakes option
   colours at draw time, so a chart built in one theme renders invisible text
   after a switch. The data path alone is not enough — a quiet node may never
   send another update.

## Style (STYLE_GUIDE.md)

Every text element maps to a §3 role; the header vitals take the **display
value** role (`text-2xl font-mono font-bold tabular-nums`) because on a page
answering *what is this node doing right now*, the now-values are the headline
metric. No `px` sizes (§2), no raw colours in the partial (§4) — series colours
come from `themeColor()`, chart grid/ticks from the theme's own `--bc`.

`value_grid` columns are **bounded** (`minmax(15rem,22rem)`): unbounded
`1fr` columns stretch at desktop width and fling each key away from its value.
