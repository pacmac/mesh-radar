---
module: app-ws
source: public/app-ws.js
source_hash: 0e3c1a7d7b641f0db847df45685e2862a5fb6580a2d8349f8d45f7cb1d7e966a
updated: 2026-07-02
---

# Module: app-ws

## Purpose

Browser WebSocket mixin: connects to `/events`, dispatches every WS event
type into Alpine state. The canonical event→state map lives in
`docs/BROWSER_ARCH.md`; this spec records the module-level contracts that
have been explicitly fixed.

## Active-device adoption rules (task `set-active-fix`)

`activeNodeId` has two layers:

- **User preference** — persisted (`ui_prefs.activeNodeId`); written ONLY by
  explicit user actions (`selectDevice()` — Set Active button / drawer
  selector — and the `is_primary` save path in app-devices.js).
  `loadDeviceConfigs()` (app-devices.js, also in scope for this task) seeds
  the primary device as active ONLY when no persisted preference exists —
  it no longer overwrites or persists over a user choice.
- **Effective value** — `this.activeNodeId`; may temporarily fall back when
  the preferred device is absent from `device_list`.

`device_list` handler rules:
1. If the persisted preference is present in the incoming list and differs
   from the current effective value, **re-adopt it** (recovers after a
   device reboot/BLE outage).
2. If the current effective value is missing from the list, fall back to
   `devices[0]` **without persisting** — the fallback is display-only.
3. `msgFrom` follows the same rule: fallback assignment does not persist.

Historic bug fixed here: the handler persisted the fallback, permanently
clobbering the user's Set Active choice whenever the chosen radio dropped
for one device_list cycle (e.g. a config-write reboot).

Known limitation (BROWSER_ARCH violation, deferred to the backend-additions
task): the preference lives in per-browser localStorage. Server-side
ownership (`device_list.active_device`) will supersede this mechanism.

## Other fixed contracts

- `packet` (TEXT_MESSAGE_APP) handler dedupes by `pktId`: second radio's copy
  merges `src`/rssi/snr into the existing entry instead of appending a
  duplicate (duplicate x-for keys froze the feed) — task `message-flow-audit`.
  `message_status` events with V2 vocabulary patch `ackStatus`/`ackFrom`/
  `ackError` as before.

- `node_list` handler seeds `nodeSelf.num` from `my_node_num` even when node
  filters exclude the self node (keeps `tilt_update`/`telemetry_update`
  matching alive) — task `overview-data-fix`.

## Out of scope

Full per-event documentation — see `docs/BROWSER_ARCH.md` canonical handler
map. This spec exists to hash-guard the file and record fixed contracts.
