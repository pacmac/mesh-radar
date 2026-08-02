---
module: DISCOVERY_STRATEGY
source_hash: fa29e0979e7091a7e92e20d5f21ca1e298a88f3759aa4addd943dd0d081be623
updated: 2026-08-02
---

# Discovery strategy — work up the ladder, and make it settable

Task: `discovery-strategy-config`.

Peter, 2026-08-02: *"rather than randomly selecting the next target, or selecting
the furthest node, wouldn't it be better to work our way up rather than start at
the top? — this really needs to be configurable via the dash and persist."*

## The problem, measured 13:51:06 UTC

```
runner:    running true, interval 180s, queued 12, attempts 7, replies 0
selection: record 189.1 km, 197 candidates, 15 shown, 44 cooling, 126 suspect
top steps: f3ed +106.5, ?7F4 +124.5, ?AC8 +125.3, ☢ +131.1, ?0D0 +133.2
```

Ranking by smallest step was the right idea and is not enough on its own. The
**24 h per-target cooldown** retires every good candidate after a single attempt,
so the queue walks outward until it is shooting at nodes **106–133 km past
anything we have ever reached**. 44 targets are locked out at any moment.

And a single attempt cannot settle anything. The Frontier's own base rate on
**proven** corridors is ~4% — `Ives` 1/23, `CBay` 1/24, `?2A0` 1/63. Thirty-four
aimed attempts spread across thirty-four different unproven targets is expected
to yield roughly one hit and to teach us nothing about any individual target.
The same thirty-four concentrated on three candidates gives each about a 1−0.96¹¹
≈ **36%** chance. Depth beats breadth at this hit rate, and costs no extra
airtime.

## Two changes

**1. A window, not a horizon.** In `ladder` strategy a candidate is only eligible
if its step past proven ground is within `window_km`. The window ratchets forward
as the record moves; it never chases a 133 km leap.

**2. An attempt budget.** `attempts_per_target` replaces the hardcoded
`attempts >= 40` retire rule, and `cooldown_min` replaces the 24 h lockout. A
target gets N attempts spaced by the cooldown, then retires. At `6` and `30 min`
that is six shots over three hours instead of one shot per day.

Measured impact of the retire threshold on today's data (371 never-answered
targets that have been attempted at least once):

| `attempts_per_target` | retires |
|---|---|
| 6 | 132 |
| 10 | 93 |
| 20 | 51 |
| 40 (today) | 31 |

The 213 positioned nodes never attempted at all are unaffected — they have zero
attempts and stay eligible.

## Settings

One config key, `discovery`:

| field | default | clamp | consumed by |
|---|---|---|---|
| `strategy` | `ladder` | `ladder` \| `portfolio` | `reach.mission` |
| `window_km` | 25 | 1–250 | `reach.mission` (ladder only) |
| `attempts_per_target` | 6 | 1–50 | `reach.mission` |
| `cooldown_min` | 30 | 1–1440 | `reach.mission` |
| `interval_sec` | 180 | 30–3600 | `mission-runner` |
| `enabled` | true | bool | `mission-runner` |

`portfolio` keeps today's behaviour — no window — so a deliberate long shot
remains possible without editing code.

**Clamps are enforced in the PUT, not the UI.** A browser is not a validator, and
`interval_sec: 0` would hammer a shared mesh.

### Why one key in `DEFAULTS`

`config-api.js:133` rejects any key not in `DEFAULTS` (that is why an earlier
`PUT mission_runner` returned *"Unknown config key"*), and `ws-relay.js:449`
builds the settings WS payload by iterating the same `DEFAULTS`. **One list
governs both persistence and browser visibility** — adding the key there gets
both, and the browser needs no fetch.

Runner internals that are not user-facing — `aim_timeout_sec`, `timeout_sec`,
`recent` — stay in `mission-runner.js`'s own `DEFAULTS`. A setting nobody should
be turning is not a setting.

### How a pure inference reads config

`reach.mission` must not call `getConfig` — it is pure and the boundary test
enforces it. It already reads `home.lat`/`home.lon` **through its declared SQL
evidence** (`inferences.js:100`), and the new settings arrive the same way. No
new mechanism, no purity breach.

Consequence worth stating in the UI: selection settings take effect at the **next
recompute** (≤ 15 min), not instantly. Runner settings take effect on the next
tick.

## Exact changes

### `src/config-api.js`

- `DEFAULTS` gains `'discovery'` with the six fields above.
- New `GET /config/discovery` — merged defaults, mirroring `GET /config/radar`.
- New `PUT /config/discovery` — allowlist the six fields, clamp each, `setConfig`,
  `broadcastSettings()`.

### `src/op-manager.js`

- New op `discovery_config`, `class: 'Local'`, `PUT /config/discovery`,
  `read_back_path` the same — mirroring `radar_config` at line 102.

### `src/inferences.js` — `reach.mission`

- Evidence SQL gains four subselects on `config` for `strategy`, `window_km`,
  `attempts_per_target`, `cooldown_min` (extracted from the `discovery` JSON with
  `->>`, with SQL-side fallbacks so a missing key cannot yield null).
- `COOLDOWN` (line 483) ← `cooldown_min × 60`.
- Retire rule (line ~569, `attempts >= 40`) ← `attempts >= attempts_per_target`.
- New: in `ladder`, `step > window_km` → `skipped.beyond_window++`, excluded.
- `global` summary fact gains `skipped_beyond_window` and echoes the active
  `strategy` and `window_km`, so the panel can state the rule it is under.

### `src/mission-runner.js`

- `cfg()` merges `getConfig('discovery')` for `interval_sec` and `enabled`,
  keeping module defaults for the internals.

### `public/partials/tab-cfg.html`

- New `cfgTab === 'discovery'` sub-tab and tab link, mirroring the Radar section:
  strategy select, four numeric inputs, an enabled toggle, save button.

### `public/app-config.js`

- `loadDiscoveryCfg()` / `saveDiscoveryCfg()` mirroring `loadRadarCfg`/
  `saveRadarCfg` at line 384, via `opFlow('discovery_config', …)`.

### Explicitly NOT changed

- `public/partials/tab-observatory.html` — the Missions panel already prints the
  reason string; the new rule surfaces through that text and the summary counts,
  so the board needs no new markup.
- `nodeinfo.favourite` and `src/nodes-api.js` — the Observatory-scoped target
  flag is the **next** task (`obs-target-selection`), deliberately separate.
  Peter: *"that favourite is used for something else. this favourite only applies
  to this observer app."*
- The class quotas (`6/6/4/4`). With a window in force the classes matter much
  less; making them settable too would be four more knobs earning little.

## Invariants

- The inference stays pure — settings arrive as evidence, never as a call.
- Clamps live server-side.
- Every exclusion is counted and published; a shortlist never silently shrinks.
- `portfolio` reproduces today's behaviour exactly, so the change is reversible
  from the dashboard without a deploy.
