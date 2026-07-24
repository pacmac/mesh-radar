---
module: browser-playwright-audit
source:
  - CLAUDE.md
  - AGENTS.md
  - docs/STYLE_GUIDE.md
  - tests/test_playwright.py
  - src/index.js
  - public/app-nav.js
  - public/app.js
  - public/app-config.js
  - public/index.html
  - public/sw.js
  - public/partials/drawer-sidebar.html
  - public/partials/tab-cfg.html
  - public/partials/tab-devices.html
  - public/partials/tab-messages.html
  - public/partials/tab-perf.html
  - public/partials/tab-radar.html
  - public/style.css
  - public/debug.html
  - tests/test_channel_write.mjs
  - public/vendor/alpinejs-3.15.12.min.js
  - public/vendor/chart.umd-4.min.js
  - public/vendor/daisyui-4.12.14.min.css
  - public/vendor/tailwindcss-3.4.17.js
  - public/vendor/fonts/dm-sans-normal-latin.woff2
  - public/vendor/fonts/dm-sans-italic-latin.woff2
  - public/vendor/fonts/jetbrains-mono-latin.woff2
  - public/vendor/fonts/oxanium-latin.woff2
source_hash: f835acb6c148ead056602f443e7570e7bd171bb5c04a8c4a6b6e1399522094fd
updated: 2026-07-24
---

# Module: browser-playwright-audit

## Purpose

Define the repeatable browser acceptance suite for node-dash and the defects
that must be removed before that suite can pass. The suite inventories every
reachable page, proves that server-owned data reaches the browser, exercises
safe controls, checks desktop and iPhone geometry, and verifies one reversible
radio-channel write through the real UI.

This specification is governed by `docs/BROWSER_CONTRACT.md` and
`docs/STYLE_GUIDE.md`. It adds no browser authority. Viewport geometry is the
existing Browser Contract exception for layout-only browser work.

## Responsibilities

- Keep a machine-readable inventory of the production SPA routes and `/debug`.
- Fail when a documented page navigation does not return HTML with HTTP 200.
- Fail when the Alpine application, WebSocket, device list, or expected
  page-specific data surface does not initialise.
- Fail on uncaught page errors, console errors, failed same-origin static
  assets, or external runtime dependencies.
- Exercise non-destructive controls and verify their visible state transition.
- Check viewport containment at 1440x900 and 390x844.
- Partition controls by effect so an audit cannot accidentally transmit,
  move hardware, erase data, change credentials, or remove a device.
- Exercise channel save only on OMNI and only on unused channel 3 or 4.
- Snapshot and restore every value changed by a live test, including cleanup
  after an assertion failure.
- Write generated screenshots, traces, snapshots, and reports below a dedicated
  artifact directory; never write them to the repository root.
- Print a terse per-page result and a final pass/fail summary suitable for MCPP.

## Dependencies

- `docs/BROWSER_CONTRACT.md` — page data transport and browser authority.
- `docs/STYLE_GUIDE.md` — both-theme and viewport acceptance rules.
- `src/index.js` — SPA/API route ordering and static asset serving.
- `public/index.html`, `public/app.js`, `public/app-nav.js` — shell boot and
  navigation.
- `public/partials/*.html` and their `public/app-*.js` mixins — page surfaces
  under test.
- `/events` — authoritative settings, devices, nodes, histories and live state.
- Config-editor GET endpoints — the sanctioned form-population exception.
- `/ops` and `config_op` — verified channel write pipeline.
- Python Playwright async API and a locally installed Chromium.

## Public interface

### Command

```bash
python3 tests/test_playwright.py
```

### Environment

- `NODE_DASH_URL` — target origin; default `http://localhost:8000`.
- `PLAYWRIGHT_HEADLESS` — `1` by default.
- `PLAYWRIGHT_TIMEOUT` — assertion timeout in milliseconds; default `15000`.
- `PLAYWRIGHT_ARTIFACT_DIR` — artifact root; default
  `.playwright-mcp/audit`.
- `PLAYWRIGHT_LIVE_CHANNEL` — optional channel index. The live acceptance run
  uses `3`; only `3` or `4` is accepted.
- `PLAYWRIGHT_OMNI_NODE_ID` — expected OMNI node id; live default
  `!2687afb1`.
- `PLAYWRIGHT_OMNI_MAC` — optional stronger identity assertion.

The default run is passive and safe. Supplying `PLAYWRIGHT_LIVE_CHANNEL`
enables exactly the reversible OMNI channel test and no other live write.

### Result

