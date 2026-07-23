---
module: app-align
source:
  - public/app-align.js
  - public/align.html
  - public/align.css
  - public/vendor/daisyui-4.12.14.min.css
  - public/vendor/tailwindcss-3.4.17.js
  - radar.conf
source_hash: a8d2831c27e2bdb7e82ea8c35eed5124d9b9084b650eb145eaee4cb8b898a000
updated: 2026-07-23
---

# Module: app-align

## Purpose

The mobile Yagi alignment page — used **one-handed at the mast while turning an
antenna**. Companion to `public/align.html`, served at `/align`.

**Presentation layer only.** Per `docs/BROWSER_CONTRACT.md`, this file renders the
align view-model pushed by `src/align-api.js` over `WS /align/events` and computes
**nothing**. Two phones on the same session show byte-identical screens because
both render the same pushed model.

## What the operator needs — three questions

Every element answers one of these, and the **backend** works out the answer:

1. **Is THIS position better than the last?** → `trendDir` / `trendDelta` on the current reading.
2. **Did I find a BETTER position earlier?** → `best`, and each reading's `isBest`.
3. **Is this the BEST?** → `isBest` on the current reading (else the gap the backend supplies).

## The reading

- Big value = **quality** (0–100) with its **label** (Excellent/Good/Fair/Poor) and
  semantic **colour class** — all from the view-model's `current`. Raw dB
  (`rssi`/`snr`) shown small, for the record. The operator does not read dB.
- Trend (`current.trendDir`/`trendDelta`) and the below-best line
  (`current.gapToBest`/`bestN`/`bestAgo`) are pushed, not derived.
