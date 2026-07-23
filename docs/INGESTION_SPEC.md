# Standard node ingestion and storage

Spec of record: `docs/NODE_STATUS_SPEC.md`.

## Scope

- Node identity and position.
- Device and environment telemetry history.
- Standard `DETECTION_SENSOR_APP` text.
- Direct packet-envelope signal history.

## Storage

`device_metrics_history`, `environment_history`, `detection_events`, and
`signal_history` are keyed by node and timestamp. Partial unique indexes on
`(num, packet_id)` collapse the same broadcast received by several radios when
a packet ID is available.

`detection_events.raw` stores the standard text payload verbatim. node-dash does
not parse an application-specific JSON grammar on this port.

## Invariants

- A packet heard by several gateway radios creates one history row.
- Unknown or malformed application payloads cannot break standard ingestion.
- Only direct reception updates node signal history.
- Device timestamps outside the accepted clock-skew window fall back to gateway
  arrival time.
- Private application state is not interpreted or cached by core node-dash.
