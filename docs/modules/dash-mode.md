---
module: dash-mode
source: src/dash-mode.js
source_hash: cc852a451c7d776ef2c19867aa12cb93cb61d0f3f0f325c76ef6b3c5c3d92e45
updated: 2026-08-03
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

export function modeName(mode)              // number|string → 'pasv'|'actv'|'scan'|'disc'
export function transmitterForMode(mode, ctx = {})  // → node_id — the single radio that TXs in this mode
export function isListenerForMode(mode, mac)        // → bool — is this radio a listener (rx) in this mode?
export function isTransmitterForMode(mode, mac)     // → bool — is this radio a transmitter in this mode? (tx:'rx' follows the listener)

// Config-editor surface (consumed by config-api's GET/PUT /config/modes)
export const MODE_KEYS   // ['pasv','actv','scan','disc']
export const RX_ROLES    // valid listener roles: ['rotator','non-rotator','primary','all']
export const TX_ROLES    // valid transmitter roles: ['rotator','primary','non-rotator','all','rx']
export function isValidRole(role, kind)  // 'rx'|'tx' → bool — known keyword or a MAC
export function modeConfigAll()          // → { pasv:{rx,tx,passive}, actv:{…}, scan:{…}, disc:{…} } effective (defaults+override)
export function passiveTracingAllowed(mode)  // → bool — does the passive tracer act in this mode?
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
  - `isListenerForMode(mode, mac)` — true if the radio matches the `rx` role **or
    the `tx` role**: the route tracer automatically listens for its own traceroute
    replies (`tx:'rx'` is skipped here — it means "the hearing radio itself" — which
    also avoids recursion with `isTransmitterForMode`). Used by `passive-tracer`,
    `scanner`, `bridge-events` and the RX badge.
  - `isTransmitterForMode(mode, mac)` — the tracer predicate. `active-tracker`
    gates its **directional signal measurement** on this (the beam that points at
    and traceroutes a node measures that node), and the TX badge reads it;
    `tx:'rx'` resolves to the same set as the listener.
  - `transmitterForMode(mode, ctx)` — resolves the single dispatch node_id
    (through `macToNodeId`) for a traceroute; `'rx'` uses `ctx.rxDevice`.
- Defaults live in `MODE_DEFAULTS` and **reproduce the historic hardcoded
  behaviour exactly**. A browser-editable override is read from config key
  **`mode_config`** (per-mode `{ rx, tx }` only — `passive` is never overridable),
  merged over the defaults. **It is NOT unset on this host**: the stored value is
  `{"pasv":{"rx":"all","tx":"rx"},"actv":{"rx":"primary","tx":"rotator"},"scan":{"rx":"rotator","tx":"rotator"}}`
  (verified 2026-08-02), so the defaults table above does **not** describe live
  behaviour for `pasv` or `actv`. See ledger B60.

### Mode values

| Value | Name | Behaviour |
|---|---|---|
| `0` | PASV | Passive monitoring. `passiveTracer` auto-traces nodes heard via radio. |
| `1` | ACTV | Active tracking. `activeTracker` runs the ACTV scan cycle. |
| `2` | SCAN | BLE scan. `scanner` drives the antenna rotation sweep. |
| `3` | DISC | Discovery. `missionRunner` pursues chosen distant targets on the aimed YAGI; `passiveTracer` also runs. |

## State

No in-memory state. Mode is read directly from the config DB on every `value` access.

## Events emitted

| Event | Payload | When |
|---|---|---|
| `'change'` | `{ _mode: number }` | Every `set()` call, even if mode is unchanged |

## DISC — the fourth mode

Peter, 2026-08-02: *"well this is a new mode isnt it?"*

It is, and the radio roles are why:

| mode | rx | tx |
|---|---|---|
| `pasv` | non-rotator | `rx` (the radio that heard it) |
| `actv` | rotator | rotator |
| `scan` | rotator | rotator |
| **`disc`** | **all** | **rotator** |

A discovery mission chooses a distant target and pursues it, so it must
**transmit on the aimed YAGI** — the first implementation dispatched a 234 km
attempt on the omni at no particular azimuth, which is close to worthless. But it
must **listen on everything**: the reply can return by any path and arrive at
either radio, and hearing it on the omni is still hearing it.

