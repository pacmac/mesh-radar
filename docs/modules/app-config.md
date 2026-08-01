---
module: app-config
source: public/app-config.js
source_hash: 854aba0ebb8bbb818687eb89d4f3356b6b60f035d3423ff40db48b3ad1e26672
updated: 2026-08-01
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

## A channel PUT never carries a PSK the operator did not supply (task `channel-config-editor-broken`, 2026-08-01)

**The "preserve the locked PSK" behaviour described above silently destroyed the
value it existed to protect, and `channelWriteBody()` now refuses rather than
guesses.**

The chain, four links, each defensible alone:

1. `app-forms.js:107` — `psk` is in `SENSITIVE_FIELDS`, so it renders disabled
   behind an "unlock to edit" tick.
2. `app-forms.js:158` — `_collectFromInputs` skips disabled inputs, so a locked
   PSK is never collected.
3. `channelWriteBody()` compensated by merging the *current* settings.
4. …but "current" is mesh-gw's cache, and **the cache is stale**.

Link 3 is only safe if link 4 is truth. Measured 2026-08-01 22:33, fifty minutes
after a successful write: the OMNI's radio held `AQ==` — proven on air, 19 public
nodes heard where the previous 24 hours had none — while the cached channel had
no `psk` at all. So the form showed an empty key, `collectForm` returned no key,
and the merge supplied no key. **Saving any field — the name, the role, position
precision — would have written an empty PSK and put the radio back on a channel
the public mesh cannot decode.**

Proven before the fix by importing the real functions into the live page and
building the body without firing the PUT:

```
radio actually has:  psk AQ==
form showed:         (no psk)
collected:           (not collected — input disabled)
body that would PUT: {"settings":{"uplink_enabled":true,"channel_num":0,"name":"",
                      "id":0,"downlink_enabled":false,"module_settings":{…}},"role":"PRIMARY"}
```

### The rule

`channelWriteBody()` throws unless `psk` is present in `edited` — i.e. unless the
operator unlocked the field in this edit. Gated on the resulting role: a
`DISABLED` channel has no key to protect, so the five empty slots stay one-click
editable.

Deliberately **not** a silent fallback to the cached value, and deliberately not
a fix in `app-forms.js`. The disabled-input skip and the sensitive-field lock are
both correct in isolation and are shared by every config section; changing the
generic form layer to fix a channel-specific hazard would alter owner, bluetooth
and network writes that were never in question. The wrong assumption lives here,
so the guard lives here.

An explicitly-emptied PSK is still permitted — an unencrypted channel is a legal
Meshtastic configuration. The distinction the code now makes is **omitted versus
deliberately empty**, which is exactly the distinction it was missing.

### What this does not fix

Every other field still comes from the same stale cache, and a save still writes
cached values for `name`, `id`, `uplink_enabled` and `module_settings`. This stops
the PSK being destroyed; it does not make the form trustworthy. That needs a fresh
read, which is Domain 1 and needs mesh-gw's cooperation — see task
`radio-channel-divergence-undetected` for the related detection gap.

`docs/gw/API_REST.md:83` claims a write refreshes the cache. It does not, and the
comment at `app-config.js` in `saveChannel` — written from observation — is the
one to believe.

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
