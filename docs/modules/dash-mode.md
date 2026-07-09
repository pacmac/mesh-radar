---
module: dash-mode
source: src/dash-mode.js
source_hash: 98c9594e159d2e18f17d84687aaa9327162a95b15cc794897a99951604e382dc
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
export function transmitterForMode(mode, ctx = {})  // → node_id — the radio that TXs in this mode
```

## Per-mode radio roles (single source of truth)

`transmitterForMode(mode, ctx)` is the one place that decides **which radio
transmits** an auto/manual traceroute for a given mode — replacing the four
call sites that each picked a radio independently. It resolves a role to a live
node_id at call time:

| Mode | Default `tx` role | Resolves to | Rationale |
|---|---|---|---|
| `pasv` | `'rx'` | `ctx.rxDevice` (the radio that heard the node), else primary | passive re-trace via the hearing radio |
| `actv` | `'rotator'` | `getRotatorAddress()` (YAGI) | the aimed antenna transmits — and perf measures it |
| `scan` | `'rotator'` | `getRotatorAddress()` (YAGI) | the sweeping antenna transmits |

- Defaults live in `MODE_DEFAULTS`. A browser-editable override is read from
  config key **`mode_config`** (per-mode `{ tx: <role|MAC> }`), merged over the
  defaults — its config UI is a later phase; unset today, so defaults apply.
- Roles: `'rotator'`→YAGI, `'primary'`→OMNI, `'rx'`→`ctx.rxDevice` (falls back to
  primary when absent), any other string is treated as an explicit MAC/node_id.
- The result is passed through `macToNodeId` so callers always receive node_id
  vocabulary (the `tx_device` attribution key), matching the prior behaviour.

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