- Exit `0` only when every selected test passes and live-test cleanup succeeds.
- Exit non-zero on any failure, cleanup failure, or unsafe target mismatch.
- Output one line per case plus totals grouped by page.
- A cleanup failure is always prominent and names the affected device/channel.
- Secrets and channel PSKs are never printed or stored in artifacts. Reports
  may contain only `psk_present` and character/byte length.

## State

The test runner owns only transient test state:

- collected console/page/network failures;
- current viewport and route;
- page inventory results;
- original OMNI channel snapshot held in memory;
- whether the temporary write happened;
- cleanup outcome;
- artifact paths.

It must use a fresh browser context for deterministic navigation state. A
separate seeded context verifies migration from invalid persisted UI state.
No test may rely on a developer's existing browser localStorage.

## Events emitted

_N/A._ The runner observes `/events`; it does not add application events.

For the live channel case it observes the existing `config_op` lifecycle and
requires terminal `success` for both write and restoration.

## Invariants

### Route inventory

The SPA routes are:

| Route | Required page |
|---|---|
| `/` | Overview |
| `/overview` | Overview |
| `/radar` | Radar |
| `/nodes` | Nodes |
| `/messages` | Messages |
| `/config` | Config |
| `/devices` | Devices |
| `/range` | Range Test |
| `/performance` | Performance |
| `/node/!<hex>` | Node focus |

`/debug` is a separate debug monitor and must return its own HTML page.

`/device-config` is a legacy route. It must redirect to `/devices` or
deterministically render Devices; it must never restore an unrelated persisted
tab.

Every direct navigation above returns HTTP 200 HTML. The WS-only guard rejects
browser `fetch()` page-data requests but never rejects a document navigation.

### Navigation state

- `/` always selects `overview`; it never restores another page.
- An unknown or removed persisted `activeTab`, including `control`, falls back
  to `overview` and is replaced with a valid value.
- `popstate` uses the same route table as cold navigation.
- Config exposes only real subtabs: Bridge, Rotator, Modes, Radar and Alerts.
- Radio, Channels and Owner exist only inside the selected Devices card.
- No sidebar link may select a tab or subtab without rendered content.

### Required data surfaces

After WS initialisation:

- Shell: live/offline state, device count and node count are present.
- Overview: six summary stats and Live Event Feed exist; optional tilt and
  environment cards render when their server data exists.
- Radar: radar canvas/SVG, range control, node filters and rotator mode state
  exist.
- Nodes: count, sort, filters and at least one card or a designed empty state.
- Messages: compose controls and authoritative Message Feed.
- Config: all five real subtabs; each form subtab either loads its sanctioned
  form data or shows a visible error/loading state.
- Devices: one strip per `device_list` entry and Settings/Radio/Channels/Owner/
  Firmware/Maintenance for the expanded OMNI card.
- Range: radio/node filters, stats/empty state, visualisation and log.
- Performance: radio choice, Simple/Expert, stats, both charts, history and
  auto-traceroute controls.
- Node focus: identity header plus server-supplied sections, or the designed
  unknown-node state.
- Debug: both WS cards, device-state cards, filters, Pause and Clear.

Blank main content is always a failure.

### Safe controls

The passive suite may:

- navigate routes and sidebar items;
- open/close the drawer, node modal and compose modal;
- sort Nodes;
- switch read-only display modes and chart windows;
- change local-only filter controls in a fresh context;
- switch Config subtabs and load forms;
- expand the OMNI Devices card and its six tabs;
- select OMNI as the display/test radio;
- toggle Debug filters, Pause and local Clear;
- trigger controls documented as no-op refreshes.

Where a preference writes node-dash configuration, the runner snapshots,
changes, verifies, restores and verifies the original value. These cases are
separate from the strictly passive run.

The audit must not activate:

- any YAGI control or YAGI-backed request;
- PASV/ACTV/SCAN/ABORT, rotator Point/Target, motor variables or calibration;
- traceroute or auto-traceroute transmission;
- message Send;
- range Start/Stop TX;
- tilt calibration;
- radio section, owner, fixed-position, antenna or role writes;
- BLE scan/connect/pair/disconnect/retry/remove;
- packet-source changes;
- auto-purge setting changes or node DB wipe;
- alert test email or credential changes;
- OTA upload/download/prepare/delete/flash;
- backup restore.

Those controls are verified for presence, correct labels, disabled/loading
bindings and safe target labelling only.

### OMNI channel round-trip

The live case is authorised only when all guards pass:

1. The target `device_list` entry has label exactly `OMNI`, node id equal to
   `PLAYWRIGHT_OMNI_NODE_ID`, and BLE state `ready`.
