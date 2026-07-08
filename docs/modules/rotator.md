---
module: rotator
source: src/rotator.js
source_hash: 095603595f33979e384b6dc081626f30567874f815f188e7cf9769d527f964de
updated: 2026-07-07
---

# Module: rotator

## Purpose

WebSocket client for the YAGI antenna rotator hardware. Owns the connection,
reconnection, and all commands sent to the rotator. Also used as a shared
event bus by `active-tracker.js` for `point_target` and `signal_update`
events — callers that want rotator state changes listen on this singleton.

**Variant-aware (v4/v5 co-existence).** node-dash drives two rotator
firmwares that share a core contract (see `docs/ROTATOR_API_V5.md`): the WS
`:81` envelope, `{action,args}` command form, absolute-seek command,
`started`/`done` handshake, and the `az`/`northOffset` fields are common.
They differ only in (a) two renamed status fields — `busy`→`moving`,
`target`→`targetAz` — and (b) the motor-tuning / sensor-calibration shell
(v4 = PWM DC motor + QMC compass; v5 = NEMA8 stepper + AS5600 encoder,
`api:5`). This module auto-detects the variant from the status stream,
normalizes the renamed fields (keeping legacy aliases so existing consumers
are untouched), and lets the active target be switched at runtime.

## Responsibilities

- Open and maintain a WebSocket connection to the **active** rotator target
- Auto-detect the firmware variant (`v5` when `status.api === 5`, else `v4`)
- Normalize status: expose canonical `moving`/`targetAz` **and** keep legacy
  `busy`/`target` aliases so `scanner.js` / `ws-relay.js` work on both firmwares
- Reconnect on close after 5 s delay; send 5 s keep-alive pings
- `move(az)` sends the variant's native absolute-seek command
  (v4 `seek2az`, v5 `move2az`)
- Forward arbitrary actions to the rotator via `sendAction`
- Hold a config-driven target list and switch the active target on demand,
  tearing down and reconnecting

## Dependencies

- `ws` — WebSocket client
- `node:events` — EventEmitter base
- `db.js` — `getConfig`/`setConfig` for `rotator_targets` and `rotator_active`
- Environment: `ROTATOR_WS_URL` (v4) and `ROTATOR_V5_WS_URL` (v5) — device WS
  URLs. Real LAN addresses live in `ecosystem.config.cjs` env, never in source;
  the source default is `ws://localhost:81` (matches `bridge.js`)
- Reference: `docs/ROTATOR_API_V5.md` (symlink; v5 contract) — the rotator repo
  itself is out of bounds

## Public interface

```js
export const rotator  // singleton RotatorClient

// Lifecycle
rotator.start()                   // connect to the active target
rotator.stop()                    // terminate WS and all timers; does not reconnect

// Getters
rotator.connected                 // boolean — true when WS is open
rotator.variant                   // 'v4' | 'v5' | null — detected from status.api
rotator.activeTarget              // string — name of the active target (e.g. 'v4')
rotator.targets                   // [{ name, url }] — configured targets (rotator_targets)
rotator.status                    // object — NORMALIZED accumulated status (see below)

// Switching (persists rotator_active; reconnects to the new device)
rotator.setActiveTarget(name)     // → boolean; false if name is not a known target

// Commands (silently no-op when not connected)
rotator.move(az)                  // v4: { action:'seek2az', args:[az] }; v5: { action:'move2az', args:[az] }
rotator.sendAction(action, args?) // send { action, args } or { action }

// v5 device config schema (null on v4 — no schema command)
rotator.schema                    // [{ id, label, type:'num'|'bool', min, max, def, value }] | null
rotator.setConfigValue(id, val)   // → Promise<{ ok, msg, value }> (from the device's evt:reply)
```

### Normalized status shape

`rotator.status` (and each emitted `'status'` payload) is the inbound frame
plus these guaranteed fields:

