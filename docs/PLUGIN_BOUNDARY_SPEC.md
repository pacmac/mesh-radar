# The alarm is a plugin — core must run identically without it

Peter, 2026-07-29: *"node-dash exists with or without the alarm. alarm is addative, it changes
nothing about node communications, stats, messages. do NOT get that wrong. the alarm is a
plugin. it is ADDATIVE and node dash must be able to exist with or without it. alarm related
code is supposed to be self contained and not mixed in with core."*

mcpp task `alarm-plugin-boundary-restore`. Corrects `1f8842b`.

---

## 1. What was broken, and by whom

`1f8842b` (mine) put **164 lines of alarm logic and a hard `pac-host` import into
`src/node-status.js`** — a core module that builds `node_status` for *any* node in the mesh.

| location | content |
|---|---|
| `:23` | `import { unitForNum } from './pac-host.js'` |
| `:426-588` | `msToSec`, `WAKE_SOURCE_TEXT`, `AWAKE_SOURCE_TEXT`, `deliveryField`, `nextWindowField`, `wakeReliabilityField`, `buildReachabilitySection` |
| `:671` | the call site inside `buildNodeStatus` |

Also breaches `reference/alarm-integration/INVENTORY.md`: *"New integration work must use an
explicit module boundary; code must not be copied back into shared dashboard modules."*

**Nothing else depends on it** — verified by grep: only `pac-host.js`'s own comments mention
`reachability`. No other core module, no browser file. The extraction has no downstream callers.

## 2. The rule, stated so it is testable

> A core module must not import, name, or branch on the alarm. Removing the plugin must change
> **nothing** about node communications, stats or messages.

Testable form, and this is the acceptance:

1. `grep -c "pac-host" src/node-status.js` → **0**
2. `node_status` payload **structurally identical** before/after, for alarm units *and* core nodes
3. **pac-host stopped → every page renders**, and core nodes' payloads are unchanged

## 3. The extension point

Core gains a registry and nothing else. It does not know what a provider is for.

```js
// src/node-status.js
const _sectionProviders = [];

/** Register a provider that may contribute sections to node_status.
 *  Core knows nothing about what a provider is for — it calls each one with
 *  the node num and a context of already-computed CORE data, and splices in
 *  whatever comes back. A provider returning null contributes nothing, which
 *  is how "the plugin is absent" and "the plugin has nothing to say about this
 *  node" become the same, correct, code path. */
export function registerNodeSection(fn) { _sectionProviders.push(fn); }
```

Called at the head of `sections`, preserving today's order (alarm section first):

```js
const providerSections = _sectionProviders.map(fn => fn(num, { perRadio, now, since }));
const sections = compact([
  ...providerSections,
  buildSeriesSection('device_vitals', …),
  …
]);
```

**Context is passed in, never re-queried.** `perRadio` is core data
(`stmts.latestDirectPerRadio`), and the header's Signal tile is computed from the same array. If
a provider re-queried it, the header↔section agreement established in `cc2e55f` would become a
coincidence again. Passing it is what keeps that guarantee.

## 4. Files

| file | change |
|---|---|
| **NEW** `src/alarm-sections.js` | the 164 lines, moved **verbatim**, plus the `pac-host` import. Registers itself via `registerNodeSection`. |
| `src/node-status.js` | delete `:23` import and `:426-588`; add the registry; call providers |
| `src/index.js` | `import './alarm-sections.js'` beside `pacHost.start()` — the composition root is the one place allowed to know a plugin exists |

**Moved verbatim.** No renaming, no tidying, no "while I'm here". The payload must be identical,
and the only way to be sure of that is to change nothing about the logic.

## 5. Not changed, and why — read before assuming a gap

- **The header's Signal / Least hops / Verified hops** (`cc2e55f`) is **pure core** —
  `signal_history`, `messages`, `traceroute_history`. It has no alarm dependency and is not
  touched.
- **`Heard by …` rows stay inside the alarm section**, even though they are built from core data
  and would be valid for any node. Promoting them to a core section would ADD a section to every
  node's page — a behaviour change, in a task whose entire point is behaviour preservation. Own
  task if wanted.
- **`src/ws-relay.js` is left alone.** It has **seven** pac-host couplings, six of which pre-date
  this work (imports at `:3`, handlers at `:339/346/349`, replay sends at `:773/776/778`). My
  `:341` added one line inside an already-coupled block; it created no new crossing. The whole
  ws-relay↔pac-host coupling is a real and larger boundary problem — recorded in the `bugs` ledger,
  not fixed here, because fixing it means redesigning how plugin state reaches the browser.
- `src/pac-host.js`, `src/pac-align-api.js`, `src/pac-command-api.js` — the plugin's own files.
  Correct as they are.

## 6. Verification

1. **Static:** `grep "pac-host\|unitForNum" src/node-status.js` → no output.
2. **Payload diff:** structure-only capture (volatile values scrubbed) for GARG, BNCH and two
   core nodes, taken **before** any edit, diffed against the same capture after. Must be empty.
3. **Plugin-absent test — the actual property:** stop pac-host, confirm node-dash serves every
   page and core nodes' payloads are unchanged. *Requires Peter's go-ahead: pac-host is the live
   alarm gateway and stopping it interrupts the butler mid-cycle.* If withheld, the fallback is
   `PAC_HOST_URL` pointed at a dead port on a scratch instance — stated as a weaker test, not
   presented as equivalent.
4. `check_specs.py` — `All specs current.`, ok-count matching spec-count.
