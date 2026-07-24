# Browser Contract

## The rule

The browser is a presentation layer. It makes zero decisions.

All state — button states, page state, dashboard state, active device, mode, enabled/disabled
controls, visibility of UI elements — is owned and managed by Node.js and pushed to the
browser via WebSocket events. The browser renders what it is told.

## What this means in practice

- If a button should be disabled, Node.js sends that state. The browser does not compute it.
- If a page has a "selected device", Node.js owns that selection and broadcasts it.
- If a display differs based on a condition, that condition is evaluated in Node.js.
- The browser holds no authoritative state. It holds only the last value it was told.
- If state is missing, the browser shows a loading/unknown indicator — it does not guess.

## What the browser IS allowed to do

- Render and format data it receives (numbers, dates, units, colours, layout)
- Handle raw user input before sending it to the backend (debounce, form field state)
- Animate transitions between states it has been told about
- Cache the last received value for display purposes (not for decision-making)

## Exceptions

There are no exceptions unless Node.js is physically incapable of computing a piece of
state (e.g. local browser geometry, viewport size for layout-only purposes).

Every proposed exception must be:
1. Raised explicitly — never silently added to browser code
2. Justified in writing in the task spec
3. Approved by Peter before implementation begins

An exception that is not approved is a bug, not a feature.

## Enforcement

- Every browser task spec must reference this document
- Any browser code that derives, computes, or decides state (beyond the permitted list above)
  is a violation and must be reported, not silently left in place
- `python scripts/check_specs.py` does not validate this contract — human review does

## Transport rule (Peter, 2026-07-04 — absolute)

**GET is only for form population/submission workflows. Any other browser
GET is a violation.** All page data — lists, histories, settings, device
state, lookups — arrives over the WebSocket (`/events`): replayed on
connect, pushed on change, requested via WS RPC where inherently
on-demand (e.g. geocode). `WS_ONLY_ROUTES`/`WS_ONLY_EXACT` in index.js
enforce this with a hard 410 for browser-flavored GETs; add every new
page-data endpoint there. Config-editor reads (schemas, sections,
channels, owner, radar settings panel) are the sanctioned form flows.

Server-formatted time-dependent display values (for example, relative ages)
must remain current while their page is open. The server pushes their changed
display value over `/events`; page reloads, browser timers that recompute
server facts, polling, and browser GETs are forbidden freshness mechanisms.
