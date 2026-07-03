# node-dash Identity Contract

**Status: LAW.** Every task that stores, compares, or transmits an identity
validates against this document. It is the consumer-side enforcement of
`docs/gw/IDENTITY.md` (read that first — field derivation, platform rules,
and the bridge identity rule live there and are not repeated).

Written by task `identity-ssot` (2026-07-03) from a full audit of `src/`,
`public/` and `partials/` — 11 backend violations, ~40 browser translation
sites, 9 mixed-vocabulary comparisons. The migration plan at the bottom
retires them.

---

## 1. The two identity domains

A single rule causes every bug in this family when broken: **a radio is two
things at once, and each thing has exactly one key.**

### Domain D — BLE device (one of OUR connected radios)

- **Canonical key: BLE MAC** — `E9:B0:3F:17:27:91`, uppercase,
  colon-separated. gw field: `__ble_addr` (=`addr`). Available from first
  scan, survives reboots, firmware updates and factory resets.
- `node_id` (`!2687afb1`) is an **attribute** of a device — firmware-assigned,
  null until first sync, lost on factory reset. gw IDENTITY.md consumer rule
  1: "Use `addr` as the stable device key. Index on it."
- `label` / `display_name` / `short_name` / `long_name` are display
  attributes.
- **Never derive node_id from a MAC** (platform-specific offset — gw
  IDENTITY.md §derivation). Resolution goes through the live registry
  (`_liveNodeIds`, persisted as `node_mac.*` config) only.

### Domain N — mesh node (any LoRa node, including our own radios' mesh selves)

- **Canonical key: node num** (uint32). `!hex` is the same value rendered
  (`!%08x`) — legitimate for URLs, mesh addressing, and display.
- `short_name` / `long_name` are display attributes. The 4-char suffix is
  NOT an identifier.

### The conflation trap

Our radios exist in both domains (OMNI = device `E9:B0:3F:17:27:91` AND
mesh node `!2687afb1`/646557617). Code that grabs "whichever identity is in
reach" produces columns like `tilt_history.node_id` holding a MAC, tables
holding `tx_device` as `!hex` beside `rx_device` as MAC, and equality tests
that can never be true. When writing code, ask: *am I identifying one of
our radios (D → MAC) or a participant in the mesh (N → num)?*

## 2. Canonical keys by layer

| Layer | Domain D (our radios) | Domain N (mesh nodes) |
|---|---|---|
| SQLite device/attribution columns | MAC (until Phase B: paired `addr` + `node_id` columns per gw rule 6) | `num` INTEGER; `node_id` TEXT as attribute |
| In-memory maps | MAC | num |
| gw REST path segment | **MAC** (always valid; `!hex` only works post-sync — the `Unknown device` 404 class) | n/a (targets go in bodies as num/`!hex`) |
| gw event ingest | `__ble_addr ?? addr` only; `node_id`/`device` are legacy-replay fallbacks | `from_num` / `to_num` |
| WS payloads to browser | MAC + display bundle (§3) | num + display bundle (§3) |
| Browser runtime state keys | MAC (opaque string — the browser never parses or converts it) | num |
| Persisted browser selections | MAC (with one-time `!hex`→MAC shim on migration) | num |

## 3. Display bundles — the UI never translates

BROWSER_CONTRACT: the browser makes zero decisions. Identity resolution is
a decision. Therefore every backend payload that references an identity
carries the display data alongside the key, and the browser renders fields —
it never looks one identity up from another and never converts vocabulary.

```js
// Device reference (Domain D) — in device_list, tilt_update, ota_*,
// route_discovered, range_test_entry, config_op …
{ addr: "E9:B0:3F:17:27:91",     // THE key. Browser treats as opaque.
  node_id: "!2687afb1" | null,   // attribute (null pre-sync is valid)
  label: "OMNI" }                // resolved display name

// Node reference (Domain N) — in node_list, messages, traceroute rows …
{ num: 3663393832,
  node_id: "!da5af428",          // rendering of num, supplied not derived
  short_name: "TA2m", long_name: "Taunton 2m" }
```

Corollaries: `deviceLabel()`'s dual-vocabulary lookup, the
`_rebuildDeviceConfigs` MAC→node_id master re-key, `parseInt(x.slice(1),16)`
/ `toString(16)` conversions in browser code, and `.toUpperCase()` MAC
folding in the browser all become dead code by the end of the migration.
(`nodeLabel(num)` display lookups die last — Phase C payloads must carry
names first.)

## 4. Rules for new code (effective immediately)

1. New device-identity storage: MAC key, or paired `addr`+`node_id` columns.
   Never a single column that could hold either (gw rule 6).
