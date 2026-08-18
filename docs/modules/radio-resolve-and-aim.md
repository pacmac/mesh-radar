---
module: radio-resolve-and-aim
source:
  - src/resolve.js
  - src/aim.js
  - src/rotator.js
  - src/config-api.js
  - src/traceroute.js
source_hash: 34da160626f4e4be3bedece2c47321ffa545ff6cec6bdd9215a3bea89f2354b1
updated: 2026-08-17
---

# Spec: resolve, aim, traceroute — three functions, one direction of call

## Purpose

Peter, 2026-08-17:

> "so using SSOT, aim, resolve and traceroute are 3 functions that may be called
> independently as well as in the case of traceroute dependently. traceroute
> should call and not duplicate what the other functions provide."

Phase 1 found it duplicates all three ways. This spec moves each concern to one
owner and leaves traceroute calling them.

## What Phase 1 established (evidence, not assumption)

| finding | where |
|---|---|
| traceroute has its own radio resolver, and its `'omni'` branch returns `tx` from **both** ternary arms — asking for the omni can return the YAGI | `traceroute.js:213-224` |
| directionality answered two ways: `beam_deg` for provenance, `getRotatorAddress()` for the behavioural gate | `:60`, `:330` |
| traceroute IS the aim module — target policy, bearings, config reads, `rotator.point()`, retry loop, events | `:280-490` |
| the SHARED-rotator hold ceiling is enforced in the caller, so every other `rotator.point()` caller is unclamped | `:425-431` vs `rotator.js:297` (`hold = 0`, no bound) |
| Peter already ruled on that last one, and the ruling is quoted in the file | `:385-388` |

`src/traceroute.js` is currently **unwired** — nothing calls `run()`. That is why
this is the safe moment: the restructure cannot break a live path.

## Decisions taken under /afk (Peter asleep)

**1. The resolver is a NEW module `src/resolve.js`, not an extension of `channels.js`.**
Peter called channels.js "the resolver" and asked whether it should also answer
directionality. It should — but `channels.js` is the channel-index store keyed by
name+PSK, and radio capability is a different fact with a different source
(`device-config`). `resolve.js` becomes the single entry point and *delegates*
the channel half to `channels.js`, so there is still exactly one owner per fact.
*Undo:* delete `src/resolve.js` and revert traceroute's import.

**2. `resolve()` returns the rotator's IDENTITY, not its host/port.**
Peter's sketch said the aim function "needs the rotator host/port". It does not:
`rotator.js:18-19` already owns the connection (`ROTATOR_WS_URL` /
`ROTATOR_V5_WS_URL`, v4/v5 targets, env-only, never in source). Duplicating the
URL into the resolver would create a second place to be wrong about where the
rotator lives. `resolve()` says *which* rotator serves a radio; `rotator.js`
keeps knowing how to reach it.
*Undo:* add a `url` field to the returned bundle.

