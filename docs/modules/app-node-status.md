---
module: app-node-status
source: public/app-node-status.js
source_hash: 4c10db314ae35d6713a82d95304380327e9fe5023a6e4cb66d7b8b34fe295a8a
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
- A 260 node shows alarm_config/diagnostics; a plain node shows neither
- Unknown node → "No record of this node", no throw
- Zero console errors across several live update cycles
- Scroll to bottom reaches the last section

## Out of scope

- Building the payload — `src/node-status.js`
- Favourites (a pinned node's own left-menu item) — separate task; the page is
  reachable from the modal for every node regardless
- The 260 config EDITOR — read-only value_grid here; the editor is OpManager +
  a new MeshRunner
