# Ingestion + storage — spec

Step 3 of `status-rebuild-rip`. Backend only. Nothing browser-facing.

Spec of record: `docs/NODE_STATUS_SPEC.md`. Device contract: `docs/mt-transport/API.md`.

## Scope

Additive ingestion and storage for the channels the focus page will read:

1. `device_metrics` history (new table)
2. `environment_metrics` history — **existing** table, gains dedup
3. Detection events (new table)
4. Portnum 260 `config`/`debug`/`calc` latest-only cache (new table)

## Deliberately NOT in this step

- **Deleting the `bridge-events.js:25` env writer** (bug backlog #1). It sources
  from nodedb *replay* and filters to `ownDeviceNums()`, both iron-rule
  violations — but it feeds the perf tab, so removing it is a regression risk
  that needs its own verification. This step leaves it untouched: it passes
  `packet_id` NULL, so it is unaffected by the new dedup index and keeps
  capturing exactly what it captures today.
- **Purging the 13,571 duplicate / 2,607 bogus-ts existing rows** (backlog #2/#3).
  Cleaning historical data is separate from making ingestion correct.
- **Fixing `ts: data.time || ts`** (backlog #3). Same lines, but a behaviour
  change to existing capture — belongs with the consolidation.
- **`ws-relay.js:466` PRIVATE_APP string-match** (backlog #4).
- **`signal_history`** — named in the stale step title, absent from the spec.
  API.md sources RSSI/SNR from the envelope for *current* signal only; the only
  signal series in the contract is the `@ping`/pong reply, which iron rule 3
  excludes as a data source.

## Schema (`src/db.js`, main schema block)

```sql
CREATE TABLE IF NOT EXISTS device_metrics_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                  INTEGER NOT NULL,
  num                 INTEGER NOT NULL,
  packet_id           INTEGER,
  uptime_seconds      INTEGER,
  voltage             REAL,
  battery_level       INTEGER,
  channel_utilization REAL,
  air_util_tx         REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dmh_dedup  ON device_metrics_history(num, packet_id) WHERE packet_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_dmh_num_ts ON device_metrics_history(num, ts DESC);

CREATE TABLE IF NOT EXISTS detection_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  num       INTEGER NOT NULL,
  packet_id INTEGER,
  type      TEXT,            -- motion|count|alarm|cleared; NULL when payload is not our JSON
  kind      TEXT,            -- overtemp|undertemp|humidity (alarm/cleared only)
  val       REAL,            -- alarm/cleared measured value
  count_num INTEGER,         -- count.num
  msg       TEXT,
  more      INTEGER,         -- 1 when alarm carried more:true (renotify)
  raw       TEXT NOT NULL    -- the original payload string, ALWAYS stored
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_det_dedup  ON detection_events(num, packet_id) WHERE packet_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_det_num_ts ON detection_events(num, ts DESC);

CREATE TABLE IF NOT EXISTS node_app_state (
  num     INTEGER NOT NULL,
  portnum INTEGER NOT NULL,
  type    TEXT    NOT NULL,
  ts      INTEGER NOT NULL,
  payload TEXT    NOT NULL,   -- verbatim JSON as received
  PRIMARY KEY (num, portnum, type)
);
```

`node_app_state` is keyed by `portnum` as well as `type` so it is not a
260-specific table. A future private app caches into the same structure without
a migration.

`environment_history` migration (guarded, `PRAGMA table_info` pattern):

```sql
ALTER TABLE environment_history ADD COLUMN packet_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_env_dedup ON environment_history(num, packet_id) WHERE packet_id IS NOT NULL;
```

The partial index means existing rows (all NULL `packet_id`) are untouched and
the replay writer keeps working. Dedup applies only to rows that carry an id.

## Statements (`src/db.js`)

All inserts are `INSERT OR IGNORE` so a broadcast heard by N gateway radios
collapses to one row via the partial unique index.

- `insertDeviceMetricsHistory` — OR IGNORE, all columns
- `insertDetectionEvent` — OR IGNORE, all columns
- `upsertNodeAppState` — `INSERT ... ON CONFLICT(num, portnum, type) DO UPDATE`
  setting `ts` and `payload`
- `insertEnvHistory` — gains `packet_id`, becomes OR IGNORE

Exported helpers mirror the existing `insertEnvHistory` style.

## Ingestion (`src/persist.js`)

### device_metrics — both existing paths

`handleTelemetryEvent` (`:83`) and `handlePacket`'s TELEMETRY_APP branch
(`:163`) already extract `device_metrics` for `upsertNode`. Each additionally
calls `insertDeviceMetricsHistory` with the packet id — `event.packet_id` on the
event path, `packet.id` on the packet path. `upsertNode` behaviour is unchanged.

### environment_metrics — both existing paths

The two existing `insertEnvHistory` calls (`:115`, `:197`) pass the packet id.
This is what stops the double-write: the same reading arriving as both a
`telemetry` event and a raw `packet` now collapses to one row.

### Detection events — new branch

`handleEvent` gains `else if (type === 'detectionsensor')`. The payload arrives
as a **string** (registry: `KnownProtocol("detectionsensor", onReceive=_onTextReceive)`
— no `protobufFactory`).

Parsing, per API.md §D5/§4:

1. `raw` is always stored verbatim, whatever happens next.
2. Attempt `JSON.parse`. On failure — or on success without a string `type` —
   store with `type` NULL and every typed column NULL. **Never throw.** A stock
   Meshtastic detection module sends plain text on this port by design; one such
   node must not break ingestion for every other node.
3. On success, map by `type`: `alarm`/`cleared` → `kind`, `val`, `msg`, `more`;
   `motion` → `msg`; `count` → `count_num` from `num`.

Unknown `type` values are stored as-is in `type` with the rest NULL — iron rule
2, accept what the device sends.

### Portnum 260 — new branch

`handleEvent` gains `else if (type === 'private_app' && event.portnum === 260)`.

- **Numeric** portnum check, matching the correct `ws-relay.js:455` pattern, not
  the string match at `:466`.
- Decodes `payload_b64` (base64 → utf8), parses JSON, requires a string `type`,
  then upserts `node_app_state` keyed `(num, 260, type)` with the payload stored
  verbatim.
- Non-JSON or missing `type` → ignored silently. Not an error; portnum 260 is
  additive and node-dash must not assume it is the only user.
- **Never reaches the tilt decoder.** 256 is handled in `ws-relay` and untouched.
- No packet_id dedup — `private_app` does not carry one (backlog #5). Latest-only
  upsert is idempotent, so duplicates from N radios are harmless.

## Files changed

| File | Change |
|---|---|
| `src/db.js` | 3 new tables + indexes; `environment_history` packet_id migration; 3 new statements; `insertEnvHistory` gains packet_id + OR IGNORE; new exported helpers |
| `src/persist.js` | device_metrics history on 2 paths; packet_id into 2 env calls; new `detectionsensor` branch; new `private_app`/260 branch |
| `docs/modules/db.md` | document new tables/statements; update `source_hash` |
| `docs/modules/persist.md` | document new branches; update `source_hash` |

Not changed, deliberately: `bridge-events.js` (its env writer keeps working
untouched — see NOT in scope), `ws-relay.js` (tilt/256 untouched).

## Invariants

- A broadcast heard by N gateway radios produces exactly ONE history row.
- A detection payload that is not our JSON is still stored, with `raw` intact.
- Portnum 260 never reaches the tilt decoder; portnum 256 is unaffected.
- `upsertNode` latest-value behaviour is unchanged — history is purely additive.
- Ingestion never throws on malformed device data.

## Done when

- New tables exist with the stated indexes
- A replayed/duplicated telemetry reading inserts one row, not two
- A non-JSON detection payload inserts a row with `raw` set and `type` NULL
- A 260 payload lands in `node_app_state`, and `tilt_history` gains no row
- App boots clean; `python scripts/check_specs.py` prints `All specs current.`
