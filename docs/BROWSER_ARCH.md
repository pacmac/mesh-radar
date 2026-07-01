# Browser Architecture — State, SSOT, and Event Contract

Mandatory reading for every browser task. See also `docs/BROWSER_CONTRACT.md`.

---

## Principle

The browser holds no authoritative state. Every piece of application state is
owned by Node.js and pushed to the browser via WebSocket. The browser renders
what it is told and sends user actions back as REST requests. It never computes,
derives, or decides state.

---

## Canonical state ownership

The table below lists every significant state variable, who owns it, and the
canonical source that populates it. Variables marked **VIOLATION** are currently
computed or decided in the browser — they must be moved to the backend.

### Navigation and layout

| State | Owner | Canonical source | Notes |
|---|---|---|---|
| `tab` | Browser | URL path | Acceptable — tab reflects URL, not app state |
| `cfgTab` | Browser | localStorage | Acceptable — UI preference only |
| `sidebarPinned` | Browser | localStorage | Acceptable — UI preference only |
| `drawerOpen` | Browser | local | Acceptable — ephemeral UI toggle |
| `radioTab` | Browser | local | Acceptable — UI sub-tab |

### Device selection

| State | Owner | Canonical source | Notes |
|---|---|---|---|
| `activeNodeId` | **Backend** | `device_list.active_device` | **VIOLATION** — browser auto-selects when missing. Backend must send `active_device` in every `device_list` event |
| `cfgRadioId` | **Backend** | `device_list.active_device` | **VIOLATION** — same root as `activeNodeId`; collapse into one field |
| `msgFrom` | **Backend** | `device_list.active_device` | **VIOLATION** — auto-selected from device list |
| `availableDevices` | Backend | `device_list.devices` | ✓ Correct |
| `deviceBleStates` | Backend | `device_list` + `device_state` | Partially correct; see duplicate writers |

### Live nodes

| State | Owner | Canonical source | Notes |
|---|---|---|---|
| `nodes[]` | Backend | `node_list` WS event | ✓ Correct. But 7 different events currently patch it — only `node_list` should replace it; patch events should update specific fields only |
| `nodeCount` / `nodeTotal` | Backend | `node_list` | ✓ Correct |
| `homePos` | Backend | `node_list.homePos` | ✓ Correct |
| `nodeSelf` | Backend | `node_list` | 4 writers — must be owned by `node_list` only |
| `deviceNodes` | Backend | `node_list` | ✓ Correct |
| `nodeSort` | Browser | local | Acceptable — presentation preference |
| `nodeFilters` | Backend | `config` HTTP + WS push on change | Missing WS push — backend must emit `config_update` on filter change |
| `nodeSource` | Backend | `config` HTTP + WS push on change | Missing WS push |

### Rotator / radar

| State | Owner | Canonical source | Notes |
|---|---|---|---|
| `rotatorStatus` | Backend | `rotator` WS event | **3 writers** — only WS event is valid; remove scan_progress patch and optimistic moveRotator patch |
| `rotatorConnected` | Backend | `rotator.connected` field | **VIOLATION** — derived from field presence; backend must send explicit `connected: bool` |
| `rotatorMode` | Backend | `rotator._mode` | ✓ Correct |
| `yagiAz` | Backend | `rotator.az` | ✓ Correct |
| `yagiPointTarget` | Backend | `rotator.point_target` | ✓ Correct |
| `yagiSignal` | Backend | `signal_update` | 2 writers — `rotator` event should not reset it; only `signal_update` writes it |
| `radarCtx` | Backend | `radar_context` WS event | ✓ Correct (V2). Remove all local fallback logic that reads `rotatorMode` / local state |
| `passiveTraceNum` | Backend | `passive_trace_start` only | **VIOLATION** — `route_discovered` also sets it; backend sends one canonical event |
| `traceroutePending` | Backend | `radar_context.traceroute_active` | **VIOLATION** — currently set/cleared by browser; use `radar_context` |
| `radarRange` / `radarLogScale` / `radarCrosshair` | Backend | `config` HTTP + WS push | Missing WS push — backend must emit `config_update` when these change |
| `heatmapMaxAge` | Backend | `config` HTTP + WS push | Currently hardcoded 3600 — must come from backend |