- Each press fires a **burst of N** pings (N is a 1–5 control, default from
  `nBurst`); while it runs the button shows `burst.got`/`burst.of` ("gathering
  3/4"). One averaged reading lands, carrying `spread` (± quality) and `got/of`.
- **Bars, one per reading**, newest right: height = `barPct` (backend-computed,
  session-relative). `isBest` → starred + `success`; `isCurrent` → `primary`; rest
  neutral. The tallest bar is the best position — the eyeball answer to Q2.
- Per-radio RX readout: `yagi_q` / `omni_q` (our antennas hearing the device),
  shown as quality; a radio that missed shows a gap, not a zero.

## What the browser is allowed to do (and only this)

- Render/format pushed fields into fixed DOM elements and reading-bar nodes.
- Hold the **N selector** value (1–5) — raw user input — and send it with
  `POST /align/ping { num, n }`. This is the one value the browser originates
  (BROWSER_CONTRACT §"handle raw user input"); it decides nothing about display.
- Show and edit the **reply-wait period** field. Unlike N, this value is
  **server-persisted** — it is displayed from the pushed `model.replyWindowSec`,
  and a change POSTs `/align/reply-window { sec }`; the server persists it and
  pushes the new model back. The browser holds only the raw input; the authoritative
  value is the model's.
- Open the WS on load and re-render on each `kind:'align'` frame.
- Poll `GET /align/state` as a transport fallback. PING and End are REST actions
  and must never be gated on WebSocket readiness.

It holds **no derived state**: no best, no trend, no averaging, no bar maths, no
label bands, no quality. If a value is not in the model, it shows nothing — it
never computes a fallback.

## Design — the dashboard's design system, not a new one

`STYLE_GUIDE.md` is canonical (three bespoke attempts were rejected). DaisyUI
semantic classes only — cards, `.stat`, `badge`, `btn`, the type-role table — no
hex/rgba/oklch in markup. No Chart.js; bars are plain DOM. Controls sit in the
bottom thumb zone.

The control header is responsive by construction: on viewports below the `sm`
breakpoint the target occupies a full row and the average/wait controls share a
second row; at `sm` and above all three occupy one row. Every shrinkable grid item
has `min-width: 0`. The fixed viewport uses `100dvh` where available and includes
all four safe-area insets. At 375–430px portrait widths, document `scrollWidth`
must equal `innerWidth`.

## Public interface

The local `app-align.js` mounts itself on `DOMContentLoaded`, binds the form and
buttons with native DOM events, and renders pushed view-model fields into named
elements. It exposes no framework component API. Its state consists of `model`
(the last pushed view-model), `nBurst` (the raw N selector input), `target`,
`targets`, and connection/lifecycle handles. No derived view-model getters.

## Frame handling (`WS /align/events`)

- `kind:'align'` → replace `model` wholesale and render. Adopt `target` from it.
- No other frame kinds. The socket opens on load so a second phone reflects a
  running session.
- `_open()` is idempotent and resolves only after the socket is OPEN.
- PING does not await socket readiness; it starts the POST immediately and lets
  the socket connect independently.
- A low-frequency state poll replaces the model wholesale when the WebSocket is
  unavailable. When WS is open, pushed frames remain the immediate update path.
- An unexpected close schedules one reconnect. `pageshow` and returning to a
  visible document also ensure a connection; explicit End suppresses reconnect.
- Request failures are logged with their HTTP status/error instead of being
  silently discarded. They do not fabricate server-owned view-model state.

## Invariants

- **Renders the model; decides nothing.** Enforced by review, not `check_specs`.
- `/align` has no Alpine dependency. Its local classic script owns mounting,
  event binding and rendering, so a CDN failure cannot leave controls inert.
- The local script avoids optional chaining and nullish-coalescing syntax in its
  executable path for compatibility with older Safari versions.
- **N is the only browser-originated value**, and it is raw input, not state.
- **PING disabled while `burst.active`** and while no target is selected — but the
  *disabled flag comes from the model where the backend can set it*; the browser
  mirrors it.
- Initialization performs one targets GET and creates at most one WebSocket.
- WebSocket failure never blocks `/align/ping`, `/align/stop`, or reply-window
  REST actions; polling keeps the authoritative view-model current.
- Browser `pagehide` never POSTs `/align/stop`; the backend's existing last-client
  dead-man and the explicit End action own session termination.
- Where Screen Wake Lock is available, it is reacquired when the document becomes
  visible and the server says the session is running. Absence on insecure iPhone
  HTTP origins remains non-fatal.

## Test notes

- with a pushed model of several readings: bars render at the model's `barPct`,
  best starred, current highlighted, quality label + colour per the model
- pressing PING with N=4 sends `{num, n:4}`; the button shows `got/of` progress
  from pushed `burst` frames; one averaged reading appears
- two browsers on one session render identical screens
- at true 375×667, 390×844 and 430×932 viewports, document `scrollWidth === innerWidth`
- desktop 1280×800 keeps target, average and wait controls on one row
- initialization makes one `/align/targets` request and one live WebSocket
- block `/align/events`: PING still POSTs, status becomes RUNNING from
  `/align/state`, burst progress/readings render, and End still stops the session
- on a cold, cache-disabled load with the Alpine CDN blocked, targets populate
  and PING disables immediately while sending one `/align/ping` request
- force-close the socket: one reconnect reaches OPEN; explicit End does not reconnect
- `pagehide` emits no `/align/stop` request
- both themes render with 0 application console errors

## Out of scope

- Any computation of signal, quality, best, trend, or layout scaling — all Node's.
- Dashboard state, nav, drawer; rotator control.
- Backend session/dead-man behavior in `src/align-api.js`.
- Changes to the dashboard-wide dependency packaging outside `/align`.

## Mobile reliability fix (`fix-align-mobile`, 2026-07-23)

Implementation is limited to two browser sources:

1. `public/align.html`: remove the explicit `x-init`; replace the overflowing
   one-row control flexbox with the specified two-row-mobile/one-row-desktop grid;
   add shrink constraints, dynamic viewport height, and horizontal safe-area
   padding.
2. `public/app-align.js`: remove the pagehide stop beacon; make WebSocket opening
   awaitable/idempotent; reconnect on unexpected close/pageshow/visibility;
   suppress reconnect after End; check HTTP responses; reacquire wake lock where
   supported.

Explicitly unchanged: `src/align-api.js` and every other backend file, because
this task is Domain 2 only; `public/sw.js` and CDN packaging, because neither is
required to fix the reproduced overflow or observed explicit mobile stop path.

## Mobile bootstrap fix (`fix-align-mobile-bootstrap`, 2026-07-23)

Implementation is limited to `public/align.html`: load the import-free
`public/app-align.js` as a classic local script before deferred Alpine. This
removes the module/defer execution race that can leave a cold Safari load with
uninitialized `x-data` and inert controls.

Explicitly unchanged: `public/app-align.js`, all backend files, radio
configuration, and external dependency packaging.

## Framework-independent mobile fix (`fix-align-mobile-no-alpine`, 2026-07-23)

The preceding ordering correction did not fix the real iPhone. Reproduction with
Alpine unavailable produced the exact reported state: rendered layout, empty
target selector, inert PING, and no `/align/targets` request. This task therefore:

1. removes Alpine and all `x-*` bindings from `public/align.html`;
2. makes `public/app-align.js` mount, bind and render with browser-native DOM APIs;
3. retains the same backend-owned view-model and REST/WS contracts; and
4. verifies operation with third-party JavaScript CDNs blocked.

Tailwind 3.4.17 and DaisyUI 4.12.14 are pinned under `public/vendor`; the page
uses system font stacks and makes no Google Fonts request.

Explicitly unchanged: all backend files, radio configuration, and server-owned
display computations.

## Proxy transport fix (`fix-align-proxy-fallback`, 2026-07-23)

The HTTPS nginx regex originally upgraded `/events` and `/!device/events`, but
not `/align/events`. Because the browser awaited WebSocket open before POSTing,
that proxy omission made PING a no-op. The durable contract is:

1. `radar.conf` forwards `/align/events` as a WebSocket;
2. REST actions do not depend on WebSocket readiness; and
3. `GET /align/state` polling renders the same complete server view-model if a
   proxy still prevents WebSocket upgrade.
