---
module: tab-control
source: public/plugins/alarm/tab-control.html
source_hash: ac19adc37cbe762c9988a55e6212614615e8da0a1423285310198901755f7934
updated: 2026-08-01
---

# Module: tab-control

## Purpose

Control page: pac-host unit picker, command shortcuts + free-text verb,
queue/receipt panel. Presentation only — renders `controlMixin`
(`app-control.js`) state and decides nothing about verbs, units, or receipt
meaning (BROWSER_CONTRACT).

## Scope

Task `pac-host-command-surface`. New page, no prior version. Companion files:
`public/app-control.js` (own spec), `public/index.html` (one `x-if` line),
`public/partials/drawer-sidebar.html` (nav item, `x-show`-gated on
`pacHostStatus?.available`), `public/app-nav.js` (`control` path map).

## Sub-tabs (task `control-section-ia`, 2026-07-25)

Peter: "I think it's time you added the menu / submenu, even if they are
skeleton pages." Six sub-tabs, `controlTab`-gated, `.tabs` bar mirroring
`tab-cfg.html`'s pattern exactly (same shape as `cfgTab`, driven by
`switchControlTab()` in `app-control.js`, routed through `setNav('control',
name)` in `app-nav.js`, mirrored in `drawer-sidebar.html`'s Control
`<details>` submenu): **Summary, Command, Camera, Config, Stats, Yagi Align,
Chat** — Camera added 2026-07-30, seven in total, grid widened to
`grid-cols-7`.
Only **Command** has real content today — the other five are skeleton cards
(Section-label title + Caption-role "Coming soon.", STYLE_GUIDE §5), no
functionality, per Peter's explicit "even if they are skeleton pages."
`controlTab` persists (default `'command'`, the only sub-tab with content).

