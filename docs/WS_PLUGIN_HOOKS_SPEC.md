# Plugin state reaches the browser through a hook, not by name

Peter, 2026-07-29, on being told six of the seven couplings pre-dated today's work:
*"makes no difference if they were added today or not they break the rules and need fixing"*

mcpp task `ws-relay-plugin-boundary`. Completes what `b16304b` started: that removed the
alarm from `node-status.js`; this removes it from `ws-relay.js`, the last core module that
names it.

---

## 1. The breach

`src/ws-relay.js` is core — it serves the WebSocket for every page. It names `pac-host`
seven times:

| line | coupling |
|---|---|
| `:3` | `import * as pacHost from './pac-host.js'` |
| `:339-343` | `pacHost.events.on('change', …)` → `broadcast(connectMessage())` + `_hintNodeStatus` per unit |
| `:346` | `pacHost.events.on('queuesChanged', …)` → `broadcast(queuesMessage())` |
| `:349` | `pacHost.events.on('alignChanged', …)` → `broadcast(alignMessage())` |
| `:773` `:776` `:778` | three `ws.send()` replays on every new connection |

**Consequence today:** deleting the alarm requires editing core. `b16304b` made the
plugin-absent property true for `node_status`; it is *not* true for the WS path, so the
property does not hold overall.

## 2. What the plugin actually needs from core

Only three things, and all three are generic:

| need | why it is a legitimate host service |
|---|---|
| `broadcast(msg)` | send to every connected client — no plugin knowledge |
| a replay contribution | messages sent to each NEW connection |
| `hintNodeStatus(num)` | carries only a `num`; core already does this for mesh events |

Core never learns what a plugin is for. It calls a wiring function and splices a message
list.

## 3. The hooks

```js
// src/ws-relay.js — module scope
const _wsWirings = [];
const _connectReplays = [];

/** Wire a plugin's own event sources to the WS. Called ONCE from
 *  attachWsRelay with the host services, because `broadcast` is a closure
 *  that does not exist at import time. */
export function registerWsWiring(fn) { _wsWirings.push(fn); }

/** Contribute messages replayed to every NEW connection. Returns an array;
 *  an empty array contributes nothing, which is how "no plugin" and "plugin
 *  has nothing to say yet" become the same code path. */
export function registerConnectReplay(fn) { _connectReplays.push(fn); }
```

Inside `attachWsRelay`, replacing `:339-349`:

```js
for (const wire of _wsWirings) {
  wire({ broadcast, hintNodeStatus: (num) => _hintNodeStatus(num, broadcast) });
}
```

Inside the connection handler, replacing `:773-778` **at exactly that position**:

```js
for (const fn of _connectReplays) {
  for (const msg of fn()) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
}
```

## 4. Two things that must not change, and why

**ORDER.** On connect the sequence is bridge-state → `pac_host_status` →
`pac_host_queues` → `pac_host_align` → `settings`. Plugin replays sit **between** bridge
state and settings. Appending them after `settings` instead would change the Control
page's first paint. The loop goes exactly where the three `ws.send` calls were.

Whether any browser code actually depends on that ordering is **not audited**. The order
is preserved rather than tested — preserving it costs nothing and testing it costs a
regression hunt.

**ENRICHMENT ASYMMETRY.** `broadcast()` applies `enrichEvent`; the connect-replay path
does **not** — it calls `ws.send(JSON.stringify(msg))` directly. Routing replays through
`sendEnriched` would silently change the payload. The replay loop must stay unenriched.

## 5. Files

| file | change |
|---|---|
| `src/ws-relay.js` | delete the `pacHost` import, `:339-349`, `:773-778`; add the two registries, the wiring loop, the replay loop |
| **NEW** `src/alarm-ws.js` | the pac-host wiring, moved verbatim: three event handlers and the three replay messages |
| `src/index.js` | `import('./alarm-ws.js')` beside the existing `import('./alarm-sections.js')` |

`src/alarm-sections.js` is untouched — a different hook, already correct.

## 6. Not changed

- Every other `bridge.on(...)`, rotator, scanner and tilt handler in `ws-relay.js`. Those
  are **core**, not plugins.
- `_hintNodeStatus` itself stays module-private; only a bound wrapper is handed out.
- The `pac_host_*` message shapes. This moves *where they are wired*, not what they say.

## 7. Verification

1. **Static:** `grep -c "pac-host\|pacHost" src/ws-relay.js` → **0**.
2. **Message-set identity:** connect a raw WS client before and after, capture every
   message type received in the first seconds **and their order**, diff. Must be identical.
3. **Plugin absent:** comment out both `import()` lines in `index.js`. Expect **zero**
   `pac_host_*` messages and an otherwise identical core message set — same test that
   proved `b16304b`, extended to the WS path.
4. **Broadcast still fires:** confirm a `pac_host_queues` message arrives on its 5 s poll
   after the change, i.e. the wiring is *reached* and not merely present.
5. `check_specs.py` — `All specs current.`, ok-count matching spec-count.
