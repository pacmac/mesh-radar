---
module: device-remove
source: src/device-remove.js
source_hash: 455096574d4520be1f062f2125ffc794d541d9292556b5add08884880cb13ef0
updated: 2026-07-16
---

# Module: device-remove

## Purpose

The ONE device-removal operation (`DELETE /device/:mac`). Before this task,
"remove device" was not a real operation anywhere in the stack: the browser
button hit gw `DELETE /ble/known/{addr}` directly (which IS the complete
gw-side removal — disconnect + drop from `bridge_config.yaml` + BlueZ un-bond,
per `docs/gw/API_REST.md` §Forget), but every piece of node-dash state
survived: the `ws-relay` in-memory `lastDeviceState` entry (add-only map,
never pruned → device re-broadcast on every `device_list`), the
`device_cfg.<MAC>` SQLite row (no delete path existed), `auto_purge_*` rows,
and the `node_mac.<MAC>` registry row. Findings 1–3 of the 2026-07-16
device-management code review.

## Responsibilities

- Validate `:mac` is a real BLE MAC (400 otherwise).
- gw first: `bridge.delete('/ble/known/{MAC}')`. A gw 404 (already forgotten)
  is treated as success (`gw: "already_gone"`); any other gw failure aborts
  with 502 and **no local cleanup** — local state must keep mirroring the gw,
  otherwise the next `device_snapshot` resurrects a half-removed device.
- On gw success: delete `device_cfg.<MAC>` (and legacy `device_cfg.<!hexid>`
  when the live node_id is known), `auto_purge_*` rows under both the node_id
  and MAC keys (mixed-keying legacy), `node_mac.<MAC>`, then
  `pruneDevice(mac, nodeId)` (ws-relay) which drops the in-memory entries and
  rebroadcasts `device_list`.

## Public interface

- default export: Express `Router` with `DELETE /:mac`.
  Response: `{ removed: <MAC>, node_id: <!hexid|null>, gw: "removed"|"already_gone" }`.

## Implementation plan (task `device-remove-op`)

### A. NEW `src/device-remove.js`

Router as described above. Imports: `bridge` (bridge.js), `deleteConfig`
(db.js), `deleteDeviceCfg` (device-config.js), `removeAutoPurgeCfg`
(auto-purge-api.js), `getLiveNodeIdByMac`, `pruneDevice` (ws-relay.js).

### B. `src/ws-relay.js`

1. Near `STATE_EVENT_TYPES` (l.36): add
   `const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;`
2. After the `pokeDeviceList` export (l.45–47): module-level
   `_pruneDevice` holder + `export function pruneDevice(mac, nodeId = null)`
   which deletes the `_liveNodeIds` entry then delegates to the closure
   (same pattern as `pokeDeviceList`).
3. Inside `attachWsRelay`, after `_pokeDeviceList = broadcastDeviceList;`
   (l.306): assign `_pruneDevice = (mac, nodeId) => { ... }` — deletes every
   `lastDeviceState` entry whose key matches the MAC (case-insensitive) OR
   whose `node_id`/`state_event.node_id` matches the removed device's node_id
   (catches historic node_id-keyed duplicates), deletes `lastDeviceLora[MAC]`,
   then `broadcastDeviceList()`.
4. Ghost guard (l.345–348). Before:
   ```js
   const evAddr = ev.addr || ev.device;
   if (evAddr && STATE_EVENT_TYPES.has(ev.type)) {
     if (ev.type === 'device_state' && ev.addr) ensureDeviceCfgMac(ev.addr, ev.node_id);
     const existing = lastDeviceState[evAddr] || { addr: evAddr };
   ```
   After:
   ```js
   const evAddr = ev.addr || getLiveMacByNodeId(ev.device) || ev.device;
   if (evAddr && STATE_EVENT_TYPES.has(ev.type)) {
     // Ghost guard (device-remove-op): only a MAC-shaped key may CREATE an
     // entry — node_id-keyed strays previously became no-name ghost devices.
     if (!lastDeviceState[evAddr] && !MAC_RE.test(evAddr)) return;
     if (ev.type === 'device_state' && ev.addr) ensureDeviceCfgMac(ev.addr, ev.node_id);
     const existing = lastDeviceState[evAddr] || { addr: evAddr };
   ```
   Behavior preserved: events for known keys still update; events with a
   resolvable node_id now update the MAC-keyed entry instead of forking a
   duplicate; unknown non-MAC strays are dropped (previously: ghost row).

### C. `src/device-config.js`

1. After `PREFIX` (l.6): add `MAC_RE` and `NODEID_RE = /^![0-9a-f]+$/i`.
2. `ensureDeviceCfgMac` bootstrap branch (l.83): require `MAC_RE.test(mac)`
   before creating a default row — no more cfg rows for junk keys.
3. New export `deleteDeviceCfg(key)` — `deleteConfig(PREFIX + key)` with MAC
   uppercased, `!hexid` passed through as stored.
4. `GET /:address` (l.95) and `PUT /:address` (l.108): 400 when the key is
   neither MAC- nor `!hexid`-shaped. This kills the `device_cfg.UNDEFINED`
   creation path (browser once sent `PUT /device-config/undefined`).
5. One-time idempotent purge at module load: delete existing `device_cfg.*`
   rows whose key is malformed (removes the known `device_cfg.UNDEFINED`),
   logging each purged key.

### D. `src/auto-purge-api.js`

Add `deleteConfig` to the db.js import; new export
`removeAutoPurgeCfg(key)` deleting `auto_purge_enabled_<key>`,
`auto_purge_time_<key>`, `auto_purge_last_run_ts_<key>`.

### E. `src/index.js`

Import the router; `app.use('/device', deviceRemoveRouter);` next to the
`/device-config` mount (l.150). `/device/...` does not collide with the
`/devices` bridge prefix, the SPA page list, or the MAC-prefixed proxy regex.

## Explicitly NOT changed (out of scope)

- `public/*` — the Remove button still calls `/ble/known` directly; re-pointing
  it to `DELETE /device/:mac` is a separate Domain-2 task (browser contract).
- `dash-mode` `mode_config` may reference a removed device's MAC in rx/tx
  roles — dangling ref reported, not fixed here (separate task).
- `node-list` mesh entries for the removed radio's node — mesh observation
  data, not device state; auto-purge/user wipe owns that lifecycle.
- `app-ws.js` dead `'ble:'`-key branch and other browser findings (4, 6–8 of
  the review) — Domain 2.

## Test notes

- `curl -X DELETE http://localhost:3000/device/<junk>` → 400.
- `curl -X DELETE http://localhost:3000/device/<MAC>` → gw forget called;
  response lists `removed`, `node_id`, `gw`; follow-up WS `device_list` no
  longer contains the device; `device_cfg.*`/`auto_purge_*`/`node_mac.*` rows
  gone from SQLite.
- Regression: `PUT /device-config/<MAC>` on a live device still works and
  still pokes the device list; `device_cfg.UNDEFINED` absent after boot.
