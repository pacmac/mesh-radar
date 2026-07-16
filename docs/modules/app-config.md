---
module: app-config
source: public/app-config.js
source_hash: 1a52e153513e4ffbfff727b2591ab05037975803be8252fbcea8b49a0b7cd250
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

The write path is untouched: `submitOp('channel_config', target, …)` — the
op flow still verifies the write. The post-save refresh switches from the
per-channel GET to one bulk `GET cd('/channels')`, updating `ch.data` for
ALL channels (a role change can affect the set) and rebuilding the saved
channel's form from its fresh `ch.data`.

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
- Save path: DEFERRED in validation — exercising it writes channel config to
  a live radio (psk warning applies). The refresh logic is the same
  bulk-endpoint call pattern as loadChannels, verified by code path.
- Regression: sections (lora form) and owner form still load — their
  endpoints are unaffected.