### OTA

| State | Owner | Canonical source | Notes |
|---|---|---|---|
| `otaFiles` | Backend | `ota_file_list` WS event or HTTP | Currently HTTP-only; sufficient |
| `otaNvsDeadline` | Backend | `ota_progress.deadline` | ✓ Correct |
| `otaNvsCountdownSecs` | Browser | computed from deadline | Acceptable — pure display arithmetic |

### Scan

| State | Owner | Canonical source | Notes |
|---|---|---|---|
| `scanMode` | Backend | `scan_start` / `scan_end` | ✓ Correct |
| `scanData` | Backend | `scan_contact` | ✓ Correct |
| `scanProgress` / `scanCurrentAz` | Backend | `scan_progress` | ✓ Correct |

### Messages

| State | Owner | Canonical source | Notes |
|---|---|---|---|
| `messages[]` | Backend | `message_history` (full replace) + `text_message` (append) | **5 writers** — collapse to 2: full replace and live append only; remove localStorage seed and optimistic send |
| `unreadMessages` | **Backend** | new `unread_count` field on `message_history` / `text_message` | **VIOLATION** — browser counts based on `this.tab !== 'messages'`; backend tracks unread |
| `msgIsDirect` / `msgDirectTo` | Browser | user interaction | Acceptable — compose UI state |
| `msgFrom` | Backend | `device_list.active_device` | **VIOLATION** — see Device selection |
| `msgChannel` | Browser | local default | Acceptable — user preference |
| `_knownNodes` | Backend | `known_nodes` WS event | ✓ Correct |
| `ackStatus` / `ackFrom` | Backend | `message_status` WS event | ✓ Correct |

### Overlays and pairing

| State | Owner | Canonical source | Notes |
|---|---|---|---|
| `needPairAddr` | **Backend** | new `pairing_state` field in `device_list` | **VIOLATION** — browser derives from `ble_state` comparisons |
| `needPairError` | **Backend** | new `pairing_error` field | **VIOLATION** — browser infers from state transitions |
| `needPairBusy` | Browser | local after submit | Acceptable — optimistic while awaiting response |

### Telemetry / tilt

| State | Owner | Canonical source | Notes |
|---|---|---|---|
| `tiltHistory` | Backend | `tilt_history` (full) + `tilt_update` (append) | 2 writers is correct; append-only live update is fine |
| `tiltZero` / `tiltNorthAngle` | Backend | `tilt_cal` WS event | ✓ Correct — user actions POST then server pushes updated `tilt_cal` |
| `tiltPeak` | Browser | computed from `tiltHistory` | Acceptable — pure display calculation |
| `tiltRings` | Browser | computed from `tiltPeak` | Acceptable — pure display scale |
| `envHistory` | Backend | `env_history` + `telemetry_update` | ✓ Correct |

### Performance

| State | Owner | Canonical source | Notes |
|---|---|---|---|
| `perfHistory` | Backend | `traceroute_history` (full) + `route_discovered` (prepend) | 2 writers is correct; **declared twice** — remove mixin shadow |
| `loraCfg` | Backend | `config` HTTP | No WS push — sufficient for read-only display |
| `perfAutoNodes` / `perfAutoIntervalMin` | Browser | localStorage | Acceptable — UI preference |

### Range test

| State | Owner | Canonical source | Notes |
|---|---|---|---|
| `rangeLog` | Backend | `range_test_log` (full) + `range_test_entry` (prepend) | ✓ Correct |
| `rangeTimer` | Backend | `range_test_timer` | ✓ Correct |
| `rangeDuration` | Backend | `config` HTTP | No WS push — sufficient |

