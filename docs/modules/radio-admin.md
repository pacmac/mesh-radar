---
module: radio-admin
source:
  - src/radio-admin.js
  - src/radio-admin-api.js
  - src/op-manager.js
source_hash: 5edaa4addc1bac89ffd724eda5c186ac2f7dfcf91406ba9dc0989ab1aedd8e8e
updated: 2026-08-18
---

# Radio config, written the way the phone app writes it

Peter, 2026-08-18: *"I do NOT want you to patch the existing code, I want it
ripped out and re-done based on the exact same method that the phone app does."*
Said four times. **A change that modifies the existing save path is a failed task
even if it works.** The old code is deleted; this is a new module.

And: *"the phone app is 100% reliable, no reason that if we do the same we will
also be 100% reliable."*

## The method, taken from the two authorities

Established by reading Meshtastic's own firmware and the official Android app —
not from documentation, and not invented here.

### What the firmware does — `AdminModule.cpp`

```c
void AdminModule::saveChanges(int saveWhat, bool shouldReboot) {
    if (!hasOpenEditTransaction) { service->reloadConfig(saveWhat); }   // the disk write
    else { LOG_INFO("Delay save of changes to disk until the open transaction is committed"); }
    if (shouldReboot && !hasOpenEditTransaction) { reboot(DEFAULT_REBOOT_SECONDS); }
}
```

- **The firmware decides the reboot, not the caller.** `handleSetConfig` computes
  `requiresReboot` itself (defaults true, set false at six sites — e.g. no LoRa
  parameter actually changed) and passes its own verdict in.
- **`reboot_seconds` is a separate admin command.** A config write never sends it.
  Peter: *"do not call a restart if it is not needed... the device will restart
  itself if it needs to and that may NOT be a manual request."* Correct.
- **A SET's only reply is a bare Routing ACK**, and only if `want_response` is
  set: `if (mp.decoded.want_response && !myReply) myReply = allocErrorResponse(Routing_Error_NONE, &mp)`.
  **There is no reboot flag in any reply** — searched `admin.proto`; the only
  reboot fields are request fields. The firmware never announces its intention.
- It *does* name a rejection — `ADMIN_BAD_SESSION_KEY`, `NOT_AUTHORIZED`,
  `BAD_REQUEST` — but again only when `want_response` is set.

### What the app does — `AdminControllerImpl.kt`, `RadioConfigViewModel.kt`

```kotlin
override suspend fun setConfig(destNum: Int, config: Config, packetId: Int) {
    commandSender.sendAdmin(destNum, packetId) { AdminMessage(set_config = config) }
    if (destNum == myNodeNum) { radioConfigRepository.setLocalConfig(config) }
}
```

- **Setters send `want_response = false`** (the interface default). Only the
  *getters* pass `wantResponse = true`. So the app does not wait for an ack on a
  save, and mesh-gw's `want_response=False` matches it.
- It writes its own local store **optimistically**, exactly as mesh-gw's cache does.
- **It does not use `begin_edit_settings` / `commit_edit_settings` at all** —
  checked in the ViewModel, the UseCase and the RepositoryImpl. Worth knowing,
  because `commit` unconditionally reboots (`saveChanges` defaults
  `shouldReboot = true` and the flag is cleared first), so wrapping a
  single-section save in a transaction would *cause* a reboot the firmware would
  otherwise have skipped.
- **The reboot is the evidence.** `RadioConfigViewModel`: *"A reboot-applying save
  can't survive the reboot it triggers: the node drops the transport before the…
  the save was persisted (firmware only reboots after saveChanges writes to
  disk)"*. It opens an expected-restart window and resolves the save to success on
  the transport-drop edge, with a timeout backstop.
- **Where there is no reboot** (a channel batch) it resolves per pending request
  id — *"the batch stays in flight through its ack-wait"*.

## How that maps onto node-dash, and why it fits better here

The app is the BLE client and must re-read after the reboot to reconcile. We get
that free: mesh-gw's `RECONNECTING → SYNCING → READY` issues `want_config_id` and
drains the whole config from the radio on every reconnect (`ble_device.md:21`). So
the reboot that proves the save also refreshes the cache with ground truth.

Peter, on the cache: *"the mesh-gw cache is trusted... if I use my phone to change
config, the mesh gw needs to be disconnected, when it reconnects it will re-read
the configs"*, and *"it's not your responsibility to ensure that mesh-gw is / is
not stale"*. So this module reads through mesh-gw and does not build a shadow
verification path.

## What is DELETED

### `src/op-manager.js` — five ops, all `class: 'Radio'`

| op | endpoint it drove |
|---|---|
| `radio_config_section` | `PUT /{target}/config/{section}` |
| `channel_config` | `PUT /{target}/channels/{index}` |
| `owner_info` | `PUT /{target}/owner` |
| `fixed_position_push` | `PUT /{target}/fixed_position` |
| `fixed_position_clear` | `PUT /{target}/fixed_position` |