2. The YAGI node id is not the selected target.
3. Channel is numeric `3` or `4`.
4. The original channel is unused: absent/empty settings and no active role.
5. The original full channel object is captured in memory and redacted before
   any diagnostic output.

The case then:

1. Opens Devices -> OMNI -> Channels through user-visible navigation.
2. Expands the chosen channel and verifies the schema-generated controls.
3. Writes a unique short audit name and `SECONDARY` role using the page Save
   button.
4. Requires a successful `config_op`, success UI, and retained local form
   values.
5. Resyncs OMNI only, then requires bulk `/channels` read-back containing the
   audit values. The resync is required because mesh-gw's channel cache is
   stale until reconnect.
6. Restores the exact original channel state in a `finally` block and resyncs.
7. Requires successful restoration and a second bulk read-back equivalent to
   the original semantic state.
8. Re-enables auto-connect in the final cleanup and leaves OMNI ready and the
   channel unused.

If any guard fails, no write occurs and the suite fails rather than choosing a
different device or channel.

### Layout and assets

At both 1440x900 and 390x844, for every production page:

- no visible interactive element or status badge extends outside the viewport;
- the active main panel has no unintended horizontal overflow;
- all controls are reachable by scrolling an intentional scroll container;
- fixed headers do not cover the active content;
- dialogs fit inside the viewport;
- no blank or zero-size primary panel exists.

The Debug page has the same horizontal-containment requirement.

All runtime CSS and JavaScript dependencies are served from the node-dash
origin. A test fails on a request to `cdn.tailwindcss.com`, `cdn.jsdelivr.net`,
or any other third-party runtime host. Required licence files remain beside
vendored assets.

### Artifacts

- No `*.png`, `*.jpg`, `*.jpeg`, `*.webp`, trace, snapshot or report is written
  at repository root.
- Failure artifacts use
  `${PLAYWRIGHT_ARTIFACT_DIR}/<viewport>/<page>/<case>.*`.
- Screenshots are taken on failure and for the final both-theme visual matrix.
- Artifacts never contain unredacted password, PIN, SMTP or PSK values.

## Test notes

### Phase A — static preflight

- `node --check` every browser and backend JavaScript file.

## Observation record (2026-07-23)

- Final live matrix: **231 checks, 0 failures** across 12 routes, desktop and
  iPhone viewports, both themes, direct navigation, WS/device data, console
  errors, same-origin assets, geometry, safe tabs, and invalid persisted-nav
  migration.
- OMNI channel 3: UI success and local retained values; persisted name/role
  present after reconnect; exact cleanup verified unused after reconnect;
  OMNI final state ready with auto-connect enabled. YAGI was never targeted.
- Visual artifacts are under `.playwright-mcp/audit/`; none are in the project
  root.
- Assert the route inventory and nav maps agree.
- Assert every sidebar destination maps to mounted content.
- Assert production HTML contains no external runtime asset URL.

### Phase B — passive route/data audit

- Run every route in a fresh context at desktop and iPhone sizes.
- Record response status, resolved tab/subtab, WS state, device count, expected
  data surface, blank-content result and geometry result.
- Capture page errors, console errors and failed requests.
- Use OMNI for every device-scoped form read.

### Phase C — safe interaction audit

- Exercise local/navigation controls and modal open/close.
- Switch every Config subtab and every OMNI Devices subtab.
- Confirm dangerous controls are correctly targeted and expose the expected
  disabled/running/error UI without activating them.

### Phase D — reversible writes

- Run preference snapshot/change/restore cases.
- Run the guarded OMNI channel 3 round-trip.
- Treat restoration as part of the test, not teardown best effort.

### Phase E — visual matrix

- Desktop 1440x900 and iPhone 390x844.
- Light and dark themes.
- Screenshot each production page after data settles.
- Assert containment numerically before saving the screenshot.

### Defects already required to fail

The first run must reproduce, and implementation must remove:

- `/config` and `/devices` document navigations returning 410;
- `/` and `/device-config` restoring removed `control` state to a blank page;
- sidebar Config -> Radio selecting a nonexistent subtab;
- iPhone navbar clipping;
- iPhone Performance main-panel overflow;
- iPhone Debug horizontal overflow;
- external CDN runtime requests;
- the old two-save Playwright script's missing inventory, mobile and safety
  coverage.

## Out of scope

- Security, penetration or vulnerability testing.
- Radio RF quality, protocol correctness or mesh coverage.
- Proving hardware movement, calibration, OTA or destructive maintenance.
- Testing YAGI while its intermittent brownout remains unresolved.
- Changing the Browser Contract or adding browser-owned business decisions.
- Interpreting application-specific/custom alarm payloads.
