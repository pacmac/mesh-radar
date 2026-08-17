# Handover — 2026-08-16, evening

Written from `/usr/share/pac/dev/projects/mt-radar/node-dash`, branch
`feat/alarm-transport-plugin`. Previous handover archived to
`docs/handover/2026-08-16-1847.md`.

**LEAD WITH THE DEFECT — I DECLARED THE YAGI FIXED ON ONE SAMPLE AND IT IS NOT
CONFIRMED.** Re-measured at write-up time:

```sql
select date(ts,'unixepoch') day, tx_device, count(*) n,
       sum(case when status='ok' then 1 else 0 end) ok
  from traceroute_history where ts > strftime('%s','now')-3*86400
  group by day, tx_device order by day desc;
```
```
2026-08-16  (blank)              8   8    <- MY hand-run probes straight at mesh-gw, NOT node-dash dispatch
2026-08-16  E9:B0 OMNI         277  34
2026-08-16  F4:12 YAGI         433   1    <- one success, at 17:15:41
2026-08-15  F4:12 YAGI         594   0
2026-08-14  F4:12 YAGI         678   0
```

Since the change window (`ts > '2026-08-16 16:40:00'`): **YAGI 4 attempts, 1 ok.
OMNI 39 attempts, 2 ok.** Non-zero is qualitatively different from 2,778
consecutive zeros, so something did change — but four attempts is not a fix, and
the OMNI at 5% is itself far below the 19% it ran at earlier today. **Do not
report the YAGI as recovered. Re-run the query above before saying anything.**

**Second: my explanation for the five-day outage is unsupported, and Peter caught
it.** I claimed a channel-name mismatch (`Public` vs unnamed) took the YAGI off
the public mesh. Then `mqtt` vanished from the OMNI's channel list across a
mesh-gw restart with nobody removing it — the signature of a stale cache. **Every
channel reading I took before that restart came from the previous mesh-gw
process and may never have been the radios' truth.** The observation (YAGI
0/2778 while OMNI got 19% on the same targets) is from our own store and stands.
The explanation does not.

**Third: three things changed inside ten minutes and I cannot separate them** —
Peter renamed both primaries to `Public`, mesh-gw went down, mesh-gw came back.
The two replies I cited as proof landed minutes after the restart.

---

## AUDIT — verified against the repo, not against marks

| task | verdict | evidence |
|---|---|---|
| `signal-update-shape-collision` | **closed, verified** | `d2f9002`; `npm run check` node_api went 2 failures → 1 |
| `private-channel-resolver` | **closed, but SUPERSEDED same day** | `15d5804`, then rewritten by `c9640f1`. Its key-only identity was wrong — see GOT WRONG |
| `automation-verb-listener` | **closed, verified over the air** | `8cdbba4`; `@ping` → `pong YAGI …`, `@point` moved the rotator 105°→201° |
| `boundary-doc-states-fixed-violation` | **closed, verified** | `e37c7c8`; `grep -rn "dashMode.set" src/*.js` → no alarm file |
| `app-perf-persistset-global` | **closed, verified** | `0db1bf9`; sabotaged the global to throw, `perfSetExpert` still wrote |
| `channel-resolver-ssot-pub-pri` | **closed, verified** | `c9640f1`; 42 checks, live `device_list` shows `designated` per channel |
| `channel-callers-onto-resolver` | **closed, verified** | `a02b911`; live 400 without a channel, 200 with |
| `send-form-default-channel` | **closed, verified in a real browser** | `c87c93e`; switching radio re-resolves 1↔2, real send landed on ch 1 |
| `bugs` ledger | **99 steps, 8 complete** | I added steps 91–99 and disproved 74 |
| 13 × complete-but-unclosed | **NOT actioned** | incl. 8 mis-filed `ltc-*`. **Fourth handover carrying this** — needs Peter |

**I did not audit the other ~100 open tasks.** Nobody has, three handovers running.

---

