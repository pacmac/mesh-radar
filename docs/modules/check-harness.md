---
module: check-harness
source:
  - scripts/ws-ask.mjs
  - scripts/check_snapshot.mjs
  - scripts/check_contract.mjs
  - tests/test_coulomb.mjs
source_hash: b7e1339608cf9004e37855953be77acda019912c0d84fd49305019678bd42dca
updated: 2026-08-13
---

# Module: check-harness

## Purpose

The three checks that verify what the server SERVES against what the store HOLDS,
plus the one helper they share.

They are specified together because they failed together, for one reason, on
2026-08-13: **a check must reach the server the same way the page does.** All
three were written against HTTP GETs that `2103e03` deleted, and all three had
been silently red for hours because nothing in this repo invokes them (recorded
as `B96` in the bug ledger).

This spec did not exist before today. `scripts/check_specs.py` validates only the
specs that are present, so three unspecified check files passed it by being
absent — the same gap that hid the missing spec-index.

## Responsibilities

- `scripts/ws-ask.mjs` — ask the node-dash socket one question and return the
  matching reply. The only place the connect-replay rule is implemented.
- `scripts/check_snapshot.mjs` — every number on the Snapshot board, across six
  windows, against SQL over `data/node-dash.db`. 54 comparisons.
- `scripts/check_contract.mjs` — repo-wide contract assertions. Only its **reach
  invariant** block is in scope here; its config-key and persistence blocks are
  untouched.
- `tests/test_coulomb.mjs` — the coulomb display model, pure, no network and no
  database.

## Dependencies

- `ws@8.21.0` (already a dependency) — **not** Node's global `WebSocket`.
  The reason is measured, not stylistic: the socket replays ~13.2 MB on connect,
  including a single `env_history` frame of 5,901,979 bytes and a `tilt_history`
  frame of 4,358,807 bytes (`B92`). A client on default limits is disconnected
  with `1009 message too big` before it ever sees its reply. `ws` lets
  `maxPayload` be stated explicitly; the global does not.
- `src/coulomb.js` — `coulombModel`, the pure entry point.

## Public interface

`scripts/ws-ask.mjs`

```
askWs(request, match, { url, timeoutMs, maxPayload }) -> Promise<object>
```

- `request` — the object sent once, on open.
- `match(msg)` — returns true for OUR reply. Anything else is skipped.
- Rejects on timeout, socket error, or close-before-match. Never resolves on the
  replay unless `match` says so.

```
askWsMany(requests, match, opts) -> Promise<object[]>
```

- One connection, N questions, replies matched back to their requests. Exists so
  `check_snapshot` pays the 13.2 MB connect replay **once** instead of six times.

## State

_N/A — every function opens its own socket and closes it._

## Events emitted

_N/A_

## Invariants

- **A check reads the transport the page reads.** A check that GETs what the
  browser receives over WS proves nothing about the page, and rots the moment the
  route goes. This is the invariant all three violated.
- **The first `snapshot` message is not the answer.** The server replays the
  board on connect at its own default window, then answers the window asked for.
  Matching the first reply compares the screen against the wrong window — it has
  already bitten the browser and `tests/test_page_snapshot.py`.
- **`test_coulomb.mjs` performs no I/O.** It targets `coulombModel`, not
  `buildCoulomb`. Stubbing `global.fetch` to reach a model through two layers of
  transport was what tied the test to a fetch path that no longer exists.
- **A refusal is behaviour and gets a test.** `getObs` throwing 501 is a
  deliberate contract (`src/alarm-host.js:651-660`), not an outage, so it is
  asserted rather than stubbed around.
- **An allowlist is keyed by CODE, never by a line number** (2026-08-14). The
  "no threshold decides a class" check exempted its one legitimate case with
  `!/app-perf\.js:39[0-9]/`. An eight-line comment was added above that function,
  the line became 405, and the check went red for a file whose logic had not
  changed. A line number is not an identity — it moves whenever anything above it
  moves, so the check fires on edits that are not the thing it guards, and the
  cheap way to silence it is to widen the range and wait for it to happen again.
  It now matches on `trend_dead_band_db`, the SERVED field being read, so it
  follows the function wherever it goes and correctly starts failing if someone
  swaps the served value for a literal. Verified both ways: clean on the real
  tree, and still catching a planted `v > 5 ? 'text-error'` offender.

## Test notes

Run from the repo root, with node-dash running:

```
node scripts/check_snapshot.mjs       # 54 checks across 6 windows, 0 mismatches
node scripts/check_contract.mjs       # 0 contract failure(s)
node tests/test_coulomb.mjs           # 9 checks, coulomb model clean
```

`check_snapshot` and `check_contract` need the service up; `test_coulomb` does
not and must never need it.

## Out of scope

- Making anything invoke these automatically (`B96`). Named, not fixed here.
- The 13.2 MB connect replay itself (`B92`). This spec works around its symptom
  by raising `maxPayload`, and says so; the payload is a separate defect.
- `check_contract`'s config-key and persistence-baseline blocks.
- The two layout failures in `tests/test_page_snapshot.py`.

---

## Implementation — every file, every line, before and after

### NEW `scripts/ws-ask.mjs`

Did not exist. ~45 lines. Two exports, `askWs` and `askWsMany`, per the interface
above. Written once because both checks need the same replay rule, and a rule
implemented twice drifts — the same argument `docs/modules/coulomb.md` makes for
the `coulombModel` split.

### `scripts/check_snapshot.mjs`

**Line 8, before**

