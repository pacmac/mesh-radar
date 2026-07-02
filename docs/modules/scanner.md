---
module: scanner
source: src/scanner.js
source_hash: 69a829af6431bf1105d2f7b8f1553036c22ccfe7aa520fb617648be225444a73
updated: 2026-06-30
---

# Module: scanner

## Purpose

SCAN mode sweep controller. Drives the YAGI rotator through azimuth positions
(0°–355° in configurable steps), dwells at each position to listen for BLE
packets, and records the best-SNR contact per azimuth. Persists sweep state to
the config DB so a server restart can resume mid-sweep.

## Responsibilities

- Move the rotator to each azimuth in `step_deg` increments via `rotator.move`
- Wait for the rotator to stop moving (poll `rotator.status.busy`), with 25 s timeout
- Dwell at each azimuth for `dwell_sec` seconds accepting bridge packets
- Record the best-SNR contact per azimuth in `_contacts`
- Persist `scan_state` to the config DB on every step and contact update
- Resume from persisted state after server restart via `resume(state)`
- Emit events for progress, contacts, and sweep completion

## Dependencies

- `rotator.js` — `rotator.move`, `rotator.status.busy`
- `device-config.js` — `getRotatorAddress`
- `db.js` — `getConfig`, `setConfig` (for `scan_config` and `scan_state`)
- `node:events` — EventEmitter base

## Public interface

```js
export const scanner  // singleton Scanner instance

// Lifecycle
scanner.start()          // begin sweep from 0°; idempotent if already active
scanner.resume(state)    // resume from persisted scan_state; idempotent if active
scanner.abort()          // stop sweep immediately; emits 'end' with aborted: true

// Packet ingestion
scanner.handlePacket(ev) // feed bridge 'event' packets — call during active dwell only

// Getters
scanner.active           // boolean — true while sweep is in progress
scanner.az               // number — current rotator target azimuth
scanner.dwellAz          // number|null — azimuth currently accepting contacts (null when moving)
scanner.contacts         // object — { [az]: { az, from, snr, rssi, ts } }
```

## State

| Field | Type | Description |
|---|---|---|
| `_active` | boolean | Sweep is in progress |
| `_az` | number | Current target azimuth (0–360) |
| `_step` | number | Degrees per step (from `scan_config.step_deg`, default 5) |
| `_dwell` | number | Seconds per position (from `scan_config.dwell_sec`, default 60) |
| `_preMode` | number | Dashboard mode value before scan began; restored on `'end'` |
| `_dwellAz` | number\|null | Azimuth currently in dwell; null when moving between positions |
| `_timer` | Timer\|null | Active timeout handle (poll or dwell) |
| `_aborted` | boolean | True when `abort()` was called; prevents restart in `_end()` |
| `_contacts` | object | Best contacts keyed by azimuth number |
| `_pollStart` | number | `Date.now()` when polling for rotator-idle began (for 25 s timeout) |

## Config keys

| Key | Default | Meaning |
|---|---|---|
| `scan_config.step_deg` | 5 | Degrees between scan positions |
| `scan_config.dwell_sec` | 60 | Seconds to wait at each position |

## Persistence (config DB key `scan_state`)

Written on every step and contact update:
```js
{ active: true, az, step, dwell, contacts, preMode }
```

Written on abort/end:
```js
{ active: false }
```

On startup, `index.js` reads `scan_state`. If `active: true`, it calls `scanner.resume(savedScan)` after the rotator first connects, so the sweep continues from the saved azimuth.

## Sweep step machine

```
start() / resume()
  → _doStep()
      → if az >= 360 OR aborted → _end()
      → _dwellAz = null
      → rotator.move(az)
      → after 600 ms → _pollIdle()

_pollIdle()
  → if aborted → _end()
  → if !rotator.status.busy OR timedOut (25 s since _pollStart)
      → _dwellAz = az        ← contacts accepted from this point
      → emit 'progress' ({ az, dwell_az: az })
      → after dwell_sec → _dwellAz = null; az += step; _doStep()
  → else → after 200 ms → _pollIdle()   (repeat until idle or timeout)
```

