---
module: app-devices
source: public/app-devices.js
source_hash: 40756e04172966ed5809b3b2e0fc83587ac7b428f39f7e466348d1c7b7d180a9
updated: 2026-07-16
---

# Module: app-devices

## Purpose

Browser device-management mixin (Domain 2, presentation only): device
selection, per-device settings writes, BLE connect/pair/remove flows, OTA
firmware management. Consumes the node-dash backend API only.

## Scope of this spec

Created for task `remove-button-repoint` — it documents the removal flow
change precisely; the rest of the module is summarised, not yet fully
specified (pre-existing code, unspecced before this task).

## Removal flow (task `remove-button-repoint`, 2026-07-16)

Backend task `device-remove-op` (commit ac41e46) created the single removal
operation `DELETE /device/:mac`. Before this task, `bleRemove` called the gw
passthrough `DELETE /ble/known/{addr}` — browser-held gw-API knowledge
(BROWSER_CONTRACT violation) and only the BlueZ-bond part of removal, so
removed devices kept their card, config and relay state.

Two callers, both unchanged in HTML:

- `tab-devices.html:444` — device-card Remove button, wrapped in
  `asyncOp('remove_' + dev.node_id, () => bleRemove(dev.addr), { successMsg: 'Device removed' })`.
- `tab-devices.html:538` — BLE scan modal, `bleRemove(d.address)` direct;
  errors render via the modal's `bleError` alert.

### `bleRemove(address)` — before

```js
async bleRemove(address) {
  try {
    await fetchJSON(`/ble/known/${encodeURIComponent(address)}`, 'DELETE');
    const dev = this.bleDevices.find(d => d.address?.toUpperCase() === address.toUpperCase());
    if (dev) { dev.paired = false; dev.trusted = false; }
  } catch (e) {
    this.bleError = 'Remove failed: ' + (e.message || e);
  }
},
```

Bug: the swallowed catch made the card path's `asyncOp` always report
success — "Device removed" toasted even when the call failed.

### `bleRemove(address)` — after

```js
async bleRemove(address) {
  try {
    await fetchJSON(`/device/${encodeURIComponent(address)}`, 'DELETE');
    const dev = this.bleDevices.find(d => d.address?.toUpperCase() === address.toUpperCase());
    if (dev) { dev.paired = false; dev.trusted = false; }
  } catch (e) {
    this.bleError = 'Remove failed: ' + (e.message || e);
    this.showToast('Remove failed: ' + (e.message || e), 'error');
    return false;   // asyncOp: no success toast (app-ui.js result===false path)
  }
},
```

- The backend operation removes the device everywhere and rebroadcasts
  `device_list`; the card disappears via the normal WS path and the existing
  adoption logic in `app-ws.js` re-selects `activeDevice`. The browser makes
  no removal decisions.
- On failure: `bleError` feeds the scan-modal alert, the toast covers the
  card path, and `return false` stops `asyncOp`'s false success toast.
- The scan-list `paired`/`trusted` flag update is kept — the gw un-bonds the
  device, so a re-scan would show it unpaired.

## Files changed

`public/app-devices.js` only. NOT changed: `public/partials/tab-devices.html`
(both call sites keep the same signature — no markup change),
`public/app-ws.js` (adoption logic already handles a shrinking device_list),
backend files (previous task).

## Module summary (informational)

Device selection (`selectDevice`, `primaryDeviceId`), per-device cfg writes
(`saveDeviceCfg`, `saveBleCfg`, `saveAntennaCfg`), auto-purge settings,
BLE flows (`bleScan`, `bleConnect`, `submitPairPin`, `bleRemove`,
`disconnectDevice`), OTA management (`loadOtaFiles`, `flashOta`, …).
Known issues recorded in the 2026-07-16 device-management review (findings
4, 6–8) are NOT addressed by this task.

## `bleConnect()` defers to the NEED_PAIR overlay (task `render-pair-message`, 2026-07-25)

The 60s polling loop only special-cased `ble_state === 'error'` and
`'ready'` — a device that transitions to `need_pair` mid-connect (e.g. a
rejected stored PIN, mesh-gw report mcpp-chat `mesh-gw--node-dash`#4) was
never recognised, so the loop always ran out the full deadline and set the
generic `bleError = 'Connect timed out — check device and try again'`,
explaining nothing about the actual cause.

The loop now breaks immediately on `devState?.ble_state === 'need_pair'`
(tracked via a local `needPair` flag) without setting `bleError` — the
`device_list`-driven watcher in `app-ws.js` already opens the NEED_PAIR
overlay with the gateway's real `message`/`action_text` (see
`docs/modules/app-ws.md`), so `bleConnect()` steps back rather than racing
it with a second, less informative message.

## Test notes

- Playwright both themes: Devices tab renders, 0 console errors.
- Wiring: from the browser, `bleRemove('AA:BB:CC:DD:EE:FF')` (fabricated
  MAC) → backend 200 `{removed, node_id, gw}`, no console errors, real
  radios unaffected. Never click Remove on a real radio in validation.
- Failure path: fetch a junk key → 400 → error toast + `bleError` set, no
  "Device removed" toast.