That `rx:'all'` + `tx:'rotator'` combination is what makes it a mode rather than a
flag on ACTV, whose `rx` is the rotator alone.

Mode number **3**. `MODE_NAME`, `MODE_DEFAULTS` and `MODE_KEYS` are the SSOT —
per Peter's standing rule that dash mode owns every per-mode behaviour, including
which radio transmits, the mission runner **reads** the mode and never picks a
radio itself.

## `passive` — which modes run the passive tracer

Task: `passive-tracer-starved`.

`MODE_DEFAULTS` carries a third per-mode field beside `rx` and `tx`:

| mode | `passive` | why |
|---|---|---|
| `pasv` | **true** | it is the mode's entire purpose |
| `actv` | false | the YAGI is held on one tracked node; a passive trace would compete for it |
| `scan` | false | the YAGI is sweeping; nothing may interrupt the sweep |
| `disc` | **true** | see below |

Read through `passiveTracingAllowed(mode)`. Before this task the rule lived in
`passive-tracer.js` as `if (dashMode.value !== 0) return;` — a bare magic number
in the consumer, which is exactly the arrangement Peter's mode-SSOT rule exists
to forbid. It also silently made DISC mutually exclusive with passive tracing,
and nothing said so.

### Why DISC runs both

Measured 2026-08-02: passive ran at **17.0 traces/hour and answered 3.8%** across
5,557 traces before DISC was selected at 10:53. In the 9.5 hours after, passive
managed **1 trace** while DISC managed **132 attempts and 0 answers**. Two of the
day's three hits overall were passive. Turning DISC on silently switched off the
only prober that was producing results.

They are not rivals for the **aim**, because **passive keeps PASV's radio roles in
every mode** and never moves the rotator. It replies through the radio that heard
the packet (`tx: 'rx'`).

**They can, however, share the YAGI's airtime — because of live config, not the
defaults.** The `pasv` default `rx` is `'non-rotator'`, which would confine
passive to the OMNI, but the stored `mode_config` override on this host sets
`pasv.rx = 'all'` (verified 2026-08-02). With `rx: 'all'` + `tx: 'rx'`, a packet
heard *by the YAGI* produces a passive trace *transmitted on the YAGI*, at
whatever bearing the mission is holding.

That does not steal the aim and does not cancel the mission, but it does spend
mission airtime on an unrelated target. Enabling passive in DISC is what activates
the path, so it is recorded here rather than left to be discovered later —
ledger **B60**. The narrower `dispatching` yield limits it to the gaps between
mission packets rather than the moment one is in the air, which bounds the damage
without removing it. Setting `pasv.rx` back to `'non-rotator'` would remove it
entirely; that is a config decision, not a code one, and is deliberately not taken
here.

This is why the fix is a `passive` flag and **not** resolving passive's roles
from the live mode. Doing that in DISC would give passive `tx: 'rotator'`, firing
an untargeted trace at whatever bearing the YAGI happens to be holding — wrong
for the trace and destructive to the mission.

The one genuine conflict is airtime, and that is already handled: passive yields
on `missionRunner.dispatching`, so it never transmits while a mission packet is
in the air.

### Scope of the flag

`passive` gates **whether the passive tracer acts**, nothing else. It does not
gate reception, storage, or any other prober. `actv`/`scan` keep their existing
behaviour byte for byte — the flag reproduces the old `!== 0` test for all three
pre-existing modes and changes only DISC.

It is **not a browser-editable knob**. `PUT /config/modes` copies only `rx` and
`tx` from the request and ignores every other key (`config-api.js:249`), so the
stored `mode_config` override can never carry a `passive` field and the default
always wins. `GET /config/modes` does return it, via `modeConfigAll()` — read-only
by construction rather than by validation, which is why no validator was added.
If it ever should become editable that is a deliberate change to the PUT handler,
not an oversight to be quietly corrected.

## Invariants