**3. `beam_deg` is the truth for directionality; `is_rotator` means steerability.**
They are separate questions and the config already holds both. `directional =
beam_deg < 360` (Peter's own test). `steerable = is_rotator && a rotator target
exists`. A fixed directional antenna is then representable: directional true,
steerable false — which the current code cannot express.
*Undo:* derive `directional` from `is_rotator` instead.

**4. The hold ceiling moves INTO `rotator.js`, and `config-api` reads it from there.**
Peter, quoted at `traceroute.js:385-388`: "traceroute calls the pointer code, it
is the one that needs fixing." `rotator.js` cannot import `DISCOVERY_LIMITS` —
`config-api → ws-relay → rotator` is a cycle. So the constant's home is
`rotator.js` (it is rotator policy: how long may ANY user hold this shared
instrument), and `config-api.js` imports it for form validation. That direction
is acyclic: `config-api → rotator → db, hooks`.
*Undo:* move the constant back to `config-api.js` and re-import it in aim.

**5. `aim.js` splits deciding from moving.**
`decideAim()` is pure policy over stored evidence — testable with no hardware.
`aimAt()` is the only thing that touches the rotator. Peter, 2026-08-06: the mode
SSOT "does NOT own the pointer — modes use it, they must not control or gate it".
Same rule: resolve reports, aim acts, and aim is the ONLY caller of
`rotator.point()` in this path.
*Undo:* re-inline both into traceroute.

## `src/resolve.js` — new

```js
export function resolveRadio(spec, ctx = {})
```

`spec` accepts, in order of precedence:

| spec | means |
|---|---|
| a MAC (`AA:BB:…`) or `!hex` | that radio, explicitly |
| `'rotator'` | the radio on the rotator (`getRotatorAddress()`) |
| `'primary'` | `getPrimaryMac()` |
| `'non-rotator'` | the configured radio that is NOT the rotator — **resolved from device config**, which is what `traceroute._resolveRadio` said it could not do while holding the import |
| `'auto'` / null | `transmitterForMode(modeName(dashMode.value), ctx)` |

Returns `null` when nothing resolves, else:

```js
{ mac, node_id, label,
  beam_deg,            // number or null when unknown — never a guessed default
  directional,         // beam_deg != null && beam_deg < 360
  steerable,           // is_rotator && rotatorId != null
  rotatorId,           // which rotator serves it, or null. NOT a URL — see decision 2
  channels: { pub, pri } }   // delegated to channels.indexFor(); null-safe, never 0-by-accident
```

`'omni'` and `'yagi'` from traceroute's private vocabulary are **not** carried
over. They were a third naming scheme for radios (Phase 1 finding
`three-vocabularies-for-which-radio`); `'non-rotator'` and `'rotator'` already
exist in `dash-mode.js`'s `TX_ROLES` and mean the same things precisely.

## `src/aim.js` — new

```js
export function bearingToNode(num)        // moved verbatim from traceroute.js:71
export function decideAim(to, radio)      // the four-rule policy, moved from _decideAim
export async function aimAt(radio, az, opts = {})   // the only rotator.point() caller
export async function resolveAim(to, want, radio, opts = {})  // decide + act, returns provenance
```

`decideAim` keeps all four rules and their recorded evidence verbatim — the
87.1%-wrong endpoint measurement (n=2,726), the bypass rule with its 155 cases,
and rule 3b with the 303-attempts-across-246-azimuths measurement. Those comments
are the reason the module is worth moving rather than rewriting.

`aimAt` takes a **resolved radio bundle**, not a device string, so the
"is this radio on the rotator" gate is a field read (`radio.steerable`) rather
than a MAC comparison performed locally. That deletes `_txIsRotator` and
`toMac`.

## `src/rotator.js`

Gains `HOLD_CEILING_MS` and clamps `hold` inside `point()`, warning when it
clamps. The ceiling binds every caller, not just this one.

## `src/config-api.js`

`DISCOVERY_LIMITS.hold_sec` upper bound is imported from `rotator.js` instead of
being the literal `120`, so the form and the pointer cannot drift apart.

## `src/traceroute.js`

Deleted: `toMac` (:51), `beamwidthFor` (:60), `bearingToNode` (:71),
`_resolveRadio` (:213), `_decideAim` (:280), `_txIsRotator` (:330),
`_resolveAim` (:341), and the hold-ceiling clamp (:425-431).

`run()` becomes:

```js
const radio = resolveRadio(opts.radio, { rxDevice: opts.rxDevice });
if (!radio) throw new Error('no radio for this mode');
const aim = opts.aimCtx
  ? { ...opts.aimCtx, beam_deg: radio.beam_deg }
  : await resolveAim(to, opts.aim ?? modeAim(modeName(dashMode.value)), radio, opts);
return this.dispatch({ to, device: radio.node_id, ..., aimCtx: aim });
```

Kept: `dispatch`, `_pending`, cooldown, timeout, `handlePacket`, `_recordFailure`,
the `send_failed`/`timeout` taxonomy, and row provenance. Those are traceroute's
own job and none of them duplicates another module.

## Invariants

- `resolve.js` never moves hardware. `aim.js` is the only `rotator.point()`
  caller in this path. `traceroute.js` calls both and re-implements neither.
- Each of the three is callable alone.
- `beam_deg` null means unknown and must never become a guessed default — a 3- and
  a 7-element yagi must stay separable in the data.
- The hold ceiling binds every caller of `rotator.point()`.

## Test notes

`tests/test_resolve.mjs` and `tests/test_aim.mjs`, registered in
`scripts/check_all.mjs`:

1. `resolveRadio('rotator')` → YAGI: directional true, steerable true, beam 35.
2. `resolveRadio('non-rotator')` → OMNI: directional false, beam 360. **This is
   the regression test for the `'omni'` defect** — the old branch could return
   the rotator here.
3. `resolveRadio('!nonexistent')` → null, not a partial bundle.
4. `channels` never returns `0` for an unresolved role (the `Number(null) === 0`
   trap that would put traffic on PRIMARY).
5. `decideAim` with no stored route → `endpoint`; with a far door → `door`; with
   a close door and a proven hop-2 better aligned → `bypass`.
6. `rotator.point({ hold: 999_999 })` clamps to the ceiling.

**Not testable tonight, and stated rather than skipped:** no traceroute can be
dispatched to verify end to end. Nothing calls `run()` by design, and dispatching
would put a frame on air on a channel we do not choose (mesh-gw's
`send_traceroute(to)` takes no channel — `docs/gw/modules/ble_device.md:66`), so
it could be PRIMARY. `aimAt()` likewise moves a rotator shared with the garage
alarm. Both are deferred to a waking session.

## Out of scope

- Wiring traceroute back up to any caller. Peter: the replacement is decided
  after the tree is clean.
- Which channel the firmware picks for a traceroute — an mt-transport/mesh-gw
  question, to be asked of the device.
