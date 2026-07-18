---
module: status-rebuild
source: docs/STATUS_REBUILD_SPEC.md
source_hash: ~
updated: 2026-07-18
---

# Node Status — ground-up rebuild spec

Supersedes and deletes the old `NODE_STATUS_SPEC.md`. The previous page and its
backend sourced charts, trigger counts, boot/rst/fw and staleness from a
**custom sensor-heartbeat text stream** (`sensor_heartbeats`). That stream dies
whenever the firmware stops emitting heartbeats, freezing the page while the
node is alive on standard telemetry. Every "not updating / wrong value" report
traces to this. It is removed entirely and rebuilt from the real channels.

## Decision (settled)

The page renders for **any** node. `monitored_nodes` is retained only as a
lightweight pin/label list — never a gate on whether data shows.

## Computation boundary — ABSOLUTE: the UI displays what it is given, full stop

The browser performs **zero** computation of any kind — no calculation, no
conversion, no rounding, no unit-suffixing, no relative-time math, nothing. It
binds a backend-provided value straight into the DOM. Because the `node_status`
API is a data contract any consumer (another app, a script, an export) may read,
**every** value — raw, derived, resolved, formatted — is produced server-side so
all consumers see identical, correct data.

The backend emits, per displayed item, a **display-ready** field plus the raw
typed value:

```
power.voltage      = { value: 4.137, display: "4.14 V" }
environment.dew    = { value: 11.2,  display: "11.2 °C" }   // dew point computed server-side
liveness.last_heard= { ts: 1784350877, display: "just now" } // "ago" string computed server-side
detections         = { count_24h: 3, display: "3 in 24h", events: [...] }
```

Computed **only** server-side: freshness resolution (which source is current +
its true observation ts — kills findings #2/#3 at the source), dew point,
detection counts/rates, uptime, every unit conversion, all chart
bucketing/aggregation, and **every display string including "N ago"**.

Liveness stays current not by the browser recomputing "ago" on a timer, but by
the browser **re-requesting** `node_status` (a data fetch, not a computation) on
the live-update push and on a periodic tick; the backend returns a freshly
computed `display` string each time. The browser only ever swaps in the new
string it was given.

## Part 1 — Rip-out manifest (deleted, verified zero references remain)

Deleted files: `public/partials/tab-status.html`, `public/app-status.js`,
`docs/NODE_STATUS_SPEC.md`, `docs/modules/app-status.md`,
`docs/modules/tab-status.md`.

Excised symbols:
- `src/ws-relay.js`: `buildNodeStatus()`, `node_status` RPC handler, both
  `node_status_update` broadcasts.
- `src/persist.js`: `parseSensorHeartbeat()`, heartbeat backfill migration,
  heartbeat insert in `handlePacket`.
- `src/db.js`: `sensor_heartbeats` table + indexes; `getSensorHeartbeats`,
  `getEnvHistoryBucketed`, `getSignalHistory`, `insertSensorHeartbeat` stmts.
- `src/index.js`: `/status/:id` route.
- `public/app.js`: `statusMixin` import + `initStatusNum` wiring.
- `public/app-nav.js`: status-tab branches. `public/app-ws.js`: `node_status`
  routing. `public/index.html`: `tab-status.html` include.
- `src/config-api.js`: `monitored_nodes` reduced to a pin list (kept).

Kept (shared infra, other pages depend on it): `nodes`, `environment_history`,
`messages` tables and their ingestion.

## Part 2 — Real sources (live samples, node !987ab80f 2026-07-18)

| Channel | gw shape | Cadence | Sample |
|---|---|---|---|
| DEVICE_METRICS | `telemetry` → `data.device_metrics` | ~5 min | voltage 4.137, battery 93, uptime 57312, ch_util 6.885, air_tx 0.143 |
| ENVIRONMENT_METRICS | `telemetry` → `data.environment_metrics` | ~2 min | temp 21.98, rh 49.19, pressure null |
| DETECTION_SENSOR | raw `packet`, `decoded.portnum=DETECTION_SENSOR_APP`, payload base64 ASCII | per event | 1 packet = 1 detection |
| NODEINFO | `user` event | on change | GRGE / PAC Garage / PRIVATE_HW / SENSOR / hops 2 |
| POSITION | `position` event | on change | 51.0329, -3.1523 |
| SIGNAL | `rx_snr`/`rx_rssi` on every packet | per packet | rssi -118, snr -15.75 |

## Part 3 — Displayed components → source

Identity ← NODEINFO. Liveness (last heard) ← any packet. Power
(voltage/battery/ch_util/air_tx/uptime) ← DEVICE_METRICS. Environment
(temp/hum/pressure/dew) ← ENVIRONMENT_METRICS. Detections (count/last/list) ←
DETECTION_SENSOR. Signal (rssi/snr + trend) ← SIGNAL. Charts (voltage, env,
detections, signal) with a **visible time x-axis**, each from its history table.
No component reads a heartbeat.

## Part 4 — New backend tables (deduped by num, ts, packet_id)

```
device_metrics_history(ts, num, voltage, battery, ch_util, air_tx, uptime)
detections(ts, num, packet_id, payload, snr, rssi, device)
signal_history(ts, num, rssi, snr, device)
```

## Part 5 — Live-update contract

Backend broadcasts `node_status_update {num}` on **every** event from the node
(device_metrics, environment_metrics, detection, position, nodeinfo). Browser
re-requests on that event for the open node, plus a 1 s client tick advances the
relative "N ago" liveness with no event. Env/history inserts deduped so no 4×
rows. Not done until a live test shows the open page advancing as telemetry
lands.