- `dashMode.value` always reflects the DB value. There is no in-memory cache — a change written by any path is immediately visible to the next `value` read.
- `'change'` fires on every `set()` call. Callers must not assume it fires only on actual transitions — idempotent handlers required.
- Config key is `'rotator.dash_mode'` with default `0` (PASV). This key is owned by this module; no other module writes it.
- Mode is stored as an integer in the config table (JSON-serialised by `setConfig`).
- **No consumer tests a mode number to decide its own behaviour.** Every per-mode
  question is answered by a function here — `isListenerForMode`,
  `transmitterForMode`, `passiveTracingAllowed`. A bare `dashMode.value !== 0` in
  a consumer is the defect this rule names; it starved the passive tracer for
  9.5 hours on 2026-08-02 without a single log line.
- `passive` gates only whether the passive tracer acts. It never changes which
  radio the passive tracer uses — those stay PASV's roles in every mode.

## Test notes

- `dashMode.value` returns `0` when config key absent (default)
- `dashMode.set(1)` → `dashMode.value === 1`; `'change'` fires with `{ _mode: 1 }`
- `dashMode.set(0)` after `set(1)` → `'change'` fires again (even though reverting)
- Listener added via `.on('change', fn)` receives every transition

## Out of scope

- Mode transition side-effects — callers own those (index.js starts/stops activeTracker, scanner, passiveTracer on `'change'`)
- Validating mode values — callers are responsible for passing valid integers
- Broadcasting mode to browser — ws-relay.js listens to `'change'` and sends `rotator` WebSocket messages

## The mode vocabulary is SERVED (task `serve-mode-vocabulary`, 2026-08-04)

Peter, 2026-08-04: *"do NOT break the UI golden rule."*

### What was wrong

`public/app.js:251-262` held its own hardcoded copy of the role vocabulary:

```js
rxRoleOptions: [ 'rotator', 'non-rotator', 'primary', 'all' ]        + labels
txRoleOptions: [ 'rotator', 'primary', 'non-rotator', 'all', 'rx' ]  + labels
```

This module already owns those as `RX_ROLES` / `TX_ROLES` and validates against
them in `isValidRole()`. Nothing exposed them over an endpoint, so the browser
copy was a **retyped duplicate**, free to drift: add a role here and the Modes
page silently cannot offer it; remove one and the page offers a value the PUT
rejects. Same defect class as the `76/51/26` vs `75/50/25` signal bands.

Discovered while trying to add `aim` and `radio` selects to the Modes page —
copying the pattern would have created two MORE duplicated vocabularies.

### What is served

`GET /config/mode-vocabulary` returns the lists **with their labels**, because a
label is a naming decision and the browser does not get to name things either:

```jsonc
{
  "rx":    [ { "value": "rotator", "label": "Rotator" }, … ],
  "tx":    [ … ],
  "aim":   [ { "value": "door",     "label": "The door it routes through" },
             { "value": "endpoint", "label": "The node itself" },
             { "value": "none",     "label": "Do not aim" } ],
  "radio": [ { "value": "auto",  "label": "Whatever the mode's TX resolves to" },
             { "value": "omni",  "label": "Omni" },
             { "value": "yagi",  "label": "Yagi (rotator)" } ],
  "modes": [ "pasv", "actv", "scan", "disc" ]
}
```

Derived from `RX_ROLES` / `TX_ROLES` / `AIM_MODES` / `RADIO_MODES` — the same
constants `isValidRole` / `isValidAim` / `isValidRadio` test against, so the list
offered and the list accepted cannot disagree.

A separate endpoint rather than folding it into `GET /config/modes`: that
response is bound directly as `modesCfg.pasv.rx` and is PUT back wholesale, so an
extra key would be round-tripped as though it were config.

### PUT now accepts aim and radio

`PUT /config/modes` copied only `rx` and `tx`, so `aim` and `radio` could not be
edited at all — the fields existed in `MODE_DEFAULTS` with no way to change them.
Both are now accepted and validated.

`passive` remains deliberately non-editable, as before: it gates whether the
passive tracer acts, and the comment above `MODE_DEFAULTS` explains why that is
not a user knob.

## Out of scope

- Deleting `app.js:251-262` and rendering the served lists — Domain 2.
- The header TRACE switch and the radar animation — Domain 2.
