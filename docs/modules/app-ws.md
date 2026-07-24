---
module: app-ws
source: public/app-ws.js
source_hash: 3144454ff60ab0f93c1d5c62bea862e17dd95a7621ee5dc36b2ceeccbf85c2e3
updated: 2026-07-24
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

- `node_status_age` dispatches to `applyNodeStatusAge(ev)`. The event contains
  only server-formatted focused-node clock state; the browser performs no date
  arithmetic and does not request page data with GET.

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

## Phase C1 — traceroute history handlers

- `traceroute_history` replay: stores `ev.rows` in `_trHistAll`, adopts
  `ev.failure_epoch`, re-slices `perfHistory`. (Previously ignored by
  design; that design violated BROWSER_CONTRACT's WS-only transport.)
- `traceroute_failed`: prepends `ev.row` to `_trHistAll` (cap 500) and to
  `perfHistory` when `row.tx_device === perfDev()`.
- `route_discovered`: entry now carries `id` (DB row id) and `status:'ok'`,
  is pushed to `_trHistAll` for all devices, and prepends to the visible
  slice only on scope match. `ev.ts` in ms is normalized to seconds.

## Phase C2 — device_list ingestion

The handler builds `_deviceConfigsByMac` from `dev.cfg` on every
device_list (replacing GET /device-config), seeds primary-as-active when
no persisted choice exists (moved from the deleted `loadDeviceConfigs`),
and adopts `dev.lora` into `loraCfg` for the perf page's selected radio.

## Phase C3a — device selection keyed by MAC

The selection SSOT is `activeDevice` (BLE MAC, persisted as
`activeDevice`); `activeNodeId` is a derived getter (its setter maps
legacy node_id writes to the MAC). The adoption block re-adopts the
persisted MAC; a one-time shim converts a legacy persisted `!hex`
selection via the device list. Consequence of MAC keying: a radio keeps
its selection across factory resets that change its node_id. The
never-persist-on-adoption invariant is unchanged — only selectDevice and
set-primary persist.

## settings-via-ws handlers

- `settings`: assigns nodeFilters/nodeSource/radar prefs/packetSources/
  failure epoch/range duration — replaces the deleted `loadConfig` GET;
  arrives on connect and after every config write (all tabs live).
- `geocode_result`: resolves the pending `wsGeocode(num)` promise.
- `wsGeocode(num)`: client→server RPC with 30 s timeout; replaces the
  `geocodeNode` fetch helper (radar batch + node info panel both use it).
- device_list ingest also stores `dev.auto_purge` under the device node_id
  (replaces `loadAutoPurge`).

## History array caps — memory-leak fix (task `cap-tilt-history-leak`, 2026-07-09)

Per-node history arrays are bounded to `MAX_HISTORY_ROWS` (2000) so a long-lived
tab does not leak: `tilt_update` appends to `tiltHistory` live (unbounded + O(n)
copy per update), and the `tilt_history` / `env_history` replays re-accumulate
into `_tiltHistoryAll[node]` / `envHistory[nid]` on every WS reconnect. Each is
now `.slice(-MAX_HISTORY_ROWS)`; charts only ever show a recent window. Other
live arrays were already capped (events 80, messages 50, perfHistory 200,
_trHistAll 500).

## NEED_PAIR dismissal on success (task `pair-modal-dismiss`, 2026-07-16)

`submitPairPin` keeps `needPairBusy = true` while the gw retries pairing; the
failure paths (`device_state` NEED_PAIR → wrong-PIN message, OFFLINE →
pairing-failed message) clear it. The SUCCESS path never did — and the
`device_list` dismissal branch was gated on `!needPairBusy`, so after a
correct PIN the modal (`index.html`, `x-show="needPairAddr"`) stayed up
forever.

The dismissal branch now handles success regardless of `busy`: when
`needPairAddr` is set, no device is in `need_pair`, and the pairing device's
`ble_state` is `discovering`/`syncing`/`ready`, it toasts
"Device paired successfully" and clears `needPairAddr`, `needPairBusy`, and
`needPairPin`. The device-vanished fallback (dismiss without toast) stays
gated on `!needPairBusy` so a transient dropout during a busy retry doesn't
kill the modal prematurely; the wrong-PIN/OFFLINE feedback in the
`device_state` handler is unchanged.

## Live reply threading (task `live-reply-threading`, 2026-07-17)

The live TEXT_MESSAGE_APP append previously set flat thread fields
(threadRootPktId=pktId, replyDepth=0, isReply=false) and ignored
`decoded.reply_id`, so a reply arriving live showed un-indented until the
next on-connect message_history replay re-threaded it ("only after refresh").
The handler now builds the entry with its real `replyId` and calls the shared
`_insertThreadedMessage` (messagesMixin) which resolves the parent in
`this.messages`, computes threadRootPktId/replyDepth/isReply/isOrphan, splices
the entry after the parent's thread (else unshift), and caps at 200 — the same
threading `sendMessage` applies to TX. The stray 50-cap here is removed.
