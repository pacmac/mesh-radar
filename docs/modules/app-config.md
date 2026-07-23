---
module: app-config
source: public/app-config.js
source_hash: 3573dd95dfecdcdb2482393a750014c037ccb4a63934b39e315eb1a72d81019e
updated: 2026-07-16
---

# Module: app-config

## Purpose

Browser config mixin (Domain 2): Config-page tabs (bridge/rotator/modes/
radar/alerts) plus the per-radio schema-form flows (device sections,
channels, owner) that render inside the Devices strips since
`radio-config-into-devices`.

## Scope of this spec

Created for task `channels-form-from-bulk` — it documents the channel-form
data-source change precisely; the rest of the module is summarised, not yet
fully specified (pre-existing code, unspecced before this task).

## Channel forms build from the bulk channel set (task `channels-form-from-bulk`, 2026-07-16)

`GET /{radio}/channels/{index}` triggers a gw-side live `get_channel_request`
admin round-trip which currently 500s on every channel of both radios
(mesh-gw `get_channel_live` dereferences a None admin response — gw fix in
progress in its own repo). The bulk `GET /{radio}/channels` reads the synced
channel set with no admin round-trip, works, and carries the identical
`{settings, role}` payload the form needs. The browser therefore builds
channel forms from the bulk data it already loaded and never calls the
per-channel GET:

### `onChannelToggle(ch)` (was app-config.js:166)

Before: fetched `/schema/channel` (kept) + `cd('/channels/' + ch.index)`
(removed), built `formData` from the live response.
After: `formData = { ...(ch.data?.settings || {}), role: ch.data?.role }` —
`ch.data` was populated by `loadChannels()` from the bulk endpoint when the
Channels tab opened. Everything else (nextFrame, `#ch_<i>` mount,
dirty-guard, loaded/loading/error state) unchanged.

### `saveChannel(ch)` (was app-config.js:189)

The channel endpoint replaces the complete `ChannelSettings` protobuf; it is
not a patch. `channelWriteBody()` therefore overlays edited fields on the
cached settings before `submitOp('channel_config', target, …)`. This preserves
locked fields omitted by `collectForm()`, especially the PSK. Role remains
outside `settings`, and the route index is not duplicated in the request body.

mesh-gw completes the BLE write but its bulk channel cache remains stale until
the next radio sync. The old post-save refresh immediately repainted the
pre-write values and made every save appear broken. The accepted full
replacement is now retained in `ch.data`, the form dirty flag is cleared, and
the form is rebuilt from that accepted state. A later device sync remains the
authoritative persistence confirmation.

### Known edge

If the bulk load hadn't populated `ch.data` yet (it resolves within the
Channels-tab entry; a same-instant toggle is the only window), the form
renders schema defaults instead of erroring. The gw fix does not change
this design — the bulk source stays correct after it.

## Files changed

`public/app-config.js` only (onChannelToggle + saveChannel refresh block).
NOT changed: `loadChannels` (already bulk), section/owner flows (their live
endpoints work), `tab-devices.html` (markup untouched), backend (gw bug is
cross-repo, fixed in its own session).

## Module summary (informational)

`switchCfgTab`, modes cfg load/save, `resetRadioCfg` (clears + reloads per
`radioTab` — called by the Devices strips' Radio/Channels/Owner tab clicks),
`loadSections`/`onSectionToggle`/`saveSection` (+ fixed position),
`loadChannels`/`onChannelToggle`/`saveChannel`, `loadOwner`/`saveOwner`.
Forms build via `buildForm`/`collectForm` (app-forms.js) into element-ID
mounts; ops verify via `submitOp` (op-client.js).

## Test notes

- Live: Devices → expand radio → Channels → open a channel → form renders
  with the radio's real values (e.g. channel 1 name "mqtt"), no request to
  `/channels/{index}`, no console error.
- Unit: `tests/test_channel_write.mjs` proves omitted locked settings are
  preserved and role is separated.
- Live: OMNI channel 3 accepted through the UI, survived a controlled radio
  reconnect, then was restored to unused and verified after a second reconnect
  (`browser-page-playwright-audit`, 2026-07-23).
- Regression: sections (lora form) and owner form still load — their
  endpoints are unaffected.
