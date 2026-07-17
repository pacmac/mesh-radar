# Node Status page — founding spec (initial)

**Status: draft for Peter's review — no implementation until approved.**
Discussed 2026-07-17. Companion context: the pac-garage-alarm project
(`pio/projects/pac-garage-alarm/docs/hardware.md`, read-only reference) —
but nothing here is garage-specific; see §2.

---

## 1. Purpose

A per-node status page serving two roles:

1. **Alarm surface (later)** — the place where a monitored device's health
   verdict lives, sharing its rule set with the alerts engine.
2. **Confidence monitor (now)** — one glance answers "is everything okay
   there?": liveness, power, environment, link health, with graphed history.

## 2. Scope model — generic page + monitored-device enrichment

The page works for **any node in the mesh** with zero configuration:

- **Liveness**: last heard + age (the headline fact).
- **Link health** (transport layer): RSSI/SNR/hops per receiving gateway
  radio, latest and graphed. Which radio hears the node, how well.
- **Standard telemetry**: env (temp/humidity/pressure) and device metrics,
  current + charts from `environment_history` / nodes-table state.
- **Identity block**: name, `!hexid`, hw model, role, position when present.

A per-node **“monitored device” designation** (explicit config flag, not
auto-detection) unlocks the enrichment layer:

- **Parsed application heartbeats** (§4): boot/rst/trig/cfg and friends —
  state that standard telemetry does not carry — latest values + timeline
  table + charts (vbat over time at heartbeat cadence).
- **Value-level error surfacing**: a heartbeat value like `env=ERR:0.0C/0%`
  is a displayable fault condition, shown distinctly, never dropped.
- **Masking**: fields that are misleading for this device are hidden
  (first case: battery %, meaningless for Li-SOCl2 primary cells).
- **Verdict slot** (§6): reserved at the top; rules deferred.

The target node runs custom firmware but speaks standard Meshtastic
protocols — **the dash treats it as a normal MT node**; everything special
comes only from the flag and the message contents.

## 3. Routing & mobile-first requirement

- **Deep link: `/status/:nodeid`** (`!hexid`; FICR-derived and stable for
  the target device). Friendly aliases (`/status/garage`) are a possible
  later addition, not in scope now.
- Express side: a page route for `/status/:id` (Accept: text/html →
  app shell). It must not collide with the existing JSON `GET /status`
  (different path — verified compatible); the SW and WS_ONLY guards are
  unaffected.
- Browser side: `initTab()` learns path parameters — `/status/!x` selects
  the status tab with the node preselected; in-app navigation (from the
  node list / node info drawer) pushes the same URL.
- **Mobile-first**: this page is designed for a phone viewport first —
  single column, generous touch targets, charts full-width — scaling up
  inside the normal dash shell (nav, theme, fonts) on desktop. The rest of
  the dash stays as it is.

## 4. Application-layer heartbeats — loose parser contract

The monitored device emits text messages of the shape:

```
v=trial-fw-v2 up=8444s boot=12 rst=0x0 vbat=4.29V/100% env=ERR:0.0C/0% trig=0 hb=300s det=3/60s tx=22 cfg=saved
```

Parser rules (backend, at message ingest):

- Recognition: text starts with `v=` and splits into ≥3 `key=value` tokens.
- **Loose by contract**: every `key=value` pair is stored as-is (JSON blob);
  unknown keys are kept, never dropped — firmware iterations must not
  require dash changes.
- Typed extraction is opportunistic, for charting: `up` (s), `boot` (int),
  `vbat` (volts + pct), `env` (temp °C + rh % — or an error string),
  `trig` (int), `hb` (s). Un-parseable values remain strings and render as
  status/fault text.
- Storage: `sensor_heartbeats` table — `ts`, `num`, `raw` (full text),
  `kv` (JSON), typed columns for the chartable fields. Keyed by node num.
- Backfill of pre-existing rows in `messages` is a one-shot convenience;
  history effectively starts when the parser ships. No ghost-identity
  merging — dev-era history under old node numbers stays where it is.

## 5. Page data — WS-only (C2)

No page-data GETs. The browser requests over the existing WS
(`{type:'node_status', num}` — the geocode RPC pattern) and receives
current state + **server-side downsampled** histories (env, signal,
heartbeats). Live updates: when a monitored node's heartbeat/telemetry
arrives, the backend pushes an incremental event so an open page updates
without reload — important for a device that wakes briefly.

## 6. Health verdict — deferred, slot reserved

“All good” is a decision (recency threshold, fault values, power floor) and
therefore **backend-owned**, evaluated by the same rule set the
missed-heartbeat alert will use. Blocked on the device's wake cadence
(undecided). Until then the page shows the raw facts — age, last values,
visible error states — and reserves the top-of-page verdict slot.
The monitored-device config already carries the future
`expected_heartbeat_s` field (null = verdict disabled).

## 7. Layout sketch (phone, top → bottom)

```
[ verdict slot — hidden until rules exist ]
LAST HEARD        2m ago  via YAGI  −37dBm/5.5
HEARTBEAT         up 8444s · boot 12 · rst 0x0 · trig 0    (monitored only)
POWER             4.29 V                                    (% masked)
ENVIRONMENT       35.1 °C · 25 %     [env=ERR → fault banner]
── charts (full width, scroll) ──
temp/humidity · voltage · RSSI/SNR
── heartbeat log (monitored only) ──
ts · up · boot · rst · vbat · trig · flags
── identity / link detail ──
```

Desktop: same content, two-column at ≥md. All type via STYLE_GUIDE roles;
both themes; Chart.js (already in the stack).

## 8. Open items (explicitly undecided)

- Recent raw **messages on the page** vs feed-only — Peter to decide.
- Friendly **alias URLs**.
- **Verdict rules + alert wiring** — after wake cadence is set.
- **Command messages** — protocol undecided; out of scope entirely.

## 9. Task breakdown (each its own /idiot task, in order)

| # | Domain | Task | Files (expected) |
|---|---|---|---|
| A | 1 | Heartbeat parser + `sensor_heartbeats` + backfill | `db.js`, `persist.js` |
| B | 1 | Monitored-node config (`monitored_nodes`) + `node_status` WS RPC + live push | `ws-relay.js`, `config-api.js` |
| C | 2 | Status page: partial + mixin + routing (`/status/:id`, initTab params), mobile-first | `index.js` (route), `app.js`, new `app-status.js`, new `tab-status.html` |

Module specs (`docs/modules/*`) are written per task as usual;
this document is the feature contract they implement.
