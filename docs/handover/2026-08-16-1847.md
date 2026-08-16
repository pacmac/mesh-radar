# Handover — 2026-08-13, late evening

Written from `/usr/share/pac/dev/projects/mt-radar/node-dash`, branch
`feat/alarm-transport-plugin`. Previous handover archived to
`docs/handover/2026-08-13-2237.md`. **That one was written by the session I took
over from, four hours ago** — I ran `/handover read` against it, and three of its
claims turned out to be wrong. Expect the same of this one.

**LEAD WITH THE DEFECT — B114: mesh-gw's `signal_update` events are being silently
discarded by the browser.** Two producers emit the same event type with different
shapes. Ours is `{type, data:{signal_num, rssi, snr, ts}}`
(`active-tracker.js:124` → `ws-relay.js:854`); **mesh-gw's is FLAT** —
`{type, __ble_addr, addr, from_num, snr, rssi, hops}`, measured on both `:8001`
and our own `:8000`. `public/app-ws.js:559` reads `ev.data`, so for every
gw-originated one the guard fails and the event is dropped with no error and no
log. Full detail under REMAINS. It was invisible until `2db85be` because the test
connection died before the event ever arrived.

**Second: `npm run check` is RED, honestly so.** 9 of 10; `node_api` has **2**
real failures — B114 above and B93 — down from 5.

**Third: read GOT WRONG before trusting anything here.** I ran `/handover read` on
the previous document and then repeated one of its unverified claims to Peter as
my own within the hour.

**Fourth — the config damage, which is NOT breaking and is deliberately not the
lead.** Peter, 2026-08-14: *"none of these are breaking."* A test wrote **15**
Class-1 example payloads into production config, not the 12 the previous handover
accounted for. It is a **restore-when-convenient**, not a fault:

