# Node focus charts — real x axis + window selector

Backlog #8. Peter: "why is there no x axis time line? — the chart should have a
1/4/24/72 hr button same as all of the other charts".

Names `docs/STYLE_GUIDE.md` (§8.6). Companions: `BROWSER_CONTRACT.md`,
`NODE_STATUS_SPEC.md`.

## 1. The axis has no labels — and my reason for that was wrong

Chart.js `type: 'time'` needs a date adapter this app does not load, and the
perf charts' workaround formats dates in the browser (`new Date(val).getHours()`)
— which iron rule 1 forbids for this page. I resolved that by **suppressing the
tick labels** and printing only the two endpoints underneath.

That satisfied the rule and produced an unreadable chart. Wrong trade: the rule
says the *server* computes display strings, not that there are none.

**Fix: the server sends the tick labels.** Each `series` section gains

```js
ticks: [ { t: <unix seconds>, label: "08:32" }, … ]   // ~6, evenly spaced
```

The browser positions ticks at `t` and renders `label` verbatim — a lookup of
server-supplied strings, not formatting. Iron rule 1 is satisfied *and* the axis
is readable.

New in `format.js`: `fmtAxisTick(ts, spanSec)` — the server picks the format from
the span it is rendering (`HH:MM` under a day, `DD MMM HH:MM` beyond). That is a
presentation decision, so it belongs server-side like every other one.

## 2. Window selector — 1 / 4 / 24 / 72 HR

Matches the existing pattern (`tab-perf.html:137`): a `join` group of
`btn btn-xs join-item font-mono`, active `btn-primary`, otherwise
`btn-outline btn-neutral`, persisted via `persistSet`.

- Values `[1, 4, 24, 72]` hours, default **24**, persisted as `nodeWindowHours`.
- Rendered in each `series` section header, bound to one page-level value so
  every chart on the page shares a window rather than disagreeing.
- The choice travels with the RPC: `{ type:'node_status', num, window_h }`. The
  **server** slices history to that window and computes the ticks for it.

**This is not a browser decision.** `BROWSER_CONTRACT.md` §What the browser IS
allowed to do permits handling raw user input before sending it to the backend.
The browser captures a click and forwards it; the server decides what data and
what labels come back. No slicing, no re-bucketing in the browser.

Replaces the hardcoded 7-day `WINDOW_SEC` in `node-status.js`.

`node_status_update` re-requests with the current `window_h`, so live updates
stay inside the selected window.

## Files

| File | Change |
|---|---|
| `src/format.js` | `fmtAxisTick(ts, spanSec)` |
| `src/node-status.js` | accept `windowHours`; emit `ticks[]` per series section |
| `src/ws-relay.js` | pass `msg.window_h` through to `buildNodeStatus` |
| `public/app-node-status.js` | send `window_h`; position ticks from `section.ticks`; `setNodeWindow()` |
| `public/partials/tab-node.html` | window join-group in each series section header |
| `public/app.js` | `nodeWindowHours` state, persisted |
| `docs/modules/*` | format, node-status, app-node-status, ws-relay — updated + rehashed |

## Invariants

- The browser never formats a date, and never slices history.
- Tick labels are rendered verbatim from `section.ticks[].label`.
- A window with no data yields a section that is **absent**, not empty — the
  existing presence rule is unchanged and still server-decided.
- Switching window re-requests; it does not re-filter cached points.

## Done when

- The x axis shows readable time labels at 1, 4, 24 and 72 HR
- The selector matches the perf pattern and persists across reload
- Switching window changes the data returned, verified over the wire
- 1440×900, both themes, zero console errors sustained
- `check_specs.py` green
