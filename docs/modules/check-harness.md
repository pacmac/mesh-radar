---
module: check-harness
source:
  - scripts/ws-ask.mjs
  - scripts/check_snapshot.mjs
  - scripts/check_contract.mjs
source_hash: 439f175270d902ec5b23e84401f5fe1c1cd7dc7b713df8805a163d2210c8c248
updated: 2026-08-17
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

## Dependencies

- `ws@8.21.0` (already a dependency) — **not** Node's global `WebSocket`.
  The reason is measured, not stylistic: the socket replays ~13.2 MB on connect,
  including a single `env_history` frame of 5,901,979 bytes and a `tilt_history`
  frame of 4,358,807 bytes (`B92`). A client on default limits is disconnected
  with `1009 message too big` before it ever sees its reply. `ws` lets
  `maxPayload` be stated explicitly; the global does not.

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
> `test_coulomb.mjs` and its two invariants were removed on 2026-08-17 with the
> alarm (task `remove-alarm-from-node-dash`). They said a test must perform no
> I/O and target the pure entry point rather than the transport, and that a
> deliberate refusal is behaviour that gets asserted rather than stubbed around.
> **Both rules still apply to every check here** — they are recorded because the
> reasoning outlives the module it was learnt on.
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
```

Both need the service up.

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
implemented twice drifts — the same argument the (now removed) coulomb spec made for
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

### `tests/test_coulomb.mjs` — REMOVED 2026-08-17

The file and the module it tested (`src/coulomb.js`) left with the alarm, task
`remove-alarm-from-node-dash`. The before/after diff that stood here described a
file that no longer exists; it is in git history if it is ever wanted.

What is worth carrying forward is why it was rewritten in the first place: the
test reached the model through two layers of transport by stubbing `global.fetch`,
which tied it to a fetch path that was later deleted. **Target the pure entry
point, not the transport** — that rule applies to every check in this file and
outlives the module it was learnt on.

## Files deliberately NOT changed

- `src/ws-relay.js`, `src/snapshot-api.js` — the `snapshot` RPC already serves
  every field needed; nothing server-side is missing.
- `tests/test_page_snapshot.py` — already converted; it is the reference this
  work copies (`board()` at line 47).
- `public/` — no browser file is involved. This is a Domain 1 change only.