- **Wrong, needs Peter's values:** `radar.log_scale=false` (rings equi-spaced;
  the requirement is compressive/quantile), `tilt.zero=0`/`tilt.north_angle=0`
  (a calibration that is exactly zero on both axes is not one), OMNI `color=blue`
  (the YAGI holds `info`, a DaisyUI token — `blue` is the test's literal).
- **Indistinguishable from correct:** `alerts.smtp_port=587`,
  `radar.max_range_km=100`, `radar.crosshair=true`, OMNI `gain_dbi=8`,
  `cable_loss_db=1`, `is_primary=true`, auto-purge `02:00`. Each is plausible and
  happens to equal the example payload. **There is no before-snapshot, and that
  is the real damage** — not the values themselves.
- **Gone regardless:** `range_test_log` is 0 rows (a Class-1 op is a DELETE).
- **Not ours:** it also wrote mesh-gw's `ble.admin_passkey_refresh_s=240`.

The two that *did* have effects are already stopped: `tilt_high` was firing on the
zeroed calibration and `node_offline` was emailing hourly on threshold 0.0 — both
rules disabled. To reverse: `node_offline enabled=1 threshold=0.0 cooldown=60`,
`tilt_high enabled=1 threshold=(null) cooldown=30`.

---

## AUDIT — every task I touched, verified against the repo

| task | verdict | evidence |
|---|---|---|
| `tick-ignored-ages-frozen` | **closed, but the premise was WRONG** | the tick was never the fault; renamed mid-task and shipped as `cdf8b56`. See GOT WRONG |
| `alarm-transport-boundary-doc` | **closed** | `docs/ALARM_TRANSPORT_BOUNDARY.md` exists, linked from CLAUDE.md + alarm-host spec, `20ca78f` |
| `decouple-alarm-from-dash-modes` | **closed** | `grep dashMode src/alarm-*.js` → comments only; `21e2432` |
| `serve-bridge-link-freshness` | **closed** | `c7d3a4f`; flip proven by measurement, see SHIPPED |
| `render-link-staleness-control-page` | **closed** | `1b39839`; four screenshots, real stale state |
| `node-api-check-payload-limit` | **closed** | `2db85be`; node_api 5 failures → 2 |
| `park-browser-timers-and-derivation` | **created, parked** | Peter's words verbatim in its goal note |
| 8 × `ltc-*`, `set-yagi-az` | **still mis-filed, untouched** | unchanged for a second handover — needs Peter |

**I did not audit the other ~100 open tasks.** The previous handover didn't
either. Nobody has, and the list is long enough that "open" means little.

---

## STATE — re-queried 21:37:37Z

- **node-dash** — `online`, **24 restarts** (most of them mine tonight), `:8000` → 200.
- **bridge** — `online`, 21 restarts, `:8790` → 200. Device's; they restart it without warning.
- **pac-host** — `stopped`. Retired 2026-08-12, intended.
- `:8001` `/health` → 404 — **normal**, mesh-gw serves no `/health`. Use `/bridge_config`.
- **Tree:** clean but for `doc` (a pre-existing symlink, not mine) and the new archive file.
- **Branch:** `feat/alarm-transport-plugin`, **204 unpushed**. Nothing pushed tonight.
- **The rotator** was at az 159 when last read; it moves on device's schedule and ours. Shared.
- **`ecosystem.config.cjs:8` declares `watch: ["src"]` while the running process reports
  `watch = False`.** CLAUDE.md is right about the runtime. A `pm2 delete && pm2 start
  ecosystem.config.cjs` would silently re-enable it and restore the hazard where an
  edit to `src/` mid-transfer kills a run.
- **Context:** this session ran long. Everything after `c7d3a4f` deserves re-reading.

---

## RESOURCES

Every invocation below was run from the repo root **tonight**, and the traps are
things that actually cost me time.

| resource | invocation | trap |
|---|---|---|
| bridge CORE feeds | `ws /health`, `ws /state`, `ws /stats` on `:8790` | **these are SOCKETS, not GETs.** `/state` is ONE socket for every unit, keyed `!hex`, plus `servedAt`. Reading them as GETs was the bug fixed in `cdf8b56` |
| bridge route list | `curl -s localhost:8790/schema` | 20 paths. `/dash/sections` is the ONLY one that refuses a WS upgrade (404) — that is by agreement, see PEERS |
| feed tick | `curl -s localhost:8790/health \| jq .feedTickMs` → `10000` | **never hard-code it.** `null` means the tick clock is OFF, and must not be defaulted |
| our WS | `ws://127.0.0.1:8000/events` | connect replay is **4,274,469 B in 65 frames**. `node_list` alone is 1,327,981 B |
| tapping our WS from node | `new WS(url, {maxPayload: 100*1024*1024})` | without it the `ws` lib dies on the first oversized frame and you lose everything after it |
| store | `sqlite3 data/node-dash.db` | `PRAGMA table_xinfo`. `nodes` has `hops`, not `hops_away` |
| live config | `sqlite3 data/node-dash.db "select key,value from config where ..."` | this is where the corrupted values live; `device_cfg.<MAC>` is a JSON blob |
| alert rules | `curl -s localhost:8000/alerts/rules` | body is FLAT `{enabled, threshold, cooldown_minutes}`; **omitting `threshold` NULLS it** (`alerts-api.js:42`) |
| Playwright staleness | make `_onState` deaf, restart, wait past `silenceMs()` | **injecting the stale state from the console DOES NOT HOLD** — the 10 s push overwrites it between tool calls. Cost me four failed attempts |
| stall proxy | `scratchpad/stall-proxy.mjs` (symlink `node_modules` in first) | works, but node-dash **cannot be repointed at it**: `pm2 restart --update-env` will not inject `ALARM_HOST_URL` and `ecosystem.config.cjs` declares no such key |
| xsession | `python3 /usr/share/pac/dev/py/xsession/xs.py inbox` | `-c <channel>` goes **before** the subcommand, not after |

---

## PEERS — re-run 21:37Z, then I wrote to plugins, so plugins is at 41

| channel | latest | my cursor | peer cursor |
|---|---|---|---|
| `node-dash--plugins` | 41 | 40 | 38 (3 behind — they have NOT read my correction) |
| `device--node-dash` | 19 | 19 | 12 (7 behind) |
| `mesh-gw--node-dash` | 20 | 17 | 16 |
| `node-dash--services` | 97 | 95 | **FROZEN** — read, never write |

**OPEN ON ME, both from plugins, neither answered tonight:**

- **`[alarm-is-not-motion]`** — class `alarm` is a PORT classification, not motion.
  Now permanently recorded in `docs/ALARM_TRANSPORT_BOUNDARY.md`, but **their item
  is still open and I never replied to it.**
- **`[which-unit-json-null]`** — they need a unit and timestamps. Two previous
  sessions' taps were unusable. Still unanswered.

**Waiting on peers:** `[rebroadcast-full-packet-contents]` and
`[tick-carries-no-sequence]` (device, both effectively answered in conversation but
not formally closed), `[role-200-meaning]` and `[config-role-write-not-adopted]`
(mesh-gw), `[unclamped-timing-config]` (mt-radar).

**CLAIMS I MADE TO PEERS TONIGHT:**

| claim | to | status |
|---|---|---|
| "`/plugin/dash/live` carries no core tick" (a comment in OUR code) | plugins | **WRONG, corrected.** It ticks at the same ms as `/events`. Ledger B111 |
| "no derived field rides any feed I can see" | device | **WRONG, corrected by them.** `contact` rides `/state`; I was diffing the dash feed only |
| "we deleted `_statusesEqual`" | plugins, #41 | **TRUE, and it contradicts their advice** — they explicitly asked us to keep it. Sent tonight; **their cursor is 3 behind, so they have not read it** |
| `/dash/sections` stays a GET | plugins | **their answer, accepted**, recorded as an agreement in the spec with their reasoning |

**No leader in force.**

---

## SHIPPED — six commits, with the measurement for each

| commit | what | evidence |
|---|---|---|
| `20ca78f` | Meshtastic is the alarm's TRANSPORT, never its application | doc + two links; no measurement, it is a statement of Peter's |
| `eb7292a` | re-sync `browser-playwright-audit` | it hashes 30 files incl. CLAUDE.md — caught by check_specs AFTER I committed. See GOT WRONG |
| `cdf8b56` | subscribe to `/state` + `/health` instead of GETting them once; delete the change-gate | **31 `pac_host_status` + 29 `node_status_update` in 45 s**, `servedAt` advancing exactly 10.000 s apart. `servedAt` rides only `/state`, so its arrival proves the new socket feeds the browser |
| `21e2432` | the alarm no longer touches the dash mode | `grep` shows no `dashMode`/`PASV`/`ACTV` in any alarm file bar comments; core still has no alarm reference |
| `c7d3a4f` | serve a link-freshness verdict driven by silence | flip measured with a deaf handler: `fresh=false`, `"last state body 1m ago"`, **nothing arriving**. Healthy: 27 pushes / 32 s, ONE distinct link state |
| `1b39839` | the Control page says when its data is stale | four real screenshots, genuinely stale, both themes both sizes, age advancing 36s→44s→50s→1m |
| `2db85be` | state the test client's own frame limit | node_api **5 failures → 2** |

---

## REMAINS — with the next action

### BUG - config Peter must restore, 15 ops not 12

See the top of this file. **Also unaccounted for by anyone until tonight:**
`tilt.zero`/`tilt.north_angle` (a wiped calibration, and `tilt_high` was firing on
it), `auto_purge` on at 02:00, `ble auto_connect`, the mesh-gw passkey write, and
the `range_test_log` DELETE. Discovery config was overwritten too, **but discovery
was NOT newly enabled** — traceroutes ran at ~42/hour for 48 h across the write
boundary, unchanged. Do not report that as an incident.

### BUG - B114, two producers emit `signal_update` with different shapes

The one genuinely new product defect found tonight, and it was **invisible until
`2db85be`** because the connection died before the event arrived.

- ours: `{type, data:{signal_num, rssi, snr, ts}}` — `active-tracker.js:124` → `ws-relay.js:854`
- **mesh-gw's: FLAT** `{type, __ble_addr, addr, from_num, snr, rssi, hops}` — measured on both `:8001` and our own `:8000`

`public/app-ws.js:559` reads `ev.data`, so every gw-originated one is **silently
discarded**. Next action: find where node-dash forwards gw events verbatim — it is
not an explicit line, `grep` finds no forward outside ws-relay's rotator wiring —
then rename one of the two. Do **not** "add `data`" to the gw shape; the collision
is the defect.

### GAP - the connect replay is 4.27 MB

`node_list` 1,327,981 B, `env_history` 1,097,569 B, 65 frames. Browsers cope; it
is still weight on every connect, and B92 never named `node_list` at all. Needs
its own task.

### BUG - B93, typed traceroute event unhandled in `index.js`

The other surviving `node_api` failure. Long-standing, untouched tonight.

### BUG - B113, a spec documented a test that never existed

`docs/modules/alarm-socket-watchdog.md` described `tests/test_socket_watchdog.mjs`
and its four assertions. **The file has never existed** (`find . -name
"*watchdog*"` → the doc only). The watchdog shipped in `6553528` therefore has no
repeatable proof. The spec now says so and keeps the assertions as its
specification. **I audited every other spec: 16 test/script paths named, 15 exist,
and the one apparent miss is a false positive.** This is a single defect, not a
pattern.

### GAP - the browser still calculates — PARKED at Peter's instruction

41 timers and `Date.now()` arithmetic across radar, node list, messages.
`park-browser-timers-and-derivation` holds Peter's words verbatim. **Order is
forced: serve every value first, delete timers second**, or every countdown
freezes. `public/app-perf.js:82` is worse than a render timer — a browser tab
scheduling **mesh transmissions**.

### DECIDE - align ownership, and what leaves with the alarm

Peter is considering moving the alarm out of node-dash entirely. Tonight's
measurement: core references the alarm in 17 files but **15 are comments**; the
real coupling is `src/index.js` (2 lines, by design) and **`src/coulomb.js:13`
importing `getObs` from the plugin — for a function that always throws.** The
units stay visible here regardless, because our radios hear them; that is
transport.

---

## ASKED — Peter's questions, and whether the product answers them

- *"is that clear and this needs putting somewhere you can never forget"* — now in
  `docs/ALARM_TRANSPORT_BOUNDARY.md`, CLAUDE.md, the alarm-host spec and my memory.
- *"I don't know if it's stale"* — **answered tonight**, backend and page. This was
  the session's actual deliverable.
- *"when was it last heard, is its beat on schedule"* — the data is now held live
  (`/state` carries `measured.beat.meanMs`, `errorMs`, `contacts`, `contact.*`).
  **It is not yet rendered anywhere.** That is the obvious next feature and the
  reason he keeps asking an agent instead of the page.

---

## GOT WRONG

**I repeated the last handover's framing without checking it, and told Peter three
payloads "never arrive at the browser".** They arrive. The 1 MiB cap is
`websockets.connect`'s own `max_size` default in the Python test client. I had
read that claim in a document, found it plausible, and passed it on as my own
within an hour of running `/handover read` — which exists precisely to stop that.
*Class: inheriting a claim while performing the ritual of verifying it.*

**I committed a doc before `check_specs` passed**, then discovered
`browser-playwright-audit` hashes CLAUDE.md. I had chained the validator with `;`
instead of `&&`, so its failure could not stop the commit. *Class: a gate I ran
but did not let block me.*

**My first Playwright check used a selector wider than my claim** — any
`.alert-warning` — and reported the banner visible when what was visible was a
pre-existing "Camera unavailable" notice. Same class as this repo's standing
warning about greps wider than the claim they support.

**I burned four attempts injecting browser state** that the live 10 s push
overwrote each time, reading it twice as a rendering bug in markup that was
correct.

**I asserted the interlock was "a protocol to design"** between the alarm and the
radar. Peter corrected it: there is no protocol, they exchange nothing, it is
hardware arbitration. I had accepted a relationship as real because code
implemented it — dead code, as it turned out.

**I framed the mode decoupling as migration preparation.** Peter: *"it makes no
diff if alarms is moved to a new server or not."* The change is correct on its own
terms; recording it as migration prep implies it would be optional if the alarm
stayed.

---

## AVOID

- **`/handover read` is not a ritual.** Its own rule — every line is a claim — applies
  to the claims you then repeat to Peter an hour later.
- **Chain validators with `&&`, never `;`.** A check that cannot stop the commit is decoration.
- **Injected browser state does not survive a 10 s push.** Make the condition real.
- **Grep as wide as your claim, and no wider** — `.alert-warning` is not "my banner".
- **A feed and an event stream are different things.** `/events` says what HAPPENED;
  `/state`, `/health`, `/stats` say what is TRUE and rebuild on every push. Only the
  second kind can answer "is this current".
- **A verdict that depends on the feed cannot report the feed dying.** Derive staleness
  from silence, on our own clock.
- **`null` is not `false`.** An unjudgeable link rendered as "stale" is a false alarm,
  and a false alarm trains the reader to ignore the true one.
- **Before writing "X never reaches the browser", check whose limit you are quoting.**

---

## SKILLS

**Standing (enforced by CLAUDE.md):** `/idiot`, `/xsession`, `/terse`, `/park`,
`/handover`, `/playwright`, `/hallucinate`.

**Situational tonight:** `/handover read` (opened the session — and see GOT WRONG),
`/xsession` (5 messages sent, 2 items raised, 1 correction owed and sent),
`/park` (once, at Peter's instruction), `/playwright` (the banner, four captures),
`/vomit` (invoked by Peter after a reply buried the answer — **should stay in force**).

---

## TASKS

| task | phase | spec |
|---|---|---|
| `park-browser-timers-and-derivation` | **parked**, investigate not started | — |
| `park-align-ownership` | still Peter's decision, second handover carrying it | — |
| `bugs` | ledger — **B105–B114 added tonight** | — |
| 8 × `ltc-*`, `set-yagi-az` | mis-filed / unverifiable, **second handover carrying this** | needs Peter |

## CHECKS — 21:38Z

```
python scripts/check_specs.py     All specs current.
node scripts/check_snapshot.mjs   54 checks across 6 windows, 0 mismatches
node scripts/check_contract.mjs   Contract clean.
node scripts/check_no_cache.mjs   6 responses, nothing cacheable.
node tests/test_coulomb.mjs       9 checks, coulomb model clean.
node tests/test_served_time.mjs   7 checks, served-time clean.
npm run check                     9 of 10 passed, 1 FAILED: node_api
python3 tests/test_node.py        FAIL — 2 (B93, B114). Was 5 before 2db85be
tests/test_ops.py                 NEVER RUN — writes live config. Its exclusion note in
                                  check_all.mjs is FALSE and still says nothing was written (B110)
tests/test_playwright.py          not run this session
tests/test_socket_watchdog.mjs    DOES NOT EXIST — B113
```

**Nothing invokes `npm run check` automatically.** Whether a git hook should is
Peter's call; a pre-commit hook needing the service up would block commits
whenever node-dash is down.
