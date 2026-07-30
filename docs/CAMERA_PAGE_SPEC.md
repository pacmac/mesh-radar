# Control > Camera — watch a picture arrive from the garage

Peter, 2026-07-29: *"what about the new Camera sub menu?"* … *"we already have the old chunk
page dont we, that is the one that should be Camera"* … *"the one that handled uploads from
the device and displayed the images"*.

mcpp task `camera-page`. Predecessor: `reference/alarm-integration/public/push.html` (547
lines, archived 2026-07-23). Contract source: services on xsession `[ui-gaps-control-images]`.

---

## 1. What is buildable today, and what is not

| capability | route | status |
|---|---|---|
| live transfer progress | `GET /v1/mesh/images/<t>/progress` | **live**, 1.2 ms, synchronous |
| take a photo | `POST /nodes/:num/pac-command {verb:'cam'}` | **live** — existing plugin router |
| command outcome | `pac_host_queues` WS | **live** — already pushed |
| **show the picture** | `/images/<t>` and `/images/<t>/<pid>` | **BLOCKED** |

Both image routes are **radio round-trips**. services, confirmed from their source:

> `images.js get()` goes straight to `_startTransfer` — it does **not** check the store first,
> even for a pid whose bytes we already hold on disk. So today there is **no fast path to an
> image at all**: not to the list, and not to the bytes.

Measured: `/images/<t>/99999` took **75.02 s** before they fixed the pid check; `/images/<t>`
returned nothing in 25 s. A page cannot open on either.

They are building a fast stored list plus a store-before-radio `get()`. **The image panel is
specced here and built when that lands** — not stubbed with a fake.

**So this page ships as: pick a unit → Grab → watch the chunks arrive.** That is the half that
answers "is the camera working", and it is the half that was completely absent.

## 2. Where the code lives — plugin, not core

The alarm is a plugin (`docs/PLUGIN_BOUNDARY_SPEC.md`). Backend goes in a plugin-owned file
and registers through the existing hooks:

| file | role |
|---|---|
| **NEW** `src/alarm-images.js` | polls `/progress`, formats, pushes over WS. Plugin-owned. |
| `src/pac-command-api.js` | already mounted; Grab reuses it. **No new route.** |

**Browser: Peter chose option A** — Camera becomes a seventh Control sub-tab alongside the
existing six, in the core partials.

> **This is a knowing exception, not an oversight.** `public/partials/tab-control.html` is 290
> lines with 41 `alignModel` references — it is already **100 % alarm UI in a core file**, and
> `drawer-sidebar.html` hardcodes all six sub-tabs. There is **no hook for a plugin browser
> page**; the three hooks built on 2026-07-29 (`registerNodeSection`, `registerWsWiring`,
> `registerConnectReplay`) are all server-side. Adding Camera is consistent with a
> pre-existing breach at full strength rather than a new one. Peter's decision, recorded:
> *"A now"*. The browser-descriptor mechanism is its own task — logged in the `bugs` ledger.

## 3. BROWSER_CONTRACT — the browser never polls

`/progress` is polled **by the backend**, formatted **by the backend**, pushed over WS.
The page renders strings. No `fetch` on a timer, no on-demand GET — the same rule that made
`pac_host_queues` a push and not a click-triggered fetch (a real bug, Peter, 2026-07-25).

WS message, replayed on connect and broadcast on change:

```js
{ type: 'alarm_images',
  units: { "<num>": { id, label, state, text, transfers: [ …display-ready… ] } } }
```

## 4. The honesty constraints — every one of these is a defect someone already paid for

**`transfers: []` MEANS IDLE.** 200 and nothing in flight. Not an error, not unknown. The page
must distinguish *"nothing is happening"* from *"we cannot say"*. (services, contract point 1.)

**`count` IS null UNTIL THE MANIFEST ARRIVES, and `percent` is null whenever `count` is.**
Never substitute 0. Render `"6 chunks, total unknown"`, never `"6 / 0"` and never `"100%"`.
services' own progress log printed `1/0 chunks (100%)` this morning and they refused to let it
back in through a new door. push.html hit the same thing from the other side: `count: 0` is
**not** a manifest, and treating it as one logged `MANIFEST count=0` then suppressed the real
one when 32 arrived.

**NEVER render "your transfer".** auto-adopt starts a transfer for any pid seen pushed, so a
row is not necessarily one anybody requested. services, verbatim: *"the honest answer today is
that we do not hold enough identity to make that claim."* The page says *a* transfer.

**GRAB CAPTURES A NEW IMAGE AND REPLACES THE ONE IN FLASH.** The button says so, and it
confirms before transmitting. services made this mistake themselves — pulled a stale frame
believing it was fresh.

**NO VERDICTS.** `"last chunk 8s ago"` is a formatted elapsed time. Whether that constitutes a
stall is a server judgement and the server does not publish one. push.html carried this rule
explicitly and it still holds.

**THE UNIT PICKER KEYS ON `id`, AND SHOWS IT.** Both units currently report `shortName: GARG`
— a **firmware** defect, same root cause as the PKI failure (B79): one `secrets.h`, one key,
one short name, one image flashed to two boards. services cannot fix it in the payload without
inventing an identity the device does not have. `id` is unique and stable.

## 5. What the page shows