### Config

| State | Owner | Canonical source | Notes |
|---|---|---|---|
| `allSections` / `channels` / `ownerData` | Backend | HTTP only | Sufficient — loaded on demand |
| `bridgeConfigSchema` / `rotatorCfgSchema` | Backend | HTTP only | Sufficient |
| `alertRules` / `alertSmtp` | Backend | HTTP only | Sufficient |
| `radarCfg` | Backend | HTTP only | Sufficient |
| `homeLat` / `homeLon` | Browser | HTTP + user input | Acceptable — form field state |

### Dead state (remove)

These variables are declared but never correctly used:

| Variable | Reason |
|---|---|
| `serverReachable` | Hardcoded `true`, never updated — remove |
| `yagiConnected` | Superseded by `rotatorConnected` — remove |
| `blePins` | Declared but never populated or read — remove |
| `rangeLoading` | Never set true, range data arrives via WS — remove |
| `ownerSaved` / `ownerError` | Never mutated (saveOwner uses opFlow) — remove |
| `perfLoading` | Mixin declares it, never sets it true — remove |
| `mqttProxy` / `mqttCfg` | Reset in `_clearDeviceState` but never populated — remove or implement |

---

## New WS events the backend must add

These are required to eliminate browser decision violations:

| Event | Fields | Replaces |
|---|---|---|
| `device_list` (modify) | Add `active_device: node_id\|null` | Browser auto-select of `activeNodeId` |
| `device_list` (modify) | Add `pairing_state: {addr, error}\|null` | Browser NEED_PAIR detection logic |
| `device_paired` | `{addr, node_id}` | Browser toast from ble_state transition |
| `rotator` (modify) | Add `connected: bool` | Browser derives from field presence |
| `config_update` | `{key, value}` | Re-fetch config after changes made on other tabs/sessions |
| `text_message` (modify) | Add `unread_delta: 1` or backend tracks per-session unread | Browser tab-aware unread counting |

---

## Canonical handler map

One handler per WS event type. One state variable per concept.

