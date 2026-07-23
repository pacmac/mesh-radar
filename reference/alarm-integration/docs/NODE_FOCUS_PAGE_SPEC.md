# Node focus page — spec

Step 5 of `status-rebuild-rip`. Browser only (Domain 2).

Mandatory reading: `docs/BROWSER_CONTRACT.md`. Payload contract:
`docs/NODE_STATUS_RPC_SPEC.md`. Design decisions: mcpp task note 1039.

## The browser decides nothing

The page renders an ordered list of server-supplied sections. It knows three
section **kinds** and nothing else — not which port a datum came from, not what
portnum 260 is, not what a detection is.

- **Presence** is server-decided. The page renders `sections` in order. It does
  **not** test whether a section has data. `x-if="section.fields.length"` would
  be the browser deciding — forbidden.
- **Formatting** is server-decided. Every field carries `text`; the page binds it
  verbatim. No `toFixed`, no unit concatenation, no date math.
- `BROWSER_CONTRACT.md` permits browser-side formatting in general, but
  `NODE_STATUS_SPEC` iron rule 1 is stricter for this page and governs.

## NOT building: the "1s liveness tick" in the step title

The step title predates the spec. A browser timer recomputing relative ages
would be the browser computing a displayed value. The server sends `ago` as
text; freshness comes from re-requesting on `node_status_update`.

This is the same stale-title problem as `signal_history` in step 3.

## Transport — WS only

`BROWSER_CONTRACT.md` §Transport: all page data over `/events`. The page uses
the `node_status` WS RPC. **No `fetch`, no GET.**

## Navigation

- Route `/node/<!hexid>`, so a focused node survives reload and is linkable —
  which suits "focus on this node" better than transient tab state.
- `app-nav.js` currently maps static path↔tab. Add a param-aware branch: a
  pathname matching `^/node/!([0-9a-f]+)$` selects tab `node` and sets
  `nodeStatusNum`.
- Entry point: an action in the existing node summary modal
  (`tab-shared.html`, `x-ref="nodeInfoDialog"`). The modal **stays** — it is
  tier 1, the peek that does not navigate you away. The page is tier 2.

## NOT in this step: favourites

A favourited node gets its own left-menu item — but that needs a new config key,
a backend route, and nav wiring, and it is a convenience shortcut, not part of
"the page works for any node". Separate task. The page is reachable from the
modal for every node regardless.

## Section kind renderers

| kind | rendering |
|---|---|
| `value_grid` | label/value rows, `text` bound verbatim |
| `series` | Chart.js line chart, one dataset per `series[]` entry, **visible time axis** (`t_min_text`/`t_max_text` shown) |
| `event_log` | reverse-chronological rows: `ts_text`, `label`, `text` |

An unknown `kind` renders nothing and logs a console warning — forward
compatibility, so a future backend section never breaks the page.

## Files

| File | Change |
|---|---|
| `public/app-node-status.js` | NEW — RPC request/reply, hint handling, chart lifecycle |
| `public/partials/tab-node.html` | NEW — the page; renders the three kinds |
| `public/app.js` | mount mixin; `nodeStatus`/`nodeStatusNum` state; register partial |
| `public/app-ws.js` | handle `node_status` reply + `node_status_update` hint |
| `public/app-nav.js` | param-aware `/node/!hexid` route |
| `public/partials/tab-shared.html` | "Node Info" action in the existing modal |
| `public/index.html` | load the new partial + module |
| `docs/modules/*` | new/updated specs |

## Chart lifecycle

Tabs lazy-mount via `x-if`. Perf destroys its Chart.js instances on leave
(`destroyPerfCharts`, `app-nav.js:23`) or canvases leak. The node page does the
same: destroy on leave and before every re-render, since a `node_status_update`
re-request replaces the data wholesale.

## Live update

On `node_status_update` where `num === nodeStatusNum` **and** the node tab is
open, re-request `node_status`. Ignore hints for other nodes — that is a
delivery filter, not a data decision.

## Invariants

- The page contains no unit string, no rounding, no date math.
- No `x-if` tests whether a section has content.
- Sections render in the order received.
- No `fetch`/GET for page data.
- Charts are destroyed before re-render and on tab leave.
- The summary modal keeps its existing behaviour — this step only adds an action.

## Done when

- `/node/!hexid` loads the focused node directly and survives reload
- The modal's action opens the page for any node
- A 260 node shows its extra sections; a plain node does not
- Series show a visible time axis
- Screenshots in **both** themes; zero console errors
- `python scripts/check_specs.py` green