| Field | Source | Purpose |
|---|---|---|
| `moving` | `moving ?? busy` | canonical in-motion flag |
| `busy` | `moving ?? busy` | **legacy alias** — `scanner.js:103` reads this |
| `targetAz` | `targetAz ?? target` | canonical commanded bearing |
| `target` | `targetAz ?? target` | **legacy alias** — `ws-relay.js:487` reads this |
| `variant` | detected | `'v4'` \| `'v5'` \| `null` |
| `caps` | per variant | `{ motor, sensor, presets, track, moveCmd }` descriptor |

`az` and `northOffset` are already common to both firmwares and pass through
unchanged. The aliases are why `scanner.js` and `ws-relay.js` need no edit.

## State

| Field | Type | Description |
|---|---|---|
| `_ws` | WebSocket\|null | Active connection |
| `_connected` | boolean | True when WS open |
| `_status` | object | Accumulated rotator status; merged from every inbound message |
| `_reconnectTimer` | Timer\|null | Pending reconnect handle |
| `_pingTimer` | Timer\|null | 5 s keep-alive ping interval |
| `_variant` | 'v4'\|'v5'\|null | Detected firmware variant (from `status.api`) |
| `_activeName` | string | Name of the active target (persisted as `rotator_active`) |

### Config keys (in `db.js` config table)

| Key | Default | Meaning |
|---|---|---|
| `rotator_targets` | `[{name:'v4',url:$ROTATOR_WS_URL},{name:'v5',url:$ROTATOR_V5_WS_URL}]` (env URLs, `ws://localhost:81` fallback) | Named targets. Overrides the env-derived defaults at runtime. No LAN IPs in source — they live in `ecosystem.config.cjs`. |
| `rotator_active` | `'v4'` | Which target is currently driven. Default `v4` = no behavioural change on deploy. |

## Events emitted (by rotator.js itself)

| Event | Payload | When |
|---|---|---|
| `'connected'` | — | WS open |
| `'disconnected'` | — | WS close (any reason); reconnect scheduled |
| `'status'` | inbound message object | Every message received from the rotator |

## Events emitted via `rotator` (by other modules — proxy bus use)

`rotator` is used as a shared event bus. These events are **not** emitted by rotator.js itself — they are emitted by callers via `rotator.emit(...)`.

| Event | Emitted by | Payload | Consumed by |
|---|---|---|---|
| `'point_target'` | `active-tracker.js` | `{ point_target, az, _mode, yagi_* stats }` | `index.js`, `ws-relay.js` |
| `'signal_update'` | `active-tracker.js` | `{ signal_num, rssi, snr, ts }` | `ws-relay.js` |

## Invariants

- `move(az)` and `sendAction(...)` silently no-op when `_connected` is false. Callers must not assume commands are delivered.
- **Back-compat aliases are load-bearing.** `status.busy` and `status.target` MUST remain present on both firmwares — `scanner.js:103` and `ws-relay.js:487` read them and are out of scope for this task. Normalization synthesizes them from `moving`/`targetAz` on v5.
- `move(az)` dispatches by detected variant: `seek2az` for v4 (live-verified working on `.186`), `move2az` for v5. Before the first status frame arrives `_variant` is null and v4's `seek2az` is used — safe because the default active target is v4; a v5 target self-corrects within one 100 ms frame.
- **Runtime switch:** `setActiveTarget(name)` persists `rotator_active`, resets `_variant`/`_status`, terminates the current WS, and reconnects. Variant is re-detected from the new device's stream.
- `_status` is an accumulated merge. Each inbound message is spread onto `_status`. Status fields are only ever added or overwritten — never deleted by this module. `setActiveTarget` clears `_status` so stale fields from the previous device do not leak.
- Reconnect is automatic on close. Calling `stop()` cancels the reconnect timer.
- The 5 s ping timer is started on `'open'` and cleared on `'close'`. It is never active while disconnected.
- `'status'` fires for **every** inbound message, including partial updates. Consumers must not assume a `'status'` event contains the full status object.
- **Code smell**: `index.js` attaches `_lastTracedNum` and `_lastTracedAt` directly to the `rotator` instance as ad-hoc state. These fields do not belong to this module and must be moved to `index.js`/`traceroute.js` state in a future refactor.
- **Proxy bus**: the `'point_target'` and `'signal_update'` events are emitted by `active-tracker.js` via `rotator.emit()`, not by this module. This is a design choice (single subscriber surface) but couples `active-tracker.js` to this module's EventEmitter identity.

