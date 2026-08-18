---
module: app-config
source: public/app-config.js
source_hash: 76d92417ecd58f50216fcd57cdba353f039a8687d7c34a05df3b3e7ba0495351
updated: 2026-08-03
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

## `loadDiscoveryCfg` / `saveDiscoveryCfg`

Mirrors the radar pair. Fetched on first view rather than WS-pushed: this is a
**form flow**, which `BROWSER_CONTRACT` permits a GET for — the WS-only rule is
about display values, not the current contents of a settings form the user is
about to edit.

**Re-reads after saving** instead of trusting the form. The server clamps
(`docs/modules/config-api.md`), so what was typed and what was stored are not
always the same value.

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

## The callout transmit switch applies immediately

Peter, 2026-08-05: *"I switched off callout broadcasts but it's still
broadcasting."*

The toggle was `x-model="calloutCfg.enabled"` and nothing else. The server was
written **solely** by the Save button, so flipping the switch changed local Alpine
state and left the transmitter running: the UI read "off" while callouts went out
on the **public mesh** three times in the following two hours (last 17:23).

A UI that displays "off" over a live transmitter is worse than one with no switch
at all, and a kill switch that needs a second click on a different control is not
a kill switch.

`setCalloutEnabled(on)` therefore writes on `@change`:

- **sends only `enabled`.** The route treats absent keys as unchanged, so hitting
  the kill switch cannot commit a half-edited template or an in-progress number
  field as a side effect. Verified: an `enabled`-only write left all 5 templates
  and `min_km 50` intact.
- **re-reads** afterwards rather than trusting the click, and
- **reverts the toggle** if the write failed, so the switch can never disagree
  with the transmitter.

Everything else on the callout form still requires Save — the label says so,
because the two behaviours now differ and the difference matters.

Verified with a real browser click (not curl): server `false → true`, templates
intact, then back to `false`.

## A section's KIND decides which admin field it is saved to — 2026-08-18

Peter: *"have you actually tried saving something and validating it was saved ? -
you can do that in some of the not used sections like ambient lightiung"*.

I had not. The write path was built, shipped and never once exercised against a
real radio. **The first live save found this.**

`saveSection()` posted to `/radio-admin/config` unconditionally. But a section
carries a `kind`, set in `loadSections()` and — until now — **read nowhere else in
the file**:

```js
const makeSec = (name, kind) => ({ name, kind, ... });
...sec.config.map(name        => makeSec(name, 'config')),
...sec.module_config.map(name => makeSec(name, 'module_config')),
```

The UI has been *rendering* that kind as a badge beside every section title all
along, so the screen displayed the distinction the save path ignored.

Proven live, posting `ambient_lighting` the way the UI does:

```
POST /radio-admin/config {"section":"ambient_lighting", ...}
-> Message type "meshtastic.protobuf.Config" has no field named
   "ambient_lighting" at "AdminMessage.set_config".
   Available Fields: ['device','position','power','network','display','lora',
                      'bluetooth','security','sessionkey','deviceUi']
```

**13 of 21 sections could not be saved at all**: `mqtt`, `serial`,
`external_notification`, `store_forward`, `range_test`, **`telemetry`**,
`canned_message`, `audio`, `remote_hardware`, `neighbor_info`,
`ambient_lighting`, `detection_sensor`, `paxcounter`. The 8 `config` sections
were unaffected.

`telemetry` being in that set is the sharp end: the interval-dropdown work in
`7c81c49` exists to stop a bad *telemetry* interval reaching the radio, and it
saved through a path that could never work. The control was right, the schema was
right, and Save was never pressed.

### The change

```js
const path = sec.kind === 'module_config' ? 'module-config' : 'config';
await fetchJSON(`/radio-admin/${path}`, 'POST', { ... });
```

The backend already had both endpoints and both verbs — `setConfig` and
`setModuleConfig` map to `set_config` and `set_module_config`. Only the browser's
choice between them was missing.

**Defaulting to `config` for an unknown kind is deliberate.** `kind` comes from
the backend's own `/sections`, so a third value would mean that contract changed;
falling back to the historical behaviour keeps the 8 working sections working
rather than breaking everything at once.

### It fails loudly, and that is worth keeping

The wrong field produces a protobuf error naming the exact mismatch, not a silent
no-op. That is the only reason this was a *broken* feature rather than a *lying*
one. Any future change here must preserve that: a save that cannot work must
never report success.

### Test notes

- an `ambient_lighting` save posts to `/radio-admin/module-config`, a `device`
  save to `/radio-admin/config`
- read-back from the radio (not from a cache) shows the written value
- falsification: forcing the path back to `config` reproduces the protobuf error

## A save follows the phone app: optimistic, then re-read on next open — 2026-08-18

