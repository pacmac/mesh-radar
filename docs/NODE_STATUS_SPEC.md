# Node Status

## Authority

The node status page describes standard Meshtastic node data already ingested by
node-dash. Private application protocols and their configuration are outside
this contract.

## Rules

1. The backend owns conversion, aggregation, formatting, section presence, and
   section order. The browser renders the returned model.
2. Store and display reported values without inventing missing values.
3. Use one authoritative source per datum.
4. RSSI and SNR come from packet envelopes, never application payloads.
5. `DETECTION_SENSOR_APP` is standard text and is displayed verbatim.

## Sources

| Datum | Standard source |
|---|---|
| Identity | `NODEINFO_APP` |
| Position | `POSITION_APP` |
| Device vitals | `TELEMETRY_APP` device metrics |
| Environment | `TELEMETRY_APP` environment metrics |
| Detection text | `DETECTION_SENSOR_APP` |
| Signal | packet envelope |
| Last heard | packet arrival |

The independent mast-tilt integration on private port 256 is not part of the
node status contract.

## Backend contract

History is stored per node and deduplicated by `(num, packet_id)` where a packet
ID exists. The `node_status` response contains an identity header and an ordered
list of display-ready sections. A `node_status_update` hint carries only the node
number; the browser requests the authoritative model again.

## Explicitly excluded

- Application-specific roles, ports, payload schemas, commands, and settings.
- Text command replies as sources for node-status values.
- Browser-side formatting or data interpretation.