```
Unit  [ GARG !8cee336b ▾ ]        [ Take photo ]

TRANSFER          idle
                  no transfer in flight

— or, while one runs —

TRANSFER          6 chunks, total unknown      ← count null: no percentage invented
                  pid 60739 · started 4m 12s ago
CHUNKS            6 received · 0 repairs · 29 dupes
DEVICE CURSOR     6                            ← the device's own view, beside ours
LAST CHUNK        8s ago                       ← elapsed, not a stall verdict

IMAGE             not available yet — pac-host has no fast read for stored
                  images; both image routes are radio round-trips (services,
                  2026-07-29). Specced in §1, built when their stored list lands.
```

Command outcome comes from the **existing** `pac_host_queues` feed — press Take photo, watch
the ledger settle `queued → trying → done/failed`. No new plumbing.

## 6. Files

| file | change |
|---|---|
| **NEW** `src/alarm-images.js` | poll `/progress` per unit, format, push `alarm_images` |
| **NEW** `public/partials/tab-control-camera.html` | the sub-tab body |
| `public/partials/tab-control.html` | one tab link + one `x-show` block |
| `public/partials/drawer-sidebar.html` | one sidebar entry |
| `public/app-control.js` | `cameraGrab()` — POSTs the existing pac-command route |
| `public/app.js` | `alarmImages` display cache |
| `public/app-ws.js` | consume `alarm_images` |
| `src/index.js` | `import './alarm-images.js'` — **static, top-level** |

**Static import, above `attachWsRelay`.** `registerWsWiring` is read ONCE; a late registration
silently never fires — measured 2026-07-29 as 0 live broadcasts in 110 s while connect replay
still worked. That failure is invisible from the UI.

## 7. Not changed

- `src/ws-relay.js`, `src/node-status.js` — core, and now free of alarm knowledge. They stay
  that way.
- The image routes. We do not call them from a page path at all until services ships the fast
  read; calling them would reintroduce the exact hang this page exists to avoid.
- `pac_host_queues` — the Grab receipt reuses it as-is.

## 8. Verification

1. `/progress` polling proved **reached**: stop the poller, confirm `alarm_images` stops.
2. Against a **real transfer** — press Take photo on a live unit and watch chunk counts advance.
   Not a fixture: an injected object proves the template, not the wiring.
3. `count: null` renders "total unknown" and **no percentage** — checked against a real
   pre-manifest transfer if one can be caught, otherwise stated as unverified.
4. `transfers: []` renders "idle", not an error.
5. **Plugin-absent test still passes** — unwire all `alarm-*` imports: zero `alarm_images`,
   zero `pac_host_*`, core WS set intact.
6. `tests/test_playwright.py` — `/control` still green, plugin-boundary audit still 12/12.
7. `check_specs.py` — `All specs current.`

## 9. Verification RESULTS (2026-07-30)

| # | outcome |
|---|---|
| 1 | **PASS** — connect replay carries a populated `alarm_images`, not `{}` |
| 2 | **PASS**, against pid 50108 — see below |
| 3 | **PASS** — `"0 chunks, total unknown"`, `percent_text: null`, indeterminate bar |
| 4 | **PASS** — `IDLE` / "no transfer in flight" on all three units |
| 5 | **PASS** — all three `alarm-*` imports unwired: 0 `alarm_images`, 0 `pac_host_*`, core set intact |
| 6 | **PASS** — 306 passed, 1 pre-existing failure (`invalid activeTab is replaced`, stale premise) |
| 7 | **PASS** — `All specs current.` |

**Item 2, the one that mattered.** It went unproven for a day, and the reason was
not our code. Until services' `e7e8492` (2026-07-30) pac-host keyed in-flight
transfers by a **raw, origin-dependent string** — a requested pull stored the
caller's path segment (`336b`), an adopted push stored the sender id
(`!8cee336b`). We polled the full id and were told `[]`.

Measured before the fix, 20:54:41Z–20:58:41Z: pid 17602 ran 1/12 → 12/12 and
saved a 2696-byte JPEG while this page displayed `no transfer in flight` for the
entire 183 s, with **zero** live broadcasts. Measured after, 22:14:53–22:15:52:
pid 50108 pushed ~20 consecutive live `alarm_images`, and two screenshots 20 s
apart with no interaction show `0 / 12 · 0%` → `6 / 12 · 50%`. No node-dash
change was required, on services' explicit advice.

**This also closes the interval-fires gap** — the same failure mode that bit
`alarm-ws.js` (replay working while live pushes silently never fire, invisible
from the UI). It is now measured rather than assumed.

## 10. What is still NOT built

The **Image card remains the honest placeholder**. services shipped the local
read on 2026-07-30 in `160a4a1` — `GET /v1/mesh/images/<t>/stored` (verified 200
in 1.8 ms, 5 images) and `/<t>/<pid>` serving from disk (verified 200 in 3.3 ms,
a real 320×240 JPEG). **node-dash calls neither yet.** Wiring the image panel is
a separate task; the placeholder stays until it lands rather than being reworded
to imply something that does not exist.

Caveat to carry into that task: `pid` is a uint16 and **recycles**, so a cached
pid is not guaranteed to be what the device holds now. Label the timestamp
"saved" (from `savedAt`), never "captured". `?refresh=1` forces the radio path —
minutes, and it costs a wake window — so it must never be reachable from a page
load.

Also outstanding, raised with services as xsession **#47**: every completed
transfer measured shows ~1 duplicate per chunk (32/29, 16/16, 12/12, 12/12),
i.e. roughly half the image airtime spent on frames already held.