## Contact recording (`handlePacket`)

Accepts a packet during dwell only (`_active && _dwellAz != null`). Filter:
1. If `rotatorId` configured: `ev.device === rotatorId` (v1; post-v2: `ev.__ble_addr`)
2. `pkt.from` must be non-null
3. At least one of `rx_snr` or `rx_rssi` must be present

Best-SNR wins per azimuth: replaces `_contacts[az]` only if new `snr > existing.snr`. Contact shape:
```js
{ az, from: pkt.from, snr, rssi, ts: Math.floor(Date.now() / 1000) }
```

## Events emitted

| Event | Payload | When |
|---|---|---|
| `'start'` | `{ step, dwell }` or `{ step, dwell, resumed, az, contacts }` | Sweep begins or resumes |
| `'progress'` | `{ az, dwell_az: null }` then `{ az, dwell_az: az }` | Moving to az (null) then settled |
| `'contact'` | `{ az, from, snr, rssi, ts }` | Best-SNR contact recorded at current dwell position |
| `'end'` | `{ aborted: boolean }` | Sweep complete (az reached 360) or aborted |

## Invariants

- `start()` and `resume()` are idempotent: return immediately if `_active` is true.
- `abort()` is idempotent: does nothing if `_active` is false.
- `_dwellAz` is the only gate for contact acceptance. It is null during rotator movement and during the brief moment between dwell expiry and the next `_doStep()` call.
- `'progress'` fires twice per step: once with `dwell_az: null` (moving) and once with `dwell_az: az` (settled and accepting contacts).
- Contacts are best-SNR-wins per azimuth. A contact with lower SNR than the existing entry is silently dropped.
- `scan_state` in the DB is the authoritative resume checkpoint. It is written synchronously before every step so any restart can continue from the last position.
- **v1 defect (handlePacket)**: `ev.device !== rotatorId` uses the v1 `device` field. After bridge.js v2 alignment this must become `ev.__ble_addr`.
- **Code smell**: `index.js` accesses `scanner._preMode` directly (private field) to restore the prior mode on `'end'`. `_preMode` should be included in the `'end'` event payload or exposed via a getter.

## Test notes

- **full sweep**: step=90, dwell=0 → positions 0, 90, 180, 270 → `'end'` fires with `aborted: false`
- **contact best-snr**: two packets at az=90, SNR -5 then SNR -3 → `_contacts[90].snr === -3`
- **contact worse-snr dropped**: SNR -3 then SNR -5 → contact unchanged, `'contact'` fires only once
- **abort mid-sweep**: `start()` then immediate `abort()` → `'end'` fires with `aborted: true`; no more `'progress'` events
- **resume**: `resume({ az: 90, contacts: {0: {...}}, step: 5, dwell: 10, preMode: 0 })` → sweep continues from az=90; prior contacts preserved
- **dwell window**: `handlePacket` called when `_dwellAz == null` (moving) → ignored
- **rotator device filter**: `rotatorId` set, `ev.device` mismatch → packet ignored
- **rotator busy timeout**: `rotator.status.busy` stays true for 25 s → `_pollIdle` proceeds to dwell anyway
- **idempotent start**: `start()` called twice → second call returns; single sweep runs

## Out of scope

- Mode selection — `index.js` starts scanner on `dashMode.set(2)` and aborts on mode change
- Restoring prior mode on scan end — `index.js` calls `dashMode.set(scanner._preMode)` in `scanner.on('end')`
- Scan contact confirmation into node-list — `index.js` calls `nodeList.confirmScanContact` in `scanner.on('contact')`
- Broadcasting to browser — `ws-relay.js` listens to all 4 events and relays them
- Rotator hardware comms — `rotator.js` owns that

## V2 field alignment (2026-07-02, task `v2-backend-alignment`)

Rotator packet matching compares `ev.addr` (BLE MAC) — V2 removed the `device` field from packet events; the old comparison discarded every packet, so SCAN never recorded contacts.