2. New gw REST calls: MAC in the device path segment.
3. New WS payloads: include the display bundle. No bare device references.
4. New browser state: keyed by what the backend sent; zero conversions.
5. Equality tests must be provably same-vocabulary — if you cannot say what
   vocabulary both sides hold, the design is wrong.
6. Interim exceptions (e.g. tilt-ingest-v2's node_id-preferred key) must be
   documented in the module spec with a pointer to the migration phase that
   retires them.

## 5. Violation inventory (audit 2026-07-03) — the migration worklist

### Backend (11)

| # | Violation | Where | Fixed in |
|---|---|---|---|
| B1 | `tx_device` mixed `!hex`/MAC across rows; `?device=` filter drops PASV rows | traceroute.js, node-list.js, db.js | Phase B |
| B2 | Failure rows `from_num = parseInt(device,16)` → garbage 233 on MAC path | traceroute.js `_recordFailure` | Phase A |
| B3 | Rotator-az stamp compares node_id vs possibly-MAC device — never matches on PASV path | traceroute.js ×2 | Phase A |
| B4 | `messages.device` mixed vocabulary inside the dedup index | persist.js, messages-api.js | Phase B |
| B5 | `resolveDeviceLabel` fed MACs → garbage range-test `rx_name` | ws-relay.js ×2, range-test-api.js | Phase A |
| B6 | `reply_tokens.from_node_id` = `node_id ?? addr`, used as gw path 24 h later | alerts.js, imap-receiver.js | Phase A |
| B7 | `tilt_history.node_id` column holds device identity (currently `!hex` by interim decision) | ws-relay.js, performance-api.js | Phase D |
| B8 | `_ownDevices._device` node_id-preferred while `_cache._device` is MAC | node-list.js | Phase B |
| B9 | `nodes.device` fallback chain can still store node_id when addr absent | persist.js | Phase A |
| B10 | startup.js own-device seed loop keyed `!hex` against MAC config keys — dead code | startup.js | Phase A |
| B11 | gw REST dispatch paths use `!hex` (404s pre-sync) | traceroute-api, op-manager, auto-purge, messages-api, lifecycle | Phase A |

### Browser (headline numbers; full inventory in the audit reports, task 310)

- `!hex` chosen as the runtime device key everywhere (`activeNodeId`,
  `cfgRadioId`, `msgFrom`, `perfDevice`, `deviceConfigs`, `deviceBleStates`,
  op URLs) despite `availableDevices` already carrying MAC + names.
- `_rebuildDeviceConfigs` master MAC→node_id re-key on every device_list.
- ~40 translating call-sites in 16 clusters; 9 mixed-vocabulary compares,
  including one live data-loss bug (tilt gate `ev.addr === activeNodeId`).
- 3 persisted keys (`activeNodeId`, `msgFrom`, `perfDevice`) hold `!hex`.

## 6. Migration phases

Each phase leaves the system consistent — never half-translated. Each is
its own /idiot task; specs updated in the same commit.

**Phase A — backend hygiene (no browser impact).** Fix B2/B3/B5/B9/B10;
B11: all gw REST device path segments resolve to MAC via the registry
(node-id fallback only when no MAC known); B6: reply tokens store MAC.
Nothing the browser consumes changes vocabulary.

**Phase B — storage vocabulary + perf lockstep.** `tx_device` → MAC with
one-shot migration (pattern: `migrateNodeDeviceMac`); perf page scoping
(`perfDevice` persisted value, `?device=` param, `route_discovered` gate,
device pills) flips to MAC **in the same task** — a half-flip silently
empties the perf feed. `messages.device` and B8 land here with their
migrations. Tilt keying (B7) moves to Phase D — its browser gate speaks
`!hex` until Phase C delivers bundles; re-keying it here would break the
display this task must not touch.

**Phase C — payload denormalization + UI de-translation.** WS/REST payloads
gain display bundles; browser re-keys runtime state to MAC; one-time shim
converts the 3 persisted `!hex` selections via the device list; delete the
translation machinery. Coordinates with BROWSER_ARCH (task 268) — this
phase IS that document's identity chapter. Largest phase; sub-tasked per
page when opened.

**Phase D — tilt re-key.** Retire the tilt-ingest-v2 interim: tilt rows
keyed by MAC, browser gate compares bundle fields. Requires Phase C's
payload shape. Verify against the live sensor.

## 7. Amnesty

Legacy rows already migrated: `nodes.device` (189 `!hex`→MAC, task
`node-source-attribution`). Historic `tilt_history` mixed keys and
`messages.device` legacy rows are migrated in Phase B; anything unmappable
(device no longer configured) is left as-is and excluded from device-scoped
queries rather than guessed.