| WS event | Writes to | Nothing else |
|---|---|---|
| `hello` | (internal gate, not re-emitted) | |
| `device_list` | `availableDevices`, `activeNodeId`, `msgFrom`, `cfgRadioId`, `deviceBleStates`, `needPairAddr`, `needPairError` | Remove all other logic |
| `device_state` | `deviceBleStates[addr]` only | Remove NEED_PAIR derivation |
| `device_data` | `deviceBleStates[addr]` only | |
| `device_paired` | (trigger toast, update `deviceBleStates`) | |
| `node_list` | `nodes`, `nodeCount`, `nodeTotal`, `homePos`, `nodeSelf`, `deviceNodes` | Nothing else writes these |
| `rotator` | `rotatorStatus`, `rotatorConnected`, `rotatorMode`, `yagiAz`, `yagiPointTarget`, `yagiTargetMeta` | Nothing else writes these |
| `signal_update` | `yagiSignal` only | Remove rotator event reset of yagiSignal |
| `radar_context` | `radarCtx` only — no local merge | Remove all local fallback |
| `tilt_update` | Append to `tiltHistory`; update `nodeSelf` tilt fields | Nothing else writes tiltHistory live |
| `tilt_history` | Replace `tiltHistory` entirely | |
| `tilt_cal` | `tiltZero`, `tiltNorthAngle` | |
| `telemetry_update` | `deviceNodes[id]` telemetry fields, append to `envHistory` | Nothing else writes these |
| `env_history` | Replace `envHistory` entirely | Remove nodeSelf env seed from here |
| `node_list` | `nodeSelf` | Only `node_list` writes `nodeSelf` |
| `message_history` | Replace `messages[]` entirely | Remove localStorage seed |
| `text_message` | Prepend to `messages[]`, increment `unreadMessages` | |
| `message_status` | Patch `messages[].ackStatus` | |
| `known_nodes` | `_knownNodes` | |
| `scan_start` | `scanMode=true`, `scanData`, `scanProgress`, `scanCurrentAz` | Backend decides whether nodes[] clears |
| `scan_progress` | `scanProgress`, `scanCurrentAz` | Must NOT write `rotatorStatus` |
| `scan_contact` | `scanData[az]` | |
| `scan_end` | `scanMode=false`, `scanProgress=null` | |
| `passive_trace_start` | `passiveTraceNum` | |
| `route_discovered` | Prepend to `perfHistory`; patch `nodes[num].last_traceroute` | Must NOT write `passiveTraceNum` |
| `radar_context` | `radarCtx` (includes `traceroute_active`, `active_card`, mode) | Replaces `traceroutePending`, `passiveTraceNum`, `activeCard` |
| `range_test_log` | Replace `rangeLog[]` | |
| `range_test_entry` | Prepend to `rangeLog[]` | |
| `range_test_timer` | `rangeTimer` | |
| `traceroute_history` | Replace `perfHistory[]` | |
| `ota_start` | `ops[otaFlash_id]` start | |
| `ota_progress` | `ops[otaFlash_id]` progress, `otaNvsDeadline` | |
| `ota_complete` | `ops[otaFlash_id]` end success | |
| `ota_error` | `ops[otaFlash_id]` end error | |
| `ota_download_start` | `ops[otaDownload_id]` start | |
| `ota_download_progress` | `ops[otaDownload_id]` progress | |
| `ota_download_complete` | `ops[otaDownload_id]` end success, trigger `otaFiles` reload | |
| `ota_download_error` | `ops[otaDownload_id]` end error | |
| `config_op` | Resolve pending `submitOp` promise | |
| `auto_purge_complete` | `autoPurge[device].last_run_ts` | Backend clears nodes — browser does NOT clear `nodes[]` |
| `auto_purge_error` | (toast only) | |
| `mqtt_node` | Patch `nodes[num]` | |
| `bridge_connected` | `bridgeConnected=true` | |
| `bridge_disconnected` | `bridgeConnected=false` | |

---

## Undeclared dynamic state (fix)

These are created at runtime outside Alpine's reactive scope and must be
declared in the state initialiser:

| Property | Should declare as |
|---|---|
| `_tiltHistoryAll` | `{}` |
| `_lastOtaStatus` | `null` |
| `_passiveTraceTimer` | `null` |
| `_initRadarRunning` | `false` |
| `_radarBeamAz` | `null` |
| `_deviceConfigsByMac` | `{}` |

---

## Fix sequence

Work in this order — each group depends on the previous being stable:

1. **Backend additions** — add `active_device`, `pairing_state`, `device_paired`,
   `rotator.connected`, `config_update` events. This unblocks all VIOLATION fixes.

2. **State consolidation** — eliminate multiple writers:
   - `nodes[]` — only `node_list` replaces; patch events update specific fields
   - `activeNodeId` / `msgFrom` / `cfgRadioId` — single writer: `device_list`
   - `rotatorStatus` — single writer: `rotator` WS event
   - `passiveTraceNum` — single writer: `passive_trace_start`
   - `messages[]` — two writers only: `message_history` (replace) + `text_message` (append)

3. **Remove browser decisions** — after backend additions land:
   - Remove NEED_PAIR overlay logic from browser
   - Remove `rotatorConnected` derivation
   - Remove `activeCard` local computation (use `radarCtx`)
   - Remove `radar_context` local fallback
   - Remove unread count logic (use backend field)

4. **Remove dead state** — after consolidation: `serverReachable`, `yagiConnected`,
   `blePins`, `rangeLoading`, `ownerSaved`, `ownerError`, `perfLoading`, mixin shadows.

5. **Declare undeclared dynamic state** — in state initialiser.

6. **UI bug fixes** (from `browser-ui-issues`) — only after architecture is clean.