**Yagi Align is no longer a skeleton — rebuilt live, task `yagi-align-rebuild`,
2026-07-25**, after mt-transport shipped the align backend and Peter
confirmed the go-ahead ("so have you built the aligne frontend as I dont see
it?"). It is a rebuild of the archived `reference/alarm-integration/` feature
against the NEW pac-host-owned backend (`GET/POST /v1/mesh/align/*`), not a
revival of the old one — the old backend (`src/align-api.js`) depended on
this repo owning the mesh connection directly, which it no longer does. See
its own Layout section below and `docs/modules/app-align.md`.

## Layout — Command sub-tab

Left/right grid (`lg:grid-cols-2`): **Command** card on the left; a
vertically-stacked **Pending** + **Executed** pair on the right (task
`control-since-and-pending-split`, 2026-07-25 — Peter: "the command /
response should show any queued commands in probably a seperate panel / card
above it. and queue is the wrong label for the existing one, that is
executed."). Replaces the earlier single side-by-side "Queue" card.

- **Command** card: unit picker (`.join` of buttons, one per
  `controlDevices()` entry), shortcut verbs (`.join`, disabled until a unit
  is selected), free-text verb input + Send. **No confirmation gate before
  sending, to any unit — removed 2026-07-25 (task `garg-confirm-removal`),
  Peter's explicit request** ("please remove the popup confirmation when
  sending to GARG"), reversing his own earlier directive. A unit button dims
  (`opacity-60` + a title tooltip) when `!d.present` (task
  `control-devices-endpoint`, 2026-07-25) — known-but-asleep, still fully
  clickable, since queuing a command for a sleeping unit is valid (delivered
  next wake window).
- **Pending** card (top, `max-height:40%`, own scroll): `controlPending()` —
  entries with `state === 'queued'` or `'trying'`, i.e. still in flight.
  Compact rendering (verb+args, `entry.since`, a `badge-info` badge showing
  the raw state text, an error line gated on `state==='failed'||'expired'`
  — never on mere presence of `entry.error`, since a queued entry can carry
  a stale error from a previous retry, mt-transport's explicit correction)
  — no result yet, since a pending entry has none.
- **Executed** card (below, fills remaining height): `controlExecuted()` —
  every entry that has reached a terminal outcome (`done`/`sent`/`failed`/
  `expired`/`cancelled`). No refresh control of any kind — both cards are a
  pure read of pushed state (task `control-queue-push-not-get`, 2026-07-25;
  an earlier version had a manual refresh button, removed along with the GET
  it triggered). Rendered **newest-first** (`controlLedger()` sorts by
  `createdAt` descending — pac-host's own ledger array is oldest-first,
  which read as "random" to Peter, 2026-07-25). Each entry is a
  `bg-base-200 rounded-xl p-3` sub-section (STYLE_GUIDE §5) showing verb+args
  (data role) plus the server-pushed relative timestamp (`entry.since`, e.g.
  "5m ago" — task `control-since-and-pending-split`, replaces the earlier
  client-formatted `YYMMDD-HHMMSS` stamp per BROWSER_CONTRACT: relative time
  must be server-formatted and pushed, not computed by the browser), a state
  badge (`done`→success, `sent`→info — deliberately NOT success, since a
  dispatched-but-unconfirmable text/command is a different claim than a
  device-confirmed one, mt-transport's explicit design note — `cancelled`→
  warning, `failed`/`expired`→error, anything else→ghost), the result as a
  key-value grid (`controlResultFields()` — reuses `tab-node.html`'s
  `value_grid` pattern exactly, task `control-receipt-readable`), and the
  error message when `state==='failed'||'expired'` and `entry.error` is set.

  **Field names (task `ledger-field-rename`, 2026-07-25):** mt-transport
  shipped a full ledger rewrite the same day (commit `975449e`, xsession
  `[request-ledger]`) with no old-shape fallback — `status`→`state`,
  `enqueuedAt`→`createdAt`, `receipt`→`result`, `lastError` string→`error`
  `{code,message}` object. The ledger also now holds text messages
  (`kind:'text'`) alongside commands — `controlLedger()` filters to
  `kind==='command'` so this page's own Invariant (below) stays true rather
  than silently breaking. Peter caught the resulting breakage independently
  ("now it only shows 1 line, the command") before this fix landed.

## Layout — Yagi Align sub-tab (task `yagi-align-rebuild`, 2026-07-25)

Single column, ported from the archive's `align.html` structure into
STYLE_GUIDE-compliant markup (Alpine bindings replacing raw DOM element
lookups, `text-2xl font-mono font-bold tabular-nums` Display-value role
replacing the archive's oversized `text-6xl` — that page was a full-screen
mobile field tool, this is an embedded dashboard card):

- **Controls row**: target `<select>` (options from `alignTargets()` —
  node-dash's own `favourites`, same source the archived `/align/targets`
  route used server-side via `listFavourites()`; no new backend route
  needed), RUNNING/READY badge, N-burst `<select>` (1-5, `x-model.number`),
  reply-wait `<input type=number>` (5-120s, `@change="alignSetReplyWindow()"`).
  All three controls disable while `alignBursting()||alignSending`.
- **Warning line**: `x-show="alignModel?.warning"` — e.g. `"No replies — try
  again."` when a burst lands nothing. No reading is invented for a silent burst.
- **Current reading card**: border flips to `border-success` when
  `current.isBest`. Quality (Display value), label, tone class (`cls`) all
  read directly off `alignModel.current` — no local computation. Trend line
  (`trendDir`/`trendDelta`), best-line (`gapToBest`/`bestN`/`bestAgo`),
  YAGI/OMNI secondary quality (`yagi_q`/`omni_q`, rendered `—` when `null`,
  **never `0`** — a radio hearing nothing is a gap, not a zero, mt-transport's
  explicit instruction), raw rssi/snr.
- **Reading bars**: one per `alignModel.readings[]` entry, height =
  `barPct%` (the one place this file computes a CSS value from data, per
  STYLE_GUIDE §7's inline-style exception for genuinely runtime-computed
  values) — `bg-success` when `isBest`, `bg-primary` when `isCurrent`, else
  neutral. ★ marks the best.
- **Actions**: PING (disabled while bursting/sending/no target; shows a
  spinner + `"GATHERING got/of"` while a burst is active) and End (disabled
  unless `alignRunning()`).

## Layout — Camera sub-tab (**ALARM PLUGIN**, task `camera-page-ux`, 2026-08-01)

### What was wrong, measured before the rewrite

Peter, 2026-08-01: *"the page is really a monkey see monkey do effort. you have
taken no thought in how this page would be used"* / *"the layout is also
horrendous, just a case of dropping fields and cards wherever is the fastest and
easiest"* / *"more of a very early beta dev page, not a production page that
allows the user to command the camera and get it's image quickly and easily"*.

He was right, and the tell is that the card order **was the commit order** —
Unit+button, Transfer, On the device, Recent attempts, Image — each appended as
the endpoint it wrapped landed. The page was a map of pac-host's API, not of
anything a person wants to do.

Measured live at 1600x1000 before the rewrite:

| | |
|---|---|
| camera pane | 816 px wide at x=251 — **533 px of viewport empty** |
| image top | y=689 in an 884 px pane — **~55% of the picture below the fold** |
| image rendered | 476x358 from a **320x240** source — 1.49x, non-integer, soft |
| heading order | Transfer, On the device, Recent attempts, **Image (last)** |

Plus: three `x-if`'d cards so the page reflowed and the download button moved as
state changed; TWO download buttons (`cameraFetchDevice`, `cameraRefetch`) doing
one job because they came from two endpoints; and no glanceable state — three
cards had to be read to learn "idle, last picture 12h ago".

### The layout — stacked on one centre axis, NOT two columns

```
+--------------------------------------------------------------+
|              +--------------------------------+               |
|              |                                |               |
|              |   image, integer 2x, 640x480   |               |
|              |   hairline border + shadow     |               |
|              |   NO surface behind it         |               |
|              +--------------------------------+               |
|                                                               |
|          BNCH !8cee336b . 01 Aug 06:47 . 7.0 kB . pid 1       |
|                                                               |
|              [ Unit  BNCH v ]  [  TAKE PHOTO  ]               |
|              caption                                          |
|              +--------------------------------+               |
|              |  STATUS            idle/running |              |
|              +--------------------------------+               |
|              Stored images (9) [ v ] [Download again]         |
|              [ ping ][ status ][ config ][ reboot ]           |
|              > Diagnostics                                    |
+--------------------------------------------------------------+
```

**The picture is the page.** It is first and centred; the controls stack
**beneath** it in a centred column **exactly as wide as the image (640 px)**, so
image and controls share one centre axis.

**A first attempt put the picture and a control rail side by side** and Peter
rejected it: *"dont like the layout with the image in the left column of a 2
column layout. the image should be centreted and at the top of the page. the
controls should be below. it does not look good, looks more like you have tried
to squeeze everything into 1 row."* Two columns solved the wasted-width problem
by filling the width with controls, which is not the same as giving the picture
the page. Do not reintroduce a side rail.

### No surface behind the photograph

The image gets a **hairline border and a shadow, and nothing else** — a print
laid on the page. `border-base-300 shadow-md`, no background, no padding, no
card. Beneath it sits a monospace caption strip reading like a contact-sheet
annotation.

**A dark "mat" was tried twice and rejected twice.** First full-bleed —
measured at 1600x1000 as **1337x523 around a 640x480 image: 56% empty, with
348 px black bars either side**. Then hugging the picture as a 17 px frame
(674x515, 11% empty). Peter, at the first: *"why is there a black box
surrounding the image?"*; at the second: *"fix it"*. Both were the same mistake
in two sizes. The picture is the only thing on this page that needs looking at,
so nothing is placed behind it to compete.

**Do not reintroduce a background surface behind the `<img>`** — not
`bg-neutral`, not a `card`, not a tinted panel. The empty and no-unit states DO
get their own quiet dashed placeholder (`border-dashed bg-base-200/40`), because
there is no photograph there to be the subject.

**The image is 640 CSS px = exactly 2x integer scale** of the 320x240 source,
centred. Not "as wide as the page allows": the old 476 px was a 1.49x
non-integer upscale, which is the softness Peter was looking at, and blowing a
low-res sensor frame across 1300 px is worse, not better. The size is a choice
about the *source*, not about the container.

**Written `w-[640px] max-w-full`, NOT `w-full max-w-[640px]`.** The wrapper is
`w-fit`, so a percentage width is circular — it collapsed the picture to 322 px
(1.01x), *smaller than the 476 px this whole task set out to fix*. Measured, not
predicted. `max-w-full` keeps it shrinking correctly on a phone (355 px at 390
wide).

### The control column (beneath the picture, centred, 640 px)

- **Unit** `<select>` — `controlTarget`, options from `controlDevices()`,
  labelled `cameraLabel(num) || d.label` so the **id is visible** (short names
  are not unique; both units currently report GARG).
- **Take photo** — `cameraGrab()`, full width, the only primary button on the
  page. Caption states what ONE PRESS does; see below.
- **Status block** — fixed `min-h`, always present. Renders `idle_text` when
  nothing is in flight, or per-transfer `chunks_text` / `percent_text` / bar
  while one is. **idle -> running -> idle must not move anything on the page.**
- **Device controls** — the server's shortcut verbs, rendered from
  `controlShortcuts()` (currently `ping`, `status`, `config`, `reboot`) through
  the existing `sendControl(verb)`. The list is **not** hardcoded here; that is
  the same invariant the Command sub-tab holds. Peter, 2026-08-01, on why these
  are duplicated from the Command sub-tab: *"why? this is the camera page."* When a photo does not come
  back, whether the unit is awake and alive is the first question, and making
  the operator switch tabs to ask it is the same card-hopping the rest of this
  rewrite removes. Duplicating a *control* is not a fault; forcing a tab switch
  is.
- **Diagnostics** — a closed `<details>` holding Check device + the device row,
  Recent attempts + `history_note`, and the per-transfer repair/dupe/cursor
  detail. These are diagnostics, not the page.

### One download action

`cameraFetchDevice()` and `cameraRefetch()` both POST
`/alarm/image/<num>/<pid>/fetch`. They are merged into **`cameraDownload(pid)`**
— one confirm, one toast, one label vocabulary. Two call sites remain (the
selected stored image under the picture; the device-held pid under Diagnostics)
because they are genuinely two situations, but they are one code path.

### Image identity

- `<img :src>` binds the **server-built** `img.url`
  (`/alarm/image/<num>/by-id/<id>`, served by `alarm-image-api.js`). The browser
  never constructs an image URL, and never talks to pac-host.
- `:key` is `img.key` (`pid-savedAt`), **not** `pid` — one unit lists 7 images
  under 3 distinct pids, and duplicate `x-for` keys froze the message feed once
  already.
- The timestamp reads **"saved"**, never "captured": `savedAt` is when the bytes
  were stored, not when the shutter fired.
- **pid 1 is marked as the device's test image**, cited to firmware
  (`TEST_IMAGE_PID = 1`, `TEST_IMAGE_LEN = 7156`, and `camPidFromCrc()` excludes
  it). It *is* a real photograph — used as embedded test data. See
  `alarm-images.md` for why this label was written, removed and restored.

**Every string on this page is server-computed** by `src/alarm-images.js`. This
file formats no counts, no percentages and no elapsed times. The rewrite adds no
derived state: it only chooses which already-pushed string goes where.

### The Take photo caption still says it does not upload — and why

Peter's first complaint was *"what is the point in a [Take Photo] Button if
there's no way to download it?"*, and the answer he is owed is one press that
ends with the picture on screen. **That is not in this task, and not because it
was deferred for convenience.**

`cam grab` captures and stages; a separate `push <pid>` transmits; and `cam
grab` **replies with nothing**, so the pid is only knowable ~77 s later via a
`push stat` radio call. Probed live 2026-08-01: pac-host has no
capture-and-upload operation — `GET /v1/mesh/camera` and `/v1/mesh/verbs` both
**404**. node-dash polling the device and then driving the upload would put mesh
orchestration in the dashboard, which is the boundary `PLUGIN_BOUNDARY_SPEC.md`
and CLAUDE.md exist to hold.

So the caption keeps its `text-warning` qualifier until services expose the
operation (xsession #59/#61). **The rail is built so that when it lands, the
button's second half drops in with no re-layout** — same button, same position,
the status block already sized for a running transfer.

## Invariants

- **Camera renders only what `alarm-images.js` pushed.** No count, percentage or
  elapsed time is computed here, and elapsed times must not tick locally.
- **A percentage is shown only when the server sent one.** `count` is null until
  the manifest arrives — measured as half the transfer on pid 17602 — and
  `"6 chunks, total unknown"` is the correct rendering in that window. Never
  `"6 / 0"`, never `"100%"`.
- **Take photo confirms before transmitting.** It replaces the device's stored
  image and puts a command on air.
- **Take photo must never claim to deliver an image.** One press captures and
  stages. The caption's `text-warning` qualifier is load-bearing and may only be
  removed when a real capture-and-upload operation exists upstream — not when
  the wording feels awkward.
- **The picture is first, full width, and centred.** Nothing may be inserted
  above the picture, and nothing may be placed beside it. Every card that once sat
  above it is why this task exists; the side rail that briefly replaced them was
  rejected for the same reason.
- **The status block never changes the page's geometry.** It is always present
  with a fixed minimum height; `idle -> running -> idle` must not move the
  download button, the dropdown, or the picture.
- **One download code path.** Any new download affordance calls
  `cameraDownload(pid)`. Two buttons that POST the same endpoint under different
  labels is the defect this replaced.
- **The image is capped at 2x integer scale (640 px).** Uncapping it to fill the
  column re-introduces the non-integer upscale this task removed.
- Never renders as, or alongside, the chat message feed (`tab-messages.html`)
  — command traffic is not chat, even though it rides on Meshtastic text
  messages underneath (Peter, 2026-07-25 — see task
  `custom-app-extension-point` notes).
- Renders exactly what `controlMixin` computes; no verb list, unit filter, or
  confirmation logic lives in this file.
- Yagi Align renders exactly what `alignMixin` computes — no quality/trend/
  best/bar math anywhere in this file, same discipline as the Command
  sub-tab, per `docs/modules/app-align.md`.

## Test notes

Verified live 2026-07-25 against the real pac-host service and the real
bench unit: unit picker showed exactly BNCH/GARG, shortcut send round-tripped
a real queued command visible in the ledger, both themes, 0 console errors.
GARG's confirmation dialog fired with the correct message and was dismissed
(not accepted) — confirmed no command reached GARG's ledger.

Pending/Executed split + since + sort re-verified live 2026-07-25: sent two
real commands to BNCH (`ping`, `status`) via the actual `/nodes/:num/pac-command`
route; the second was screenshotted mid-flight showing `status:'pending'` in
the Pending card with a live `since` value ("6s ago", "21s ago", "51s ago"
across three reloads) before it resolved to `acked` and moved to Executed.
Executed card confirmed newest-first ("1m ago" → "38m ago" → "59m ago" → "1h
ago", strictly descending). Both themes screenshotted and read.

Yagi Align verified live 2026-07-25 against a real, already-running align
session: target picker adopted the live target without a click, RUNNING
badge correct, a real PING against BNCH showed the bursting UI (disabled
controls, "GATHERING 0/4" spinner) and recovered correctly to the
"No replies — try again." warning state (BNCH's wake window is narrow —
expected per mt-transport, not a bug). Both themes screenshotted and read.
A real landed reading and its bar/quality rendering were not observed — no
on-air reading has landed for either test unit yet (mt-transport's own
caveat); re-verify once one does.

**Real bug found and fixed during this task**: the N-burst `<select>`
displayed `1` instead of its actual state value (`4`) on initial load — an
`x-model` vs nested `x-for`-generated `<option>` timing race, confirmed via
direct DOM inspection (`.value`), not a screenshot guess. Fixed with an
`x-init` post-mount resync; see `docs/modules/app-align.md` for the full
diagnosis.

## Out of scope

- Any fetch of any kind — see Layout. This page has never made a network GET
  and must not gain one; all data is `pacHostStatus`/`pacHostQueues`, pushed.
