# Node Status — founding spec

## Authority

`docs/mt-transport/API.md` is the **authoritative device contract** — the single
source of truth for which port/variant carries which datum. This spec maps
node-dash's ingestion, API, and display onto that contract. Where anything here
conflicts with API.md, **API.md wins**.

## Device model

A **normal Meshtastic node** in every respect, with **exactly one exception**:
portnum **260 (`PAC_ALARM_APP`)** — the device's own JSON extension. Standard
ports are handled generically (works for any node); portnum 260 is routed by
portnum, then by the payload's `type`.

`PAC_ALARM_APP` (260) is distinct from `PRIVATE_APP` (256, the mast-tilt app) —
separate portnums, no collision.

## Iron rules

1. **The UI displays what it is given — full stop.** Every calculation,
   conversion, rounding, aggregation, and formatting happens server-side. The
   browser binds backend-provided values verbatim and computes nothing. The
   `node_status` API is a data contract; any consumer (app, script, export)
   reads identical, already-final values.
2. **Accept data as provided.** node-dash does not judge, filter, correct, or
   editorialise device data — it stores and displays whatever the device sends.
3. **SSOT — one source per datum** (API.md). No field is sourced from two ports.
   In particular, **command replies (`@ping`/`@status`/`@env`, JSON on
   `TEXT_MESSAGE_APP`) are messages, not a data source** for any page value.
4. **RSSI/SNR come from the packet envelope** (`rx_rssi`/`rx_snr`), never a
   payload.

## Data → source (authoritative, per API.md §1/§2/§4/§5)

| Displayed datum | Port | Variant / `type` | Fields |
|---|---|---|---|
| Alive / last-heard | any packet | — | arrival time |
| Device vitals | `TELEMETRY_APP` | `device_metrics` | uptime_seconds, voltage, battery_level, channel_utilization, air_util_tx |
| Environment | `TELEMETRY_APP` | `environment_metrics` | temperature, relative_humidity, barometric_pressure, gas_resistance |
| Identity | `NODEINFO_APP` | User | id, long_name, short_name, hw_model |
| Position | `POSITION_APP` | Position | latitude_i, longitude_i |
| Signal | packet envelope | — | rx_rssi, rx_snr |
| Config (live) | **260 `PAC_ALARM_APP`** | `type:config` | beat, txp, slp, det.n/win, alm.on/ovr/und/hum/ren |
| Diagnostics | **260 `PAC_ALARM_APP`** | `type:debug` | boot, rst, cfg, sim, trig |
| Derived power | **260 `PAC_ALARM_APP`** | `type:calc` | cons (mAh) |
| Detection events | `DETECTION_SENSOR_APP` | JSON `type` | `motion`, `count`, `alarm`, `cleared` |

- `TELEMETRY_APP` carries both metric variants — distinguish by protobuf
  **variant**, not port.
- `channel_utilization` present only when awake; absence is not zero.
- Detection events are typed: `motion` (qualified PIR alarm), `count` (raw PIR
  triggers since last heartbeat), `alarm`/`cleared` (env threshold cross /
  recover). The consumer switches on `type`.

## Portnum 260 (`PAC_ALARM_APP`) — the one exception

- mesh-gw surfaces it as a `private_app` event tagged `portnum: 260` (and the
  raw packet). node-dash routes on `portnum === 260`, then on payload `type`.
- **Read**: `type:config` (cache; changes only by command), `type:debug` (every
  heartbeat), `type:calc` (every heartbeat).
- **Write (bidirectional)**: node-dash sends `{"type":"set","path":…,"val":…}`
  on 260 to change one setting; the device re-validates against the schema,
  persists, and re-broadcasts `type:config`. node-dash never assumes success —
  it updates from the echoed `type:config`.
- `docs/mt-transport/config-schema.json` (static, symlinked, versioned by
  `config.ver`) supplies each setting's command, range, unit, and default — it
  drives the config form, client-side validation, and the `set` shape. **Live
  values come from `type:config`, never from the schema defaults.**

## Backend (server computes everything)

- **Historise per node**, deduped by `(num, packet_id)` — a broadcast heard by N
  gw radios is one datum: standard telemetry (`device_metrics`,
  `environment_metrics`) and detection events.
- **Cache latest per node** the 260 `type:config` / `debug` / `calc`.
- **`node_status` API** returns, for every displayed field, a raw typed value, a
  ready-to-display string, and an observation timestamp — all computed
  server-side. The browser renders the strings verbatim.
- **Live push**: broadcast a `node_status_update {num}` on any event from that
  node; the browser re-requests (a data fetch, not a computation). No value is
  ever recomputed in the browser to stay fresh.

## Explicitly excluded

- Command replies (`@ping`/pong, `@status`, `@env`) as data sources — messages
  only.
- Any custom heartbeat-text stream — it does not exist in this contract.
- Portnum 256 / mast-tilt — a separate app, unaffected.