Peter, reporting a false alarm raised by this module's own code:

> store forward did NOT match after saving — is_server: sent false, radio has true

then *"seems to me that this will never work"*, and — when the reply was a menu
rather than an answer — *"how does phone app handle it. that will always be my
reply"*.

**His save had worked.** The alarm was wrong.

```
backups/!2687afb1/260818153011.json   (taken PRE-save)
   store_forward = {"enabled": true, "heartbeat": true, "is_server": true}
radio, ?fresh=1
   store_forward = {"enabled": true, "heartbeat": true}
```

`is_server` is absent because **`false` is the protobuf default and the GET omits
defaults**. The radio took the write.

### Why synchronous verification cannot work

Not a tuning problem. Two independent reasons, either of which is fatal:

1. **The read-back races the reboot.** The radio restarts after a save, and the
   gateway's cache serves pre-save values meanwhile — measured,
   `RECONNECTING 14:50:35 → READY 14:50:51`, about 16 s. `?fresh=1` does not help
   while the device is reconnecting.
2. **Turning a boolean OFF makes it vanish.** "Set to default" and "absent" are
   the same thing on the wire. So the commonest edit anyone makes — switching
   something off — is exactly the one that can never be confirmed.

Together they mean the check fires on the **normal path**, and an alarm that fires
on the normal path is worse than no alarm. The previous version of this section
said precisely that about `unconfirmed`, and then shipped a `mismatch` that did it.

### What the app does instead

`RadioConfigViewModel.setConfig` / `setModuleConfig`:

**1. Optimistic local update, from what was sent.**

```kotlin
state.copy(moduleConfig = state.moduleConfig.copy(
    store_forward = config.store_forward ?: state.moduleConfig.store_forward, …))
```

No read-back. No comparison. The word "verified" appears nowhere in the path.

**2. The restart is declared, not discovered.**

```kotlin
expectRestartIfLocal(config.saveRebootBehavior())
```

**3. The single exception states the rule** — their comment, verbatim:

> LoRa is intentionally NOT applied optimistically: the firmware can clamp or
> region-swap (e.g. EU sibling) a LoRa write and applies it live, so the form must
> reflect the device's actual value. **It is re-read from the device when the LoRa
> screen is next opened.**

So: trust the write; where the firmware may **alter** what you sent, re-read — and
re-read **when the screen is next opened**, never synchronously. By then the radio
has rebooted and resynced, which dissolves both failure modes above.

### The change

| before | after |
|---|---|
| POST, immediately GET, compare, alarm on difference | POST, update the form from what was **sent**, mark the section stale |
| "«section» saved & verified" | "«section» saved — radio is restarting" |
| `verifySaved()` + `tests/test_verify_saved.mjs` | **deleted** |

`sec.loaded = false` after a save is the whole of the re-read mechanism:
`onSectionToggle` already returns early when `sec.loaded`, so clearing it makes the
next open fetch from the device. That is the app's "re-read when the screen is next
opened", and it needs no timer, no polling and no waiting.

**`verifySaved` is deleted rather than left unused.** Dead code with a passing test
attached is worse than no code: the green check implies a guarantee that nothing
provides.

### Why "saved" is honest and "verified" was not

The app treats queue acceptance as success (`CommandSenderImpl.enqueueOrThrow` —
the only failure is the queue refusing the packet). It never claims delivery, and
neither should the UI. `docs/modules/radio-admin.md` carries the same reasoning for
the backend.

The audit chain remains the thing that can actually prove what was written: a
backup precedes every save, and the diff between consecutive files is the record.
That is verification done where it works — **after** the fact, against a settled
device — rather than 200 ms after a write, against a cache.

### Deliberately NOT changed

**The two OTHER `verified` claims** — config restore (`tab-devices.html:654`) and
`pushFixedPosition` (`app-devices.js:125`) — test a `verified` flag returned by
mesh-gw's older cooked PUT, which `radio-admin-api.js` records as reporting
`{"verified": true}` without verifying anything. A different endpoint on a
different path; they stay in the ledger.

### Test notes

- saving a section leaves `sec.loaded === false`, so reopening re-reads
- the form repaints from the values **sent**, so a boolean switched off shows off
- no request is made to `/config/{section}` between the POST and the toast
- `verifySaved` is gone from `app-forms.js`, and `check_all` no longer lists
  `verify_saved`

### Related finding, recorded separately

**A save that returns an error may have succeeded.** A write returned
`BleakGATTProtocolErrorCode.UNLIKELY_ERROR` and dropped OMNI to `RECONNECTING` —
and the value had already landed, confirmed after reconnect. A 502 from this
endpoint is *not* evidence the radio is unchanged, and no "did it save?" logic
may assume it is.

