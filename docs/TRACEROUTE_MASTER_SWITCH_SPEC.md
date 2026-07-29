# Traceroute master switch — automatic dispatch is opt-in and persists

Peter, 2026-07-27: *"Traceroute is continuous no matter whether in PASV or ACTV mode.
This is wrong. Traceroute needs to be enabled / disabled manually and persist its state.
The button needs to be in the header."*

Two halves, two domains, two commits.

| | domain | state |
|---|---|---|
| backend gate + persisted config key | 1 (`src/`) | **shipped** `d691303` |
| header button | 2 (`public/`) | task `traceroute-header-button` |

Names `docs/BROWSER_CONTRACT.md`, `docs/STYLE_GUIDE.md`, `docs/modules/traceroute.md`,
`docs/modules/passive-tracer.md`, `docs/modules/config-api.md`.

---

## 1. The problem

Automatic traceroute dispatch ran in every dash mode with no way to stop it. Traceroute puts
frames on air; a dispatcher with no off switch is a radio you cannot silence. The only lever
was the dash mode itself, which controls unrelated behaviour, so switching traceroute off
meant switching several other things off with it.

## 2. Backend — shipped `d691303`, recorded here for completeness

Config key **`traceroute.enabled`**, default `true` (`src/config-api.js` `DEFAULTS`),
persisted like every other config value and replayed to the browser on the `settings` WS
event.

`src/traceroute.js`:

```js
export function tracerouteEnabled() {
  return getConfig('traceroute.enabled', true) !== false;
}
```

The gate sits in `dispatch({ ..., manual = false })` **before** the cooldown guard:

```js
if (!manual && !tracerouteEnabled()) {
  return Promise.reject(new Error('traceroute disabled'));
}
```

`manual: true` is passed only by `src/traceroute-api.js`. **A user asking for a traceroute
explicitly is never gated** — the switch governs *automatic* dispatch, not the operator.

`src/passive-tracer.js:98` checks the same gate a second time, and this is **not redundant**.
Its `.catch` calls `_failed.set()` and emits an empty `traced` result, so a rejection arriving
from `dispatch` would mark every skipped node FAILED and push bogus empty routes to the
browser. The early return avoids entering that path at all.

## 3. Browser — this task

**`public/index.html`**, after the rotator group and **deliberately outside its `x-show`.**
Traceroute has nothing to do with the rotator, and hiding the control when the rotator is
disconnected would remove it at exactly the moment you still want to stop traceroutes.

```html
<div class="hidden sm:flex items-center pl-1">
  <button class="btn btn-xs font-mono tracking-widest px-2"
          :class="tracerouteEnabled ? 'btn-outline btn-success' : 'btn-ghost opacity-40'"
          :title="tracerouteEnabled ? 'Automatic traceroute ON — click to disable'
                                    : 'Automatic traceroute OFF — click to enable'"
          @click="toggleTraceroute()">TRACE</button>
</div>
```

**`public/app.js:145`** — `tracerouteEnabled: true`. A **display cache only**. The server owns
the value; this is never the source of truth.

**`public/app-ws.js:108`** — `this.tracerouteEnabled = cfg['traceroute.enabled'] ?? true;`
inside the existing `settings` handler. Page state arrives over WS, replayed on connect and
re-broadcast after every config write, so every open tab agrees. No on-demand GET
(BROWSER_CONTRACT).

**`public/app-rotator.js:87-101`** — `toggleTraceroute()`. Lives in this mixin because it
already owns the header's action handlers, though traceroute is unrelated to the rotator; the
comment says so at the call site rather than leaving a future reader to wonder.

Optimistic, and **reverted on failure**:

```js
async toggleTraceroute() {
  const next = !this.tracerouteEnabled;
  this.tracerouteEnabled = next;
  try {
    await fetchJSON('/config/traceroute.enabled', 'PUT', { value: next });
  } catch (e) {
    this.tracerouteEnabled = !next;
    this.showToast('Could not change traceroute', 'error', 4000);
  }
}
```

A button that stays switched after a write that did not land is worse than no button. The
server's `settings` echo is what actually confirms the change; the optimistic flip only makes
the control feel immediate.

## 4. Invariants

- The browser **decides nothing**. It renders `traceroute.enabled` and POSTs a new value. It
  does not gate dispatch, does not cache across reloads, and does not infer the state from
  anything else.
- **Manual traceroute is never gated.** `manual: true` bypasses the switch by design.
- The control is **not** inside the rotator's `x-show`.
- Toggling is a config write like any other — no bespoke endpoint.

## 5. Verified live, 2026-07-29, at 1600×1000 in both themes

| check | result |
|---|---|
| button present in header | 1 element, `visible: true`, 61.8 × 25.5 px at x=444 |
| OFF state matches backend | `GET /config` → `"traceroute.enabled": false`; class `btn-ghost opacity-40`, title "Automatic traceroute OFF — click to enable" |
| click enables | `GET /config` → `true`; class `btn-outline btn-success`, title "…ON — click to disable" |
| **state survives reload** | full page reload → `tracerouteEnabled: true`, ON styling retained |
| click disables | `GET /config` → `false` |
| both themes | `corporate` and `business` screenshots read, not merely captured |
| console | 0 errors (1 pre-existing Tailwind CDN warning) |

The backend gate was verified separately when `d691303` shipped: `enabled=false` produced
`traceroute disabled`, `enabled=true` produced `timeout !987ab80f` — proving the gate is
*reached*, not merely present.

**Left OFF at the end of testing**, which is how Peter set it.

## 6. Known gap, raised not fixed

`public/app-rotator.js` (272 lines) and `public/app.js` (422 lines) have **no module spec** in
`docs/modules/`. `check_specs.py` validates only specs that exist, so a module with no spec
passes silently — it cannot report what is absent. Both files are touched by this task and
neither is covered. Recorded in the `bugs` ledger; not fixed here, because writing two module
specs from scratch is its own task.
