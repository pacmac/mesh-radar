# node_status RPC — spec

Step 4 of `status-rebuild-rip`. Backend only. Implements the payload contract the
focus page renders.

Spec of record: `docs/NODE_STATUS_SPEC.md`. Design decisions: mcpp task note 1039.

## Contract

Request (client→server, beside the existing `geocode` handler):

```js
{ type: 'node_status', num }
```

Response:

```js
{ type: 'node_status', num, found: bool, header: {…}, sections: [ … ] }
```

## The payload is an ORDERED LIST OF DISPLAY-READY SECTIONS

The browser knows a small fixed vocabulary of section **kinds** and nothing else.
It does not know what portnum 260 is, what a detection is, or which port a datum
came from. It renders what it is handed, in the order handed.

Consequences, all deliberate:

- Adding a port, a `type`, or a field later is a **backend-only** change.
- **Section presence is a server decision.** A section absent from the array is
  absent from the page. The browser must never evaluate "is this empty, should I
  hide it" — that would be the browser deciding (iron rule 1).
- **Section order is a server decision**, for the same reason.

### Section kinds (fixed vocabulary — do not grow casually)

| kind | shape | used for |
|---|---|---|
| `value_grid` | `{ fields: [{label, text, raw, ts}] }` | current-state readings |
| `series` | `{ series: [{label, unit, points: [{t, v}]}], t_min, t_max }` | time-series |
| `event_log` | `{ events: [{ts, ts_text, label, text}] }` | chronological events |

`config_form` is **not** built here. The 260 config panel is read-only for now
and ships as a `value_grid`; the editor (OpManager + `MeshRunner`) is separate
work — see task note 1039.

## Every field carries raw + text + ts

Per NODE_STATUS_SPEC: "for every displayed field, a raw typed value, a
ready-to-display string, and an observation timestamp — all computed
server-side." The browser binds `text` verbatim and never formats.

## Formatting — new SSOT module `src/format.js`

The previous formatters were removed with the status page. Rebuilt as the single
source, so every consumer (page, export, script) gets identical strings.

```
fmtVoltage(v)      → "4.23 V"        fmtPercent(p)    → "100%"
fmtUptime(s)       → "2d 4h 13m"     fmtUtil(p)       → "3.5%"
fmtTemp(c)         → "28.5 °C"       fmtHumidity(h)   → "38 %RH"
fmtPressure(hpa)   → "1013 hPa"      fmtGas(mohm)     → "12.4 MΩ"
fmtRssi(dbm)       → "-85 dBm"       fmtSnr(db)       → "7.5 dB"
fmtTimestamp(ts)   → "2026-07-18 07:41:02"
fmtAgo(ts, now)    → "3m ago"
```

Null/undefined in → `null` out (never the string "null", never "n/a" — an absent
value is absent, and the section/field is omitted).

**VALUES, NOT VERDICTS.** No "healthy", no "low battery", no quality grades.
`utils.js signalQuality()` returns a judgement and **must not** be used here
(iron rule 2, and the explicit no-battery-editorialising directive).

## Header — identity + right now

`{ num, node_id, long_name, short_name, hw_model, last_heard: {raw, text, ago},
   fields: [ … ] }` where `fields` are the at-a-glance vitals present for this
node: battery, voltage, uptime, RSSI, SNR. Absent ones are omitted, not nulled.

## Sections emitted (source-grouped)

Built in this fixed order, each **only if it has data**:

| id | kind | source | present when |
|---|---|---|---|
| `device_vitals` | `series` | `device_metrics_history` | ≥1 row in window |
| `environment` | `series` | `environment_history` | ≥1 row in window |
| `detections` | `event_log` | `detection_events` | ≥1 row in window |
| `alarm_config` | `value_grid` | `node_app_state` 260 `config` | row exists |
| `diagnostics` | `value_grid` | `node_app_state` 260 `debug` | row exists |
| `power` | `value_grid` | `node_app_state` 260 `calc` | row exists |
| `position` | `value_grid` | `nodeinfo` lat/lon | coords present |

Window: last 7 days, capped per series (see Invariants).

**Grouping choice.** Source-grouped, per the recommendation in note 1039 — it is
honest about provenance and matches the SSOT table. The alternative
(question-grouped, e.g. overlaying `alarm`/`cleared` events on the environment
chart) is deliberately **not** done yet. Because the browser is a dumb renderer,
this is a backend-only decision and cheap to revise later; it does not need to be
settled before the page exists.

## Live push

On any event carrying a node num, broadcast `{ type: 'node_status_update', num }`.
The browser re-requests — a data fetch, not a computation. No values are pushed,
so there is exactly one code path producing them.

Throttled per-node (1 hint/sec) so a burst cannot storm connected browsers. The
throttle is a delivery concern, not a data decision.

## Files

| File | Change |
|---|---|
| `src/format.js` | NEW — formatter SSOT |
| `src/node-status.js` | NEW — builds the payload (queries + section assembly) |
| `src/db.js` | query statements for the four new/existing history tables |
| `src/ws-relay.js` | `node_status` RPC handler; `node_status_update` throttled broadcast |
| `docs/modules/format.md` | NEW spec |
| `docs/modules/node-status.md` | NEW spec |
| `docs/modules/db.md`, `docs/modules/ws-relay.md` | updated + rehashed |

## Invariants

- The browser receives no value it must format, parse, or decide about.
- A section with no data is **absent** from `sections`, never present-and-empty.
- Series are downsampled server-side to ≤200 points per series.
- Unknown node → `{found: false, sections: []}`, not an error.
- No section is derived from a command reply (`@ping`/`@status`/`@env`) —
  iron rule 3.
- `node_status_update` carries **only** `num`. Never a value.

## Done when

- RPC returns a populated payload for a real node, and `{found:false}` for an
  unknown num
- A node with 260 traffic gains the 260 sections; a plain node does not
- Every displayed field has `text` already formatted
- App healthy under PM2; `python scripts/check_specs.py` green