All five wrote through mesh-gw's cooked PUT surface, which returns
`{"verified": true}` the instant the BLE write returns and then overwrites the
cache with what was sent. Two of them carried `read_back_path` + `match_fields`,
and that read-back compared our own input against our own input — it could not
fail, and in two weeks it never did.

`send_message` is NOT radio config and stays. The `device_config_*` ops are
node-dash's own per-device metadata (`class: 'Local'`) and stay.

### `public/app-config.js` — the five `submitOp` call sites

Lines 170, 175, 188, 242, 285 and the save functions around them.

## What is BUILT

### `src/radio-admin.js` — the write path

One function per admin verb, each composing an AdminMessage and posting it to
mesh-gw's pass-through:

```
POST /{node_id}/admin  {"message": {<AdminMessage field>}, "want_response": false}
```

| function | AdminMessage |
|---|---|
| `setConfig(dev, section, values)` | `{set_config: {<section>: values}}` |
| `setModuleConfig(dev, section, values)` | `{set_module_config: {<section>: values}}` |
| `setChannel(dev, index, settings)` | `{set_channel: {index, settings}}` |
| `setOwner(dev, user)` | `{set_owner: user}` |
| `setFixedPosition(dev, lat, lon, alt)` | `{set_fixed_position: {...}}` |

**No `session_passkey`.** mesh-gw attaches it; node-dash never sees it. Peter:
*"why do you even need to know the passcode ... that secret is theirs to keep."*

**No `begin_edit_settings`, no `commit_edit_settings`, no `reboot_seconds`.** The
app uses none of them for a save, and commit would force a reboot the firmware
would otherwise skip.

**Completion**, mirroring the app: watch mesh-gw's device state for the
`READY → RECONNECTING|SYNCING` edge, which is our transport-drop equivalent, and
resolve to success ("radio restarting") when it appears. Timeout backstop for the
sections the firmware applies without a reboot.

### `src/radio-admin-api.js` — the browser-facing surface

`POST /radio-admin/{config|module-config|channel|owner|fixed-position}`. The
browser submits form values and renders the result. It composes no AdminMessage,
chooses no section order, and decides nothing.

### `GET /radio-admin/owner/:device` — the read that tells the truth about role

Added 2026-08-18, task `owner-form-role-truth`.

mesh-gw's cooked `GET /{id}/owner` returns `short_name` and `long_name` and
**silently drops `role`**. The radio does answer with it — a genuine
`get_owner_request` returns `role: CLIENT_BASE` — so the field is lost in the
cooking, not missing from the device.

The Owner form then fell back to a hard-coded `'CLIENT'` and showed the operator a
role the radio does not have. It was harmless only by coincidence: `saveOwner`
strips `role` when it equals `ownerData?.role ?? 'CLIENT'`, and with `role`
undefined both sides computed to `'CLIENT'`. Change either half and saving the
Owner tab **demotes the radio from CLIENT_BASE to CLIENT**.

This route returns mesh-gw's owner fields with `role` filled in from
`nodeinfo.role` / `nodes.role`, which node-dash populates from the radio's own
**NodeInfo announcements** — first-hand, and neither a guess nor mesh-gw's cooked
view. A role change reboots the radio, which re-announces, so it self-heals.

`role` is `null` when we genuinely do not know it, and the browser renders the
field empty rather than inventing a default. **A form that guesses is how this
defect existed at all.**

An admin `get_owner_request` round trip would also work and costs ~471 ms per form
load; it is not used because the answer is already here at ~0 ms, from a
first-hand source.

### The timestamped backup, before EVERY save

Peter: *"by having a yymmddhis filename we have a full record of all changes made
to any device, if this is done before EVERY save."*

```
backups/<node_id>/YYMMDDHHMMSS.json
```

Sourced from `GET /{id}/radio_backup` — 2.5 ms, and the cache is trusted per
above. **24-hour clock**, not the 12-hour `h` of the PHP-style format Peter wrote:
two saves at 09:15 and 21:15 would otherwise collide and sort wrongly, and a
record that sorts wrongly is not a record.

Before every save without exception — skipping any save breaks the chain, and a
chain with holes is not a record. ~2.6 KB each; no retention policy, because
silently deleting audit history is worse than the disk cost.

The diff between consecutive files is then the change log for that radio.

## Test notes

1. A LoRa section save reaches the radio: read it back after the reconnect and it
   holds the new value.
2. A save the firmware applies WITHOUT a reboot still resolves (timeout backstop),
   and does not report failure.
3. `reboot_seconds` never appears in any AdminMessage this module sends.
4. `session_passkey` never appears in any AdminMessage this module sends.
5. A backup file exists for every save, named `YYMMDDHHMMSS.json`, and the diff
   against the previous file shows exactly the fields that changed.
6. `grep -n "radio_config_section\|channel_config\|owner_info" src/op-manager.js`
   returns nothing.
