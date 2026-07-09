---
module: dash-mode
source: src/dash-mode.js
source_hash: 2540caafb653a330e7c0b2a1a3bd1a54c7dee26f6f1cd2ec2c88a85efb304caa
updated: 2026-07-09
---

# Module: dash-mode

## Purpose

Single source of truth for the current dashboard operating mode. Persists the mode
to the config DB so it survives a process restart. Emits a `'change'` event on
every transition so all subsystems react without polling.

## Responsibilities

- Expose the current mode as `dashMode.value` (reads DB on every call)
- Persist mode changes via `setConfig`
- Emit `'change'` with the new mode on every `set()` call
- **Own the per-mode radio-role table — the single source of truth for which
  radio transmits a traceroute in each mode** (`transmitterForMode`)

## Dependencies

- `db.js` — `getConfig`, `setConfig`
- `device-config.js` — `getRotatorAddress`, `getPrimaryMac`, `macToNodeId` (role → node_id)
- `node:events` — EventEmitter base

## Public interface

```js
export const dashMode  // singleton instance of DashMode

dashMode.value         // getter → number — current mode (reads DB each call)
dashMode.set(mode)     // → void — persist mode and emit 'change'
dashMode.on('change', ({ _mode }) => {})  // EventEmitter listener

export function modeName(mode)              // number|string → 'pasv'|'actv'|'scan'
export function transmitterForMode(mode, ctx = {})  // → node_id — the single radio that TXs in this mode
export function isListenerForMode(mode, mac)        // → bool — is this radio a listener (rx) in this mode?
export function isTransmitterForMode(mode, mac)     // → bool — is this radio a transmitter in this mode? (tx:'rx' follows the listener)
```

## Per-mode radio roles (single source of truth)

Each mode has a **listener (`rx`)** role and a **transmitter (`tx`)** role. This
module is the one place that decides both — replacing the reception gates and
dispatch sites that each hardcoded `getRotatorAddress()`. Roles resolve live at
call time.

| Mode | Default `rx` (listener) | Default `tx` (transmitter) |
|---|---|---|
| `pasv` | `'non-rotator'` — any radio except the YAGI | `'rx'` — the radio that heard the node |
| `actv` | `'rotator'` — the YAGI | `'rotator'` — the YAGI |
| `scan` | `'rotator'` — the YAGI | `'rotator'` — the YAGI |

- **Role vocabulary:** `'rotator'`→YAGI, `'primary'`→OMNI, `'non-rotator'`→any
  radio ≠ YAGI, `'all'`→every radio, `'rx'` (tx only)→whichever radio heard the
  packet; any other string is an explicit MAC.
- **Consumers:**
  - `isListenerForMode(mode, mac)` — reception gate. `passive-tracer`,
    `active-tracker`, `scanner`, `bridge-events` gate on it so the configured
    listener controls which radio each mode actually receives on.
  - `isTransmitterForMode(mode, mac)` — per-radio predicate (badges, later phase);
    `tx:'rx'` resolves to the same set as the listener.
  - `transmitterForMode(mode, ctx)` — resolves the single dispatch node_id
    (through `macToNodeId`) for a traceroute; `'rx'` uses `ctx.rxDevice`.
- Defaults live in `MODE_DEFAULTS` and **reproduce the historic hardcoded
  behaviour exactly**. A browser-editable override is read from config key
  **`mode_config`** (per-mode `{ rx, tx }`), merged over the defaults — its
  read/write endpoint and config UI are later phases; unset today, so defaults apply.

### Mode values

| Value | Name | Behaviour |
|---|---|---|
| `0` | PASV | Passive monitoring. `passiveTracer` auto-traces nodes heard via radio. |
| `1` | ACTV | Active tracking. `activeTracker` runs the ACTV scan cycle. |
| `2` | SCAN | BLE scan. `scanner` drives the antenna rotation sweep. |

## State

No in-memory state. Mode is read directly from the config DB on every `value` access.

## Events emitted

| Event | Payload | When |
|---|---|---|
| `'change'` | `{ _mode: number }` | Every `set()` call, even if mode is unchanged |

## Invariants

- `dashMode.value` always reflects the DB value. There is no in-memory cache — a change written by any path is immediately visible to the next `value` read.
- `'change'` fires on every `set()` call. Callers must not assume it fires only on actual transitions — idempotent handlers required.
- Config key is `'rotator.dash_mode'` with default `0` (PASV). This key is owned by this module; no other module writes it.
- Mode is stored as an integer in the config table (JSON-serialised by `setConfig`).

## Test notes

- `dashMode.value` returns `0` when config key absent (default)
- `dashMode.set(1)` → `dashMode.value === 1`; `'change'` fires with `{ _mode: 1 }`
- `dashMode.set(0)` after `set(1)` → `'change'` fires again (even though reverting)
- Listener added via `.on('change', fn)` receives every transition

## Out of scope

- Mode transition side-effects — callers own those (index.js starts/stops activeTracker, scanner, passiveTracer on `'change'`)
- Validating mode values — callers are responsible for passing valid integers
- Broadcasting mode to browser — ws-relay.js listens to `'change'` and sends `rotator` WebSocket messages
