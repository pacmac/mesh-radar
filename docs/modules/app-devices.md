---
module: app-devices
source: public/app-devices.js
source_hash: 184b045066e22670f3dc13bf82f1713a6c531679c74c5bb276301d67e81f2b9c
updated: 2026-09-03
---

# Module: app-devices

## Purpose

Browser device-SELECTION mixin (Domain 2, presentation only): which device is
active, its live BLE status, and the shared home-position field. All
device-MANAGEMENT (BLE pairing, radio config editing, OTA flashing, removal,
auto-purge editing) is gone — mesh-gw's own dashboard is the only place any of
that can be done now (2026-09-03, task `devices-management-removed-meshgw-owns-it`,
Peter: node-dash "is no longer responsible to manage devices").

## Removed 2026-09-03

Everything this spec used to document — the removal flow (`bleRemove`), BLE
pairing (`bleScan`, `bleConnect`, `submitPairPin`), per-device config writes
(`saveDeviceCfg`, `saveBleCfg`, `saveAntennaCfg`), auto-purge editing
(`saveAutoPurge`, `wipeNodeDb`), OTA firmware management (`loadOtaFiles`,
`flashOta`, download/prepare/delete) — deleted along with `tab-devices.html`
and the backend routes they called (`src/radio-admin.js`,
`src/radio-admin-api.js`, `src/device-remove.js`, and the write half of
`src/device-config.js`). 24 functions removed from this file; see
`docs/modules/device-config.md` and `docs/modules/op-manager.md` for the
backend side. The NEED_PAIR pairing overlay and OTA flash/download progress
overlay were removed from `public/index.html` in the same task — both were
driven entirely by functions this file no longer exports.

## Exports (10 functions + 2 getters)

```js
get primaryDeviceId()    // node_id of the is_primary device, live-resolved
get primaryDevBleState() // deviceBleStates[primaryDeviceId] || {}

devBleState(nodeId)      // → 'ready'|'offline'|... (deviceBleStates[nodeId].ble_state)
devIsSaving(nodeId)      // → true while any ops[...]_<nodeId> key is loading
devBleLabel(nodeId)      // → status label, or 'Saving config…' while devIsSaving

_clearDeviceState()      // resets nodes/nodeSelf/nodeTotal/nodeCount/loraCfg — called by selectDevice
selectDevice(key)        // sets activeDevice (MAC or node_id), persists, reconnects WS
bootstrapDevice()        // no-op — node_list arrives via WS on connect

deviceLabel(nodeId)      // → display_name of a live device, or ''
rotatorDeviceId()        // node_id of the is_rotator device, live-resolved

_rebuildDeviceConfigs()  // rebuilds deviceConfigs from _deviceConfigsByMac + live availableDevices

saveHomePosCfg()          // PUT /home_pos — Config tab's home-position field;
                           // lives here for historical reasons (pre-dates this
                           // task), not device management
```

## Dependencies

- `app-helpers.js` — `fetchJSON` (used only by `saveHomePosCfg`)
- `app-persist.js` — `persistSet` (used only by `selectDevice`)

## Callers

- `drawer-sidebar.html` — the device selector `<select>` calls `selectDevice`;
  the status footer reads `deviceLabel`, `devBleState`; the logo block reads
  `primaryDevBleState`.
- `app.js` `init()` — calls `bootstrapDevice()` once on boot.
- `app-radar.js`, `tab-radar.html` — `rotatorDeviceId()`.
- `app-ws.js` — `_rebuildDeviceConfigs()` on every `device_list` event.
- `app-perf.js` — reads `primaryDeviceId` to pick the default radio.
- `tab-cfg.html` (Config → Radar sub-tab) — `saveHomePosCfg()`.
- `index.html` header — `devBleLabel`, `deviceLabel`, `devBleState` for the
  per-device not-ready badges (display only, no click-through to a Devices
  page — there is not one any more).

## Out of scope

- Anything mesh-gw now owns: BLE pairing, radio config editing, OTA, device
  removal, per-device auto-purge. See mesh-gw's own dashboard.
- Which radio is currently connected at the transport level — `bridge.js` /
  `ws-relay.js` own the live device list; this mixin only reads it.

## Test notes

- Playwright: no Devices nav item, no Devices route; device selector dropdown
  switches `activeDevice` with 0 console errors; per-device status footer
  (YAGI2/OMNI `ready`) renders; header not-ready badges are non-interactive.