## STATE — re-queried at write-up time

- **node-dash** — `online`, **42 restarts**, `watch=False`. `:8000` → 200.
- **mesh-gw** — **RESTARTED BY PETER at ~16:50 today.** It is NOT under pm2 here;
  it went down around 16:47 and node-dash logged `[bridge] WS error: ECONNREFUSED`
  until it returned. `:8001/` → 404 is **normal** (no root route); use `/devices`.
- **bridge** (alarm, device's) — `online`, `:8790/health` → `feedTickMs 10000`.
- **specboard** — online, 64 restarts. Not ours; a new `/specboard` skill appeared
  mid-session.
- **`automation.enabled = true`** — I turned it on. Code default is `false`. The
  `@verb` listener is LIVE on the private channel and answers anyone on it.
  Reverse: set that config key to `false`.
- **`channels.pub_key` / `channels.pri_key`** — new keys I created. `pub_key` was
  re-designated after Peter's rename (`865e781a56f3…` → `b7ecd210d6cd…`).
  **I had to do that BY HAND when he renamed a channel — that staleness is the
  open design flaw, see REMAINS.**
- **`channels.private_psk_fp`** — deleted by me; superseded.
- **Peter renamed both radios' primary channels to `Public`** during the session.
- **Tree:** clean but for `doc` (a pre-existing broken symlink, not mine) and the
  new archive file.
- **Branch:** `feat/alarm-transport-plugin`, **217 unpushed**. Nothing pushed.
- **Context:** this session ran very long. Everything after `c9640f1` deserves
  re-reading.

---

## RESOURCES — every command below was run from the repo root at write-up time

| resource | invocation | returned | trap |
|---|---|---|---|
| gw devices | `curl -s localhost:8001/devices` | 2 radios | **does NOT include channels** — that is a separate call |
| gw channels | `curl -s "localhost:8001/E9:B0:3F:17:27:91/channels"` | 2 configured | name+psk live under `settings`; `role` is PRIMARY/SECONDARY |
| gw device path | `%21` for `!hex`, or the full MAC | — | bare hex, short mac and short name all **404**. Only full MAC and `!hex` work |
| alarm bridge | `curl -s localhost:8790/health` | `feedTickMs 10000` | `:8790/` is 404; use `/health`, `/schema` |
| our WS | `ws://127.0.0.1:8000/events` | **59 frames, 2,903,449 bytes in 8 s** | needs `{maxPayload: 100*1024*1024}` or the `ws` lib dies on the first big frame |
| store | `sqlite3 data/node-dash.db` | 27 tables | the env table is **`environment_history`**, NOT `env_history` — ledger steps 1/2/3/6 all name it wrongly |
| rotator | `curl -s localhost:8000/rotator/status` | `az 121, variant v4, 2 targets` | two rotators configured (v4 .186 / v5 .195); one active |
| channel table, side by side | `python3` over `/{addr}/channels` computing `sha256(name+NUL+psk)` | see GOT WRONG | **mesh-gw may serve CACHED channel config** — readings changed across its restart |
| WS taps | `scratchpad/tap.mjs`, `tapdev.mjs`, `trwatch.mjs`, `rx.mjs`, `idcheck.mjs` | all ran | symlink `node_modules` into the scratchpad first |
| xsession | `python3 /usr/share/pac/dev/py/xsession/xs.py inbox` | 7 channels | `-c <channel>` goes **before** the subcommand |

**Do not pass message text to `xs.py` inside double quotes.** Backticks are
evaluated by the shell and silently ate seven words out of a message I sent to
plugins (corrected in #46). Pipe from a file.

---

## PEERS — `xs.py inbox` re-run as the last thing before writing this

| channel | latest | my cursor | peer cursor |
|---|---|---|---|
| `device--node-dash` | **24** | **19 — 5 UNREAD** | device=17 |
| `node-dash--plugins` | **48** | **44 — 2 UNREAD** | plugins=46 |
| `mesh-gw--node-dash` | 20 | 17 | 16 |
| `node-dash--services` | 97 | 95 | **FROZEN** — read, never write |

**I HAVE NOT READ 7 MESSAGES.** device seq 20–24 (`say`, and replies to
`rebroadcast-full-packet-contents`, `tick-carries-no-sequence`,
`events-is-not-a-state-feed`, `tick-contract-confirm`) and plugins 47–48. Read
them before doing anything else with those peers.

**Nothing is waiting on me** — the two items that were (`alarm-is-not-motion`,
`seven-routes-going`) are closed. `[alarm-is-not-motion]` was closed by plugins
within a minute of my answer.

**Waiting on peers:** `[config-role-write-not-adopted]` and `[role-200-meaning]`
(mesh-gw), `[unclamped-timing-config]` (mt-radar).

**CLAIMS I MADE TO PEERS THIS SESSION:**

| claim | to | status |
|---|---|---|
| "nothing here renders or counts the alarm class as motion" | plugins | **verified before sending** — `alarm-host.js:499-557`, `beat` and `alarm` share one arm. They closed the item |
| "we are off all seven doomed routes" | plugins | **verified** — every remaining mention is a comment (`alarm-host.js:161,236,704`) |

**No leader in force.**

---

## SHIPPED — with the measurement for each

| commit | what | evidence |
|---|---|---|
| `d2f9002` | the gw's flat `signal_update` consumed at the boundary | 9 → 0 in 60 s on our WS; guard disabled → 5 returned |
| `15d5804` | first channel resolver, key-only identity | **superseded by `c9640f1` the same day — its identity model was wrong** |
| `8cdbba4` | `@verb` listener on the private channel | over the air: `pong YAGI -30dBm 6.8dB 0hop 94%`; `@point` moved the rotator 105°→201°, held 30 s |
| `e37c7c8` | boundary doc described an already-fixed violation | 3 greps re-run, embedded in the doc |
| `c5f85f3` | channels test + two config keys declared | 26 checks, registered as `channels`; check_contract caught the undeclared keys |
| `0db1bf9` | app-perf imports `persistSet` | global replaced with a thrower, `perfSetExpert` still wrote |
| `6890cc3` | contract allowlist keyed by code, not line number | clean on the tree; still catches a planted `v > 5 ? "text-error"` |
| `155819b` | correction: shared key + different name ≠ one channel | 27 checks; **the reasoning behind it is now itself in doubt** |
| `c9640f1` | resolver is the SSOT, `(radio, pub\|pri)`, identity name+key | live `device_list` shows `designated` per channel; 35 checks |
| `a02b911` | nothing sends on a channel by accident | live 400 without a channel, 200 with; 14-check `send_channel` test |
| `c87c93e` | browser stops choosing a channel | real browser: switching radio re-resolves 1↔2; real send landed on ch 1 |

---

## REMAINS — with the exact next action

### THE NEXT TASK — `remove-alarm-from-node-dash`

**REMOVE MEANS MOVE. IT DOES NOT MEAN DELETE.** Peter, correcting me after I wrote
this task up as a deletion: *"remove DOE NOT MEAN DESTROY. the intention is it
will run as it's own pm2 service"*. The alarm becomes its own pm2 service
alongside node-dash, bridge and timelapse-pull. **The eight alarm/pac modules are
the new service's source, not scrap. Nothing is deleted until it is running
somewhere else and proven.** The task slug still says "remove" — read the title,
not the slug.

**Peter decided this at the end of the session.** The previous handover carried it
as *"Peter is considering moving the alarm out of node-dash entirely"*; asked
directly, he said **"he has decided"**. Start here.

The new service needs its **own pm2 entry, its own port, and a decision about its
store** — the alarm currently shares `data/node-dash.db` (`obs_observation`,
`obs_fact` live there). A separate service sharing one SQLite file is a choice,
not a default; `alarm-db-ownership` asked this once already.

**No such task existed.** He believed one did. I searched every mcpp task — open,
completed and parked — for `alarm`/`garage`; the nearest are *boundary* tasks
(`browser-plugin-boundary`, `custom-app-extension-point`), not removal, and
`purge-custom-alarm-code` is completed and was about alarm **node management**.
Either it was never written or it is mis-filed in another project — and
`active-project-flipped-mid-session` is an open item where nine tasks were
mis-filed, so check there before concluding it never existed.

**The coupling, measured 2026-08-16 — and the previous handover had this wrong.**
It said *"core references the alarm in 17 files but 15 are comments"*. Actual:
**seven** core files, and in **six of them every reference is a comment**
(`browser-plugins.js:61`, `format.js:106`, `node-status.js:36`,
`observatory.js:202`, `observatory-ws.js:3,11`, `ws-relay.js:233,250,1242`).

```bash
for f in $(grep -rl "alarm-\|pac-host\|pac-command\|pac-align" src/*.js \
           | grep -vE "src/(alarm-|pac-|coulomb)"); do
  echo "== $f"; grep -n "alarm-\|pac-host\|pac-command\|pac-align" $f; done
```

So the **only** real code coupling in core is `src/index.js`, 12 lines: `:7`
import, `:32-34` three routers, `:59-62` four side-effect imports, `:344-346`
three `app.use()`, `:470` `pacHost.start()`, plus `'/control'` in the page list at
`:240`. Line `:346` already carries the comment *"delete this line and the plugin
is gone"*.

**The browser is already clean.** Two references in core `public/` and **both are
prose** — a comment at `app-ws.js:68` and label text at `tab-cfg.html:600`. There
is **no `tab-control.html`**; the Control page is served by the plugin. Whoever
did the plugin-boundary work did it properly.

**The one thing that will bite — `src/coulomb.js`.** It imports `getObs` from
`alarm-host.js` (`:13`, used at `:60`), and it is imported by **both** sides:
`alarm-sections.js:34` (`coulombModel`) and **`ws-relay.js:64` (`buildCoulomb`) —
core**. So core depends on a module that depends on the alarm. Once the alarm is a
separate service this stops being "who owns the file" and becomes an **API
question**: if node-dash still shows a coulomb reading it must *ask* the new
service, not import a module. **That decision is step 1, before anything moves.**

**Also unresolved:** `obs_observation` and `obs_fact` — ownership not established.
`relay_observation` is core (packet provenance) despite the similar name.

### BUG - the YAGI is NOT confirmed recovered

Re-run the query at the top of this file. If YAGI `ok` is still ~1, it is not
fixed. Four attempts proved nothing either way.

### VERIFY - does mesh-gw cache channel config, and when does it refresh?

**This is the question that decides how much of today's work rests on sand.**
`mqtt` was in the OMNI's channel list at ~12:00 and gone at ~17:00 with nobody
removing it, across a mesh-gw restart. If its channel data is cached, every
pre-restart reading is suspect — including the unnamed-vs-`Public` primary that
the whole `channels.js` identity model was built from.

**This belongs to mesh-gw, not here.** Raise it on `mesh-gw--node-dash`; do not
work around it.

### BUG - the channel designation goes stale silently, and I fixed it by hand

`channels.pub_key` is a stored hash. Peter renamed a channel and it stopped
resolving; I re-derived it with a one-off script. That is exactly what he warned
against: *"any translation should come from that output and NOT be hard coded."*

**The agreed fix, not yet built:**
- `pub` needs **no config** — mesh-gw already reports `role: PRIMARY`. Derive it,
  delete `channels.pub_key`.
- `pri` keeps one stated fact but as a **name** (`channels.pri_name: "Private"`)
  matched against the live table, not a hash of a name we computed.

Peter was asked whether to proceed and had not answered when the session ended.

### GAP - antenna/radio selection is not in the SSOT

Still spread across `dash-mode.transmitterForMode()`, `getPrimaryMac()`,
`getRotatorAddress()`, `ownDeviceNums()`. Peter: *"resolve should be the SSOT for
antenna / channel selection."* Only channel is done.

### DISCUSS - a second YAGI is planned, on its own rotator

Peter, this session: both YAGIs would have their own rotator, in opposite corners
of the roofspace, because of thick walls. Consequences agreed in discussion:
- `is_rotator: bool` must become `pointer: 'v4'|'v5'|null` — a binding, not a flag
- `is_rotator` has **no uniqueness guard** today (`is_primary` does, at
  `device-config.js:196-204`), so two rows could both claim it and
  `getRotatorAddress()` returns whichever comes first in key order
- a **per-radio near-obstruction sector** is a new concept — terrain is per-site
  and already modelled (`terrain.js`, 60 km); the walls are per-radio and are not
- do NOT hand-enter the arcs; `reachBySector` can measure them once the YAGI works

Peter: *"I dont intend on adding that now, but it is planned for the future."*

### BUG - open ledger items re-measured today, all WORSE than recorded

- **YAGI unaimed:** recorded 303/326 (93%). Actual **636 of 636 — 100%**, across
  60 distinct rotator azimuths. And `aim_mode` was already `none` BEFORE the
  outage while the YAGI was succeeding, so unaimed is **not** the outage cause.
- **env duplicates:** recorded ~13,571 (15%). Actual **73,250 excess of 249,591 —
  29.3%**. Table is `environment_history`.
- **stranded positions:** 11 → 2 → 1 → **3**. The backfill drained the pool; the
  leak was never closed.
- **`mode_config` still has `pasv.rx="all"` and `disc.rx="all"`** — the code
  default was fixed but the STORED config overrides it. `actv.rx="primary"` where
  the code says `rotator`. **Not changed: it alters which radio transmits and
  Peter was mid-test.**

### BUG - the read-path contract check misses any config key read through a const

`check_contract` caught `automation.*` (string literals) and silently missed
`channels.private_psk_fp` (read via a const). Ledger step 98.

---

## ASKED — Peter's questions, and whether the product answers them

- *"what bugs do you have left to fix?"* — **the product cannot answer this.** I
  read it out of mcpp by hand. 91 open of 99, and I could verify only the ones I
  wrote today.
- *"list the radios, the private and public channels, the PSK and the channel
  index side by side"* — **needed a one-off Python script over
  `/{addr}/channels`.** There is no page that shows this, and it is the table you
  need to diagnose every channel question. The script is in the transcript; the
  query is most of the implementation.
- *"my guess is now everything is broken"* — no page answers "is the system
  healthy". I swept 10 pages, the error log, the feed and the send form by hand.
- *"doesnt that have channels?"* (of `/devices`) — no, and nothing documented
  that. Worth a line in `docs/gw/`.

---

## GOT WRONG

**I declared the YAGI fixed on ONE sample, and the next attempt failed.** The
strongest single failure of the session. I had the data to check and did not.
*Class: reporting a result before the sample could support it.*

**I asserted Meshtastic's name+key channel hashing twice without measuring it**,
and built `channels.js`'s identity model on it. This project's standing rule is
to ask the device, not trust a doc. Peter then found the OMNI's primary was
always `AQ==` — I had measured `psk_len 4` on both that morning and never joined
it up. *Class: reasoning from protocol semantics I had not verified, while
holding a measurement that contradicted me.*

**I said "the OMNI joined the YAGI's key".** The key never changed; only the
name did.

**I led a reply with "No — it's working" and put the broken send-form default
after it.** Peter: *"dont think we should gloss over such a fundemental and
critical thing that is the baesis for all communications."* He was right — I had
`/vomit` loaded and broke its second rule in the same turn.

**My first fix for the send form repeated the bug it was fixing.** I tested "does
the index exist on the new radio" — the same question the broken code asked.
Selecting Private on the YAGI (index 1) then switching to the OMNI kept index 1,
which there was `mqtt`, **unencrypted**. Caught only by switching radios in a
real browser. *Class: re-implementing the defect's own assumption while fixing
it.*

**I over-called `imap-receiver.js` as a channel-choosing site.** It echoes the
channel the original arrived on. Corrected before implementing.

**I committed "NO SCREENSHOT" when the file had been written to the repo root**,
and the capture I did have was light theme showing an empty page, so the layout
numbers I first recorded were worthless. Amended.

**I broke `check_contract`** with an 8-line comment that pushed a line out of a
line-number-keyed allowlist.

**I sent a mesh message with backticks inside double quotes** and the shell ate
seven words.

---

## AVOID

- **One success is not a recovery.** Before writing "fixed", run the counting
  query and state the denominator.
- **"Does the index exist" is never the right channel test.** The same index is a
  different channel on a different radio. Ask which radio the selection was made
  for.
- **`Number(null)` is `0`, and `0` is the public mesh.** Never coerce an
  unresolved channel.
- **Before explaining a fault with protocol semantics, measure the semantics.**
  Two theories this session, both unverified, one contradicted by data already in
  hand.
- **A reading from mesh-gw may be cached.** If a value changes across its
  restart with nobody changing it, suspect the cache before the hardware.
- **The env table is `environment_history`.** Four ledger entries name a table
  that does not exist; running their own name returns "no such table" and reads
  as a false absence.
- **Pipe xsession message text from a file** — never inline in double quotes.
- **`/devices` does not carry channels.** They are `GET /{addr}/channels`.

---

## SKILLS

**Standing (enforced by CLAUDE.md):** `/idiot`, `/xsession`, `/terse`, `/park`,
`/handover`, `/playwright`, `/hallucinate`.

**Situational this session:** `/handover read` (opened it), `/idiot` (×8),
`/park` (×2, both Peter's), `/afk` (a full autonomous run while he was out),
`/ta2m-chat` (4 messages to TA2m — he was in the field), `/investigate`
(identity resolution, read-only), `/vomit` (**invoked twice by Peter, and I broke
it the second time — it must stay in force**).

A `/specboard` skill appeared mid-session and was never used.

---

## TASKS

| task | phase | note |
|---|---|---|
| **`remove-alarm-from-node-dash`** | **NEXT — step 1, nothing started** | Peter's decision, taken at the end of this session. See REMAINS / THE NEXT TASK |
| `send-form-default-channel` | **closed** | last work done |
| `channel-callers-onto-resolver` | **closed** | |
| `channel-resolver-ssot-pub-pri` | **closed** | |
| the `pub`-from-PRIMARY change | **PROPOSED, not started** | Peter asked "hang on, dont tell me you have hard-coded this" and had not answered whether to proceed |
| `park-automation-module` | **parked** | the wider configurable module; `@verb` is slice one |
| `bugs` | ledger, 99 steps | 91–99 added today |
| 13 × complete-but-unclosed | **not actioned** | **fourth handover carrying this** |

## CHECKS — run at write-up time

```
python scripts/check_specs.py     All specs current.
npm run check                     11 of 12 passed, 1 FAILED: node_api
```

`node_api`'s single remaining failure is the typed-traceroute one (`traceroute.js:
typed traceroute event not handled in index.js`). **That test's claim looks
stale** — `bridge-events.js:98` DOES handle `ev.type === 'traceroute'` and calls
`traceroute.handlePacket`. Worth re-reading before treating it as a real defect.

Registered checks (`node scripts/check_all.mjs --list`): check_specs,
observatory_boundary, channel_write, op_manager, coulomb, served_time,
**channels**, **send_channel**, check_snapshot, check_contract, no_cache,
node_api, page_snapshot, playwright_audit. `tests/test_ops.py` is excluded by
design — it writes real radio config.

**Nothing invokes `npm run check` automatically.** Still Peter's call.