## v5 device config schema & set replies (task rotator-device-schema-backend)

The v5 firmware self-describes its config and validates every set. node-dash
consumes this instead of a hardcoded schema (the device is the single
validator).

- **Subscription (v5 only):** on the first v5 detection, the client sends
  `{op:'set', events:['status','log','done']}` once (guard `_v5Init`). The
  `log` bit is what makes config replies arrive; without it the device streams
  only `status`. (It also enables `started`/`done` for a future closed-loop task.)
- **Schema:** the client then sends `{action:'schema'}`; the device replies
  `{evt:'schema', config:[{id,label,type:'num'|'bool',min,max,def,value}]}`
  (14 settings). Cached in `_schema`, exposed as `rotator.schema`, and emitted
  as a `'schema'` event (consumed by ws-relay to push to the browser).
- **Set + reply:** `setConfigValue(id, value)` sends `{action:id,
  args:[String(value)]}` and resolves the returned Promise on the matching
  `{evt:'reply', cmd:id, ok, msg, value}` — `ok` bool, `msg` the human
  `OK …`/`ERR … out of range [min..max]` text, `value` the live setting.
  Out-of-range is **rejected, not clamped**. Pending resolvers keyed by `cmd`
  in `_cfgPending` (Map); 3 s timeout → `{ok:false, msg:'no reply'}`. The
  duplicate `{log:'…'}` frame is ignored.
- **Reset:** `setActiveTarget` / disconnect clear `_schema`, `_v5Init`, and
  reject/clear `_cfgPending` (device changed).
- **v4** (`.186`, no `schema`/`reply`): `rotator.schema` is null; `setConfigValue`
  times out to `{ok:false}`. v4 config keeps the hardcoded `rotator-config-schema.js`
  path, selected by variant.

## Test notes

- **connect**: `rotator.start()` → WS opens → `rotator.connected === true` → `'connected'` fires
- **`move` (v4)**: variant v4 → `move(180)` → WS receives `{ action: 'seek2az', args: [180] }`
- **`move` (v5)**: variant v5 → `move(180)` → WS receives `{ action: 'move2az', args: [180] }`
- **`move` disconnected**: not connected → `move(180)` → no message sent, no error
- **`sendAction`**: `sendAction('setOffset', ['5'])` → WS receives `{ action: 'setOffset', args: ['5'] }`
- **status accumulation**: two inbound messages `{ az: 90 }` then `{ busy: false }` → `status.az === 90`, `status.busy === false`
- **variant detect (v5)**: frame `{ api:5, moving:true, targetAz:90 }` → `variant==='v5'`, `status.busy===true`, `status.target===90`
- **variant detect (v4)**: frame `{ busy:false, target:214.6 }` → `variant==='v4'`, `status.moving===false`, `status.targetAz===214.6`
- **switch**: `setActiveTarget('v5')` → returns true, `rotator_active` persisted, reconnects; `setActiveTarget('nope')` → false, no reconnect
- **reconnect**: WS closes → after 5 s → `_connect()` called again; `'disconnected'` fired before retry
- **stop**: `stop()` → `_connected === false` → reconnect timer cleared → WS terminated
- **ping interval**: on connect → `ws.ping()` sent every 5 s; on disconnect → interval cleared

## Out of scope

- Rotator hardware protocol — commands are JSON objects; the hardware interprets them
- Rotation completion detection — callers poll `rotator.status.busy`
- Which azimuth to point at — `active-tracker.js` and `scanner.js` decide that
- Signal tracking — `active-tracker.js` owns `point_target` / `signal_update` semantics