```js
const get = async (p) => (await fetch(`http://localhost:8000${p}`)).json();
```

**after** — deleted; replaced by an import of `askWsMany` at the top of the file.

**Lines 20–25, before**

```js
for (const d of [1,2,7,14,30,0]) {
  const w = d === 0 ? 'all' : `${d}d`;
  const f = await get(`/snapshot/frontier?days=${d}`);
  const g = await get(`/snapshot/new-ground?days=${d}`);
  const p = await get(`/snapshot/productivity?days=${d}`);
  const b = await get(`/snapshot/distribution?days=${d}`);
```

**after** — one socket, six boards, then the same six-window loop:

```js
const WINDOWS = [1,2,7,14,30,0];
const boards = await askWsMany(
  WINDOWS.map(d => ({ type: 'snapshot', days: d })),
  (msg, req) => msg.type === 'snapshot' && Number(msg.days) === Number(req.days));

for (const [i, d] of WINDOWS.entries()) {
  const w = d === 0 ? 'all' : `${d}d`;
  const s = boards[i];
  if (s.error) { console.log(`  BOARD ERROR ${w.padEnd(4)} ${s.error}`); bad++; continue; }
  const f = s.frontier, g = s.new_ground, p = s.productivity, b = s.distribution;
```

Lines 27–43 — the 9 `cmp(...)` calls and every SQL string — **unchanged**. The
field names are already correct; they were one level shallower only because each
route served its own band. Verified live against `days=7`:
`frontier.furthest_km 444.2`, `frontier.heard 323`, `new_ground.first_heard 38`,
`new_ground.new_doors 1`, `new_ground.first_contacts 24`,
`productivity.attempts 7374`, `productivity.answered 1344`,
`distribution.doors_total 10`, `distribution.bands` 5 entries.

The `s.error` guard is new and load-bearing: `board()` returns
`{error, frontier:null, …}` on failure (`src/ws-relay.js:1207-1213`), and
`b.bands.reduce` on a null would throw a TypeError that reads like a broken check
rather than a broken board.

### `scripts/check_contract.mjs`

Only the reach-invariant block changes. **Lines 183–185, before**

```js
  const served = await fetch('http://localhost:8000/snapshot/frontier?days=0')
                        .then(r => r.json()).catch(() => null);
  const got = Number(served?.furthest_km);
```

**after**

```js
  const served = await askWs({ type: 'snapshot', days: 0 },
                             m => m.type === 'snapshot' && Number(m.days) === 0)
                       .catch(() => null);
  const got = Number(served?.frontier?.furthest_km);
```

Plus the import. Lines 186–194 — the `Number.isFinite` guard, the
`got + 0.15 < floor` comparison and all three outcome messages — **unchanged**.
The failure message stays accurate: if the socket answers without a
`furthest_km`, that is still the thing to report.

### `tests/test_coulomb.mjs`

**Lines 13–22, before**

```js
// buildCoulomb calls getObs, so the module is loaded with pac-host stubbed.
// Node's ESM loader has no cheap injection point, so the fetch layer is
// intercepted instead: coulomb.js -> pac-host.getObs -> global fetch.
let FIXTURE = [];
global.fetch = async () => ({
  ok: true,
  json: async () => FIXTURE,
});

const { buildCoulomb } = await import('../src/coulomb.js');
```

**after**

```js
import { buildCoulomb, coulombModel } from '../src/coulomb.js';

// The model is reached DIRECTLY, through the pure entry point that exists for
// exactly this reason (docs/modules/coulomb.md — "THIS SPLIT IS LOAD-BEARING").
//
// These tests used to stub global.fetch and call buildCoulomb, reaching the
// model through getObs. On 2026-08-13 getObs became an unconditional 501 — the
// history has no source and must not be faked (src/alarm-host.js:651-660) — and
// all 8 tests failed on a refusal that is CORRECT. A test of the arithmetic had
// been coupled to a transport it never meant to exercise.
let FIXTURE = [];
```

The import sits at the top rather than below `FIXTURE`, where the first draft of
this spec put it: ESM hoists imports either way, so the lower position would have
read as though the stub had to be installed first — which is precisely the
misreading this change removes.

**Six call sites** — lines 40, 49, 62, 73, 87, 98, 108, before

```js
  const m = await buildCoulomb('!test');
```

**after**

```js
  const m = coulombModel('!test', FIXTURE);
```

**Line 81, the ordering guard, before**

```js
  await assert.rejects(() => buildCoulomb('!test'), /out of order/i);
```

**after** — `coulombModel` is SYNCHRONOUS, so `assert.rejects` would pass on any
throw-free call and prove nothing:

```js
  assert.throws(() => coulombModel('!test', FIXTURE), /out of order/i);
```

**NEW test, appended after the `cons` test** — covers the refusal instead of
merely stepping around it:

```js
await t('buildCoulomb refuses rather than inventing a series', async () => {
  // getObs throws 501 by design: `record` is unbuilt, and accumulating the
  // event stream here would draw a chart that starts at the last restart and
  // looks like a measurement. If this ever resolves, the refusal was removed
  // and the fetching path needs its own tests.
  await assert.rejects(() => buildCoulomb('!test'),
                       /no history store|record.*unbuilt/i);
});
```

The eight existing assertions are otherwise unchanged, including the two-line
negative control at lines 69–76 that stops the refusal test passing for the
wrong reason.

## Files deliberately NOT changed

- `src/coulomb.js` — the model is correct; only the test's entry point was wrong.
- `src/alarm-host.js` — the 501 at `getObs` is the intended contract and is now
  asserted rather than removed.
- `src/ws-relay.js`, `src/snapshot-api.js` — the `snapshot` RPC already serves
  every field needed; nothing server-side is missing.
- `tests/test_page_snapshot.py` — already converted; it is the reference this
  work copies (`board()` at line 47).
- `public/` — no browser file is involved. This is a Domain 1 change only.
