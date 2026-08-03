import Database from 'better-sqlite3';
import path from 'path';
// The SHARED pure helpers, not a fourth copy of the same formula. utils.js is
// the SSOT for these calculations and is served to the browser too, so server
// and page agree by construction rather than by luck.
import { haversine, bearing as bearingDeg } from './utils.js';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data/node-dash.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    from_num    INTEGER NOT NULL,
    to_num      INTEGER NOT NULL,
    text        TEXT NOT NULL,
    channel     INTEGER NOT NULL DEFAULT 0,
    is_dm       INTEGER NOT NULL DEFAULT 0,
    hop_limit   INTEGER,
    snr         REAL,
    rssi        INTEGER,
    packet_id   INTEGER,
    reply_id    INTEGER,
    device      TEXT,
    replay      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS nodes (
    num             INTEGER PRIMARY KEY,
    node_id         TEXT,
    short_name      TEXT,
    long_name       TEXT,
    hw_model        TEXT,
    role            TEXT,
    last_heard      INTEGER,
    snr             REAL,
    rssi            INTEGER,
    hops            INTEGER,
    lat             REAL,
    lon             REAL,
    alt             INTEGER,
    battery         INTEGER,
    voltage         REAL,
    channel_util    REAL,
    air_util_tx     REAL,
    uptime_seconds  INTEGER,
    device          TEXT,
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    type     TEXT NOT NULL,
    device   TEXT,
    data     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS nodeinfo (
    node_id      TEXT PRIMARY KEY,
    num          INTEGER,
    short_name   TEXT,
    long_name    TEXT,
    hw_model     TEXT,
    role         TEXT,
    lat          REAL,
    lon          REAL,
    alt          INTEGER,
    topic        TEXT,
    first_heard  INTEGER,
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS range_test_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    from_num  INTEGER NOT NULL,
    rssi      INTEGER,
    snr       REAL,
    hops      INTEGER,
    seq       TEXT,
    rx_device TEXT,
    via_mqtt  INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_range_test_ts ON range_test_log(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_nodeinfo_num  ON nodeinfo(num);

  CREATE TABLE IF NOT EXISTS tilt_history (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    node_id  TEXT NOT NULL,
    pitch    REAL NOT NULL,
    roll     REAL NOT NULL,
    x_g      REAL,
    y_g      REAL,
    z_g      REAL
  );

  CREATE INDEX IF NOT EXISTS idx_tilt_ts   ON tilt_history(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_tilt_node ON tilt_history(node_id, ts DESC);

  CREATE TABLE IF NOT EXISTS environment_history (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  INTEGER NOT NULL,
    num                 INTEGER NOT NULL,
    temperature         REAL,
    relative_humidity   REAL,
    barometric_pressure REAL
  );

  CREATE INDEX IF NOT EXISTS idx_env_history_num ON environment_history(num, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_env_history_ts  ON environment_history(ts DESC);

  -- Node focus page ingestion (NODE_STATUS_SPEC / INGESTION_SPEC).
  -- A broadcast heard by N gateway radios is ONE datum: the partial unique
  -- index on (num, packet_id) collapses it, via INSERT OR IGNORE.
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

  -- Standard DETECTION_SENSOR_APP text. The payload is deliberately kept raw;
  -- application-specific interpretation belongs outside node-dash.
  CREATE TABLE IF NOT EXISTS detection_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    num       INTEGER NOT NULL,
    packet_id INTEGER,
    raw       TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_det_dedup  ON detection_events(num, packet_id) WHERE packet_id IS NOT NULL;
  CREATE INDEX        IF NOT EXISTS idx_det_num_ts ON detection_events(num, ts DESC);

  -- THE EVENT LOG. Task event-log. Hooks report here; config writes and boots
  -- report here; one probe's steps share a probe_id so a decision trace can be
  -- grouped out of it.
  --
  -- summary is written AT THE SOURCE and never composed downstream. A trace whose
  -- strings are assembled elsewhere reintroduces exactly the hiding it exists to
  -- end.
  --
  -- The RAW FEED STAYS OUT: ~50 attempts/hour and 216-468 receptions per 15 min
  -- belong in traceroute_history / relay_observation. A probe trace is 5 rows per
  -- probe, not 500 — this log's value is inversely proportional to its volume.
  CREATE TABLE IF NOT EXISTS event_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       INTEGER NOT NULL,
    kind     TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    summary  TEXT NOT NULL,
    detail   TEXT,
    source   TEXT,
    probe_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_event_log_ts    ON event_log(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_event_log_probe ON event_log(probe_id) WHERE probe_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_event_log_kind  ON event_log(kind, ts DESC);

  -- Who relayed each packet, and how it travelled. Task packet-provenance-capture.
  --
  -- Deliberately NOT signal_history: that table is direct-only by design (see its
  -- comment below), because relayed RSSI describes the last hop rather than the
  -- origin. Relay edges are precisely the relayed packets it exists to exclude.
  --
  -- Written for EVERY packet including encrypted ones — from, relay_node, hop_start
  -- and the receiving radio are all in the UNENCRYPTED header, so we learn "X was
  -- relayed by Y" without holding any key.
  --
  -- relay_byte is the LOW BYTE of the relaying node (MeshPacket field 19), so it
  -- resolves to a candidate SET, not a node (~1 in 256 collide). Stored raw; never
  -- resolved here. 0 means NOT RELAYED — proto3 omits zero, so absent is 0, never
  -- unknown. Same rule for hop_limit, and for transport ('TRANSPORT_INTERNAL' = 0).
  CREATE TABLE IF NOT EXISTS relay_observation (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    from_num   INTEGER NOT NULL,
    relay_byte INTEGER NOT NULL DEFAULT 0,
    rx_device  TEXT,
    hop_start  INTEGER,
    hop_limit  INTEGER NOT NULL DEFAULT 0,
    transport  TEXT    NOT NULL DEFAULT 'TRANSPORT_INTERNAL',
    decoded    INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_relay_obs_from  ON relay_observation(from_num, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_relay_obs_byte  ON relay_observation(relay_byte, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_relay_obs_ts    ON relay_observation(ts);

  -- Signal history from the packet ENVELOPE (iron rule 4 — never a payload).
  -- One row per (node, packet); the partial unique index collapses the same
  -- broadcast heard by several gateway radios.
  CREATE TABLE IF NOT EXISTS signal_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    num       INTEGER NOT NULL,
    packet_id INTEGER,
    rssi      REAL,
    snr       REAL,
    hops      INTEGER,
    rx_device TEXT
  );

  -- idx_sig_dedup is created in the migration block below, not here: on an
  -- existing database rx_device does not exist until that block's ALTER runs.
  -- hops is recorded so the direct-only rule stays auditable rather than merely
  -- asserted: any row with hops != 0 is a bug, and can be found.
  CREATE INDEX        IF NOT EXISTS idx_sig_num_ts ON signal_history(num, ts DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup  ON messages(packet_id, device) WHERE packet_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_ts     ON messages(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_from   ON messages(from_num);
  CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_type     ON events(type);
  CREATE INDEX IF NOT EXISTS idx_nodes_updated   ON nodes(updated_at DESC);

  CREATE TABLE IF NOT EXISTS alert_rules (
    type             TEXT PRIMARY KEY,
    enabled          INTEGER NOT NULL DEFAULT 1,
    threshold        REAL,
    cooldown_minutes INTEGER NOT NULL DEFAULT 30,
    last_sent        INTEGER
  );

  CREATE TABLE IF NOT EXISTS reply_tokens (
    token        TEXT PRIMARY KEY,
    from_node_id TEXT NOT NULL,
    to_num       INTEGER NOT NULL,
    reply_id     INTEGER,
    channel      INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS traceroute_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               INTEGER NOT NULL,
    from_num         INTEGER NOT NULL,
    to_num           INTEGER NOT NULL,
    rx_device        TEXT,
    route            TEXT,
    route_back       TEXT,
    snr_towards      TEXT,
    snr_back         TEXT,
    relay_positions  TEXT,
    tx_device        TEXT,
    rotator_az       REAL,
    status           TEXT NOT NULL DEFAULT 'ok'
  );

  CREATE INDEX IF NOT EXISTS idx_traceroute_ts     ON traceroute_history(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_traceroute_to_num ON traceroute_history(to_num, ts DESC);
`);
// ─── Geocode cache ──────────────────────────────────────────────────────────
//
// ITS OWN TABLE, and that is a fix rather than a preference. The cache used to
// live in `nodeinfo.address`, written with
//     UPDATE nodeinfo SET address = ? WHERE num = ?
// and nodeinfo's primary key is node_id, not num — so for any node without a
// nodeinfo row the UPDATE matched nothing and SILENTLY stored nothing. Measured
// 2026-08-02: 193 of the 407 unnamed positioned nodes had no nodeinfo row, so
// each would have been fetched from Nominatim, returned to the caller, discarded,
// and fetched again on the next request. For ever. Against a public service with
// a published etiquette policy.
//
// A cache also does not belong inside identity data: creating sparse nodeinfo
// rows to hold an address would put nodes in the nodeinfo table that never sent
// a nodeinfo packet, which getMqttNode() would then hand back as if they had.
db.exec(`
  CREATE TABLE IF NOT EXISTS geocode_cache (
    num     INTEGER PRIMARY KEY,
    address TEXT NOT NULL,
    ts      INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);
// One-time carry-across of the 194 addresses already stored on nodeinfo, so the
// backfill does not re-request work already paid for.
db.exec(`
  INSERT OR IGNORE INTO geocode_cache (num, address)
  SELECT num, address FROM nodeinfo
  WHERE num IS NOT NULL AND address IS NOT NULL AND address <> ''
`);

// Migrations for columns added after initial schema
{
  const thCols = db.prepare(`PRAGMA table_info(traceroute_history)`).all().map(r => r.name);
  if (!thCols.includes('tx_device'))  db.exec(`ALTER TABLE traceroute_history ADD COLUMN tx_device TEXT`);
  if (!thCols.includes('rotator_az')) db.exec(`ALTER TABLE traceroute_history ADD COLUMN rotator_az REAL`);
  if (!thCols.includes('status'))     db.exec(`ALTER TABLE traceroute_history ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'`);
  // Task `timeout-diagnosis`: a duty-cycle drop, a CSMA defer, a collision and a
  // genuine silence were all recorded identically as 'timeout'. These three make
  // a miss diagnosable. Historic rows stay NULL — not backfilled, because the
  // values were never observed.
  if (!thCols.includes('rtt_ms'))       db.exec(`ALTER TABLE traceroute_history ADD COLUMN rtt_ms INTEGER`);
  if (!thCols.includes('channel_util')) db.exec(`ALTER TABLE traceroute_history ADD COLUMN channel_util REAL`);
  if (!thCols.includes('air_util_tx'))  db.exec(`ALTER TABLE traceroute_history ADD COLUMN air_util_tx REAL`);
}
// environment_history predates the (num, packet_id) dedup rule. The index is
// PARTIAL, so the ~86k existing rows (packet_id NULL) are untouched and the
// bridge-events replay writer — which has no packet id to give — keeps working.
// Dedup applies only to rows that actually carry an id.
{
  const envCols = db.prepare(`PRAGMA table_info(environment_history)`).all().map(r => r.name);
  if (!envCols.includes('packet_id')) db.exec(`ALTER TABLE environment_history ADD COLUMN packet_id INTEGER`);
  // BME680's fourth reading (API.md:52 — MΩ). Specified from the start and
  // silently discarded until 2026-07-18; unlike a display bug the loss is
  // unrecoverable, so history for gas begins here.
  if (!envCols.includes('gas_resistance')) db.exec(`ALTER TABLE environment_history ADD COLUMN gas_resistance REAL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_env_dedup ON environment_history(num, packet_id) WHERE packet_id IS NOT NULL`);
}
// signal_history predates the two-radio gateway. The dedup key was
// (num, packet_id), so when OMNI and YAGI both heard one broadcast the second
// radio's INSERT OR IGNORE was silently dropped and the survivor was whichever
// arrived first — arbitrary, and unattributed since the table had no radio
// column (task `signal-provenance-mixed-source`). Two antennas measuring the
// same packet is the most useful reading the deployment produces, not a
// duplicate. rx_device attributes each measurement and joins the key, so a
// genuine repeat from the SAME radio is still suppressed.
//
// Existing rows are left as-is: they are a mix of true direct reception and
// relay traffic mis-admitted by the hop-arithmetic gate in persist.js, and
// nothing currently distinguishes them. Backfilling rx_device would fabricate
// attribution we do not have.
{
  const sigCols = db.prepare(`PRAGMA table_info(signal_history)`).all().map(r => r.name);
  if (!sigCols.includes('rx_device')) db.exec(`ALTER TABLE signal_history ADD COLUMN rx_device TEXT`);
  // Rebuild the index only when it is still the old 2-column shape. Idempotent
  // across restarts, and never drops an already-correct index.
  const sigKeyCols = db.prepare(`PRAGMA index_info(idx_sig_dedup)`).all().length;
  if (sigKeyCols && sigKeyCols !== 3) db.exec(`DROP INDEX idx_sig_dedup`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sig_dedup ON signal_history(num, packet_id, rx_device) WHERE packet_id IS NOT NULL`);
}
// Favourites live on nodeinfo (persistent), NOT nodes (wiped by clearNodeCache).
{
  const niCols = db.prepare(`PRAGMA table_info(nodeinfo)`).all().map(r => r.name);
  if (!niCols.includes('favourite')) {
    db.exec(`ALTER TABLE nodeinfo ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0`);
  }
}
// OBSERVATORY TARGETS — a SECOND flag, deliberately not `favourite`.
//
// `favourite` drives the sidebar and the node-filter bypass; the three nodes
// starred today are our own local units (TA2m, GARG, GARG, ~2.5 km away).
// Wiring discovery to it would spend airtime tracerouting the garage alarm.
// Peter: "that favourite is used for something else. this favourite only
// applies to this observer app." See docs/DISCOVERY_TARGETING.md.
//
// GUARDED WITH table_xinfo, NOT table_info. table_info OMITS generated columns,
// so a guard reading it can conclude the column is missing on every boot and
// re-ALTER forever — which took node-dash and DEV1 down once already.
{
  const niCols2 = db.prepare(`PRAGMA table_xinfo(nodeinfo)`).all().map(r => r.name);
  if (!niCols2.includes('obs_target')) {
    db.exec(`ALTER TABLE nodeinfo ADD COLUMN obs_target INTEGER NOT NULL DEFAULT 0`);
  }
}

const existingCols = db.prepare(`PRAGMA table_info(messages)`).all().map(r => r.name);
if (!existingCols.includes('reply_id')) {
  db.exec(`ALTER TABLE messages ADD COLUMN reply_id INTEGER`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_id) WHERE reply_id IS NOT NULL`);
}
if (!existingCols.includes('hops'))       db.exec(`ALTER TABLE messages ADD COLUMN hops INTEGER`);
if (!existingCols.includes('short_name')) db.exec(`ALTER TABLE messages ADD COLUMN short_name TEXT`);
if (!existingCols.includes('long_name'))  db.exec(`ALTER TABLE messages ADD COLUMN long_name TEXT`);
if (!existingCols.includes('alerted_at')) db.exec(`ALTER TABLE messages ADD COLUMN alerted_at INTEGER`);
if (!existingCols.includes('status'))      db.exec(`ALTER TABLE messages ADD COLUMN status TEXT`);
if (!existingCols.includes('message_key')) db.exec(`ALTER TABLE messages ADD COLUMN message_key TEXT`);
if (!existingCols.includes('rx_devices'))  db.exec(`ALTER TABLE messages ADD COLUMN rx_devices TEXT`);
// Traffic class for the message feed filter: 'chat' | 'command' | 'ping' on
// outbound; NULL on received rows until the filter task types those too.
if (!existingCols.includes('category'))    db.exec(`ALTER TABLE messages ADD COLUMN category TEXT`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_key ON messages(message_key) WHERE message_key IS NOT NULL`);
const tiltCols = db.prepare(`PRAGMA table_info(tilt_history)`).all().map(r => r.name);
if (!tiltCols.includes('ncal')) {
  db.exec(`ALTER TABLE tilt_history ADD COLUMN ncal INTEGER NOT NULL DEFAULT 0`);
}
for (const [col, def] of [
  ['version',      'INTEGER'], ['flags',       'INTEGER'],
  ['sample_count', 'INTEGER'], ['window_ms',   'INTEGER'],
  ['avg_roll',     'REAL'],    ['avg_pitch',   'REAL'],
  ['min_roll',     'REAL'],    ['max_roll',    'REAL'],
  ['min_pitch',    'REAL'],    ['max_pitch',   'REAL'],
  ['p2p_roll',     'REAL'],    ['p2p_pitch',   'REAL'],
  ['max_delta',    'REAL'],    ['rms_motion',  'REAL'],
]) {
  if (!tiltCols.includes(col)) db.exec(`ALTER TABLE tilt_history ADD COLUMN ${col} ${def}`);
}
const nodeinfoCols = db.prepare(`PRAGMA table_info(nodeinfo)`).all().map(r => r.name);
if (!nodeinfoCols.includes('first_heard')) {
  db.exec(`ALTER TABLE nodeinfo ADD COLUMN first_heard INTEGER`);
  db.exec(`UPDATE nodeinfo SET first_heard = unixepoch() - (7 * 86400) WHERE first_heard IS NULL`);
}
const yagiCols = ['yagi_last_targeted','yagi_target_count','yagi_last_contact',
                  'yagi_contact_count','yagi_best_rssi','yagi_best_snr','yagi_last_rssi','yagi_last_snr'];
for (const col of yagiCols) {
  if (!nodeinfoCols.includes(col)) {
    const def = col.endsWith('_count') ? 'INTEGER NOT NULL DEFAULT 0' : 'INTEGER';
    if (col === 'yagi_best_snr' || col === 'yagi_last_snr') {
      db.exec(`ALTER TABLE nodeinfo ADD COLUMN ${col} REAL`);
    } else {
      db.exec(`ALTER TABLE nodeinfo ADD COLUMN ${col} ${def}`);
    }
  }
}
if (!nodeinfoCols.includes('last_traceroute')) {
  db.exec(`ALTER TABLE nodeinfo ADD COLUMN last_traceroute TEXT`);
}
if (!nodeinfoCols.includes('address')) {
  db.exec(`ALTER TABLE nodeinfo ADD COLUMN address TEXT`);
}
if (!nodeinfoCols.includes('hops_away')) {
  // Our real-time getHopsAway result, persisted so REPORTED hops survives
  // restarts and accumulates like the firmware NodeDB (never read from it).
  db.exec(`ALTER TABLE nodeinfo ADD COLUMN hops_away INTEGER`);
}

const nodeCols = db.prepare(`PRAGMA table_info(nodes)`).all().map(r => r.name);
const envCols = ['temperature', 'relative_humidity', 'barometric_pressure'];
for (const col of envCols) {
  if (!nodeCols.includes(col)) {
    db.exec(`ALTER TABLE nodes ADD COLUMN ${col} REAL`);
  }
}

// Seed default alert rules (INSERT OR IGNORE preserves user customisations)
const _seedRules = db.prepare(
  `INSERT OR IGNORE INTO alert_rules (type, enabled, threshold, cooldown_minutes) VALUES (?, ?, ?, ?)`
);
db.transaction(() => {
  _seedRules.run('node_offline',      1, 30,   60);
  _seedRules.run('ble_disconnect',    1, null,  5);
  _seedRules.run('temp_high',         1, 50,   30);
  _seedRules.run('condensation',      1, 3,    60);
  _seedRules.run('dm_received',       1, null,  5);
  _seedRules.run('broadcast_direct',  1, null,  5);
  _seedRules.run('tilt_high',         1, 10,   30);
})();

export const stmts = {
  insertMessage: db.prepare(`
    INSERT OR IGNORE INTO messages (ts, from_num, to_num, text, channel, is_dm, hop_limit, snr, rssi, packet_id, reply_id, device, replay, hops, short_name, long_name)
    VALUES (@ts, @from_num, @to_num, @text, @channel, @is_dm, @hop_limit, @snr, @rssi, @packet_id, @reply_id, @device, @replay, @hops, @short_name, @long_name)
  `),

  insertRxMessage: db.prepare(`
    INSERT INTO messages
      (ts, from_num, to_num, text, channel, is_dm, hop_limit, snr, rssi,
       packet_id, reply_id, device, replay, hops, short_name, long_name, message_key, rx_devices)
    VALUES
      (@ts, @from_num, @to_num, @text, @channel, @is_dm, @hop_limit, @snr, @rssi,
       @packet_id, @reply_id, @device, @replay, @hops, @short_name, @long_name, @message_key, @device)
    ON CONFLICT(message_key) WHERE message_key IS NOT NULL DO UPDATE SET
      snr        = CASE WHEN excluded.snr  IS NOT NULL AND (snr  IS NULL OR excluded.snr  > snr)  THEN excluded.snr  ELSE snr  END,
      rssi       = CASE WHEN excluded.rssi IS NOT NULL AND (rssi IS NULL OR excluded.rssi > rssi) THEN excluded.rssi ELSE rssi END,
      rx_devices = CASE
        WHEN rx_devices IS NULL THEN excluded.device
        WHEN excluded.device IS NULL THEN rx_devices
        WHEN instr(',' || rx_devices || ',', ',' || excluded.device || ',') > 0 THEN rx_devices
        ELSE rx_devices || ',' || excluded.device
      END
  `),

  insertTxMessage: db.prepare(`
    INSERT OR IGNORE INTO messages
      (ts, from_num, to_num, text, channel, is_dm, hop_limit, snr, rssi,
       packet_id, reply_id, device, replay, hops, short_name, long_name, message_key, category)
    VALUES
      (@ts, @from_num, @to_num, @text, @channel, @is_dm, @hop_limit, @snr, @rssi,
       @packet_id, @reply_id, @device, @replay, @hops, @short_name, @long_name, @message_key, @category)
  `),

  updateMessageStatus: db.prepare(`
    UPDATE messages SET status = @status
    WHERE packet_id = @packet_id
      AND (message_key LIKE 't-%' OR message_key IS NULL)
  `),

  upsertNodeinfo: db.prepare(`
    INSERT INTO nodeinfo (node_id, num, short_name, long_name, hw_model, role, lat, lon, alt, topic, first_heard, updated_at)
    VALUES (@node_id, @num, @short_name, @long_name, @hw_model, @role, @lat, @lon, @alt, @topic, unixepoch(), unixepoch())
    ON CONFLICT(node_id) DO UPDATE SET
      num        = COALESCE(excluded.num,        num),
      short_name = COALESCE(excluded.short_name, short_name),
      long_name  = COALESCE(excluded.long_name,  long_name),
      hw_model   = COALESCE(excluded.hw_model,   hw_model),
      role       = COALESCE(excluded.role,        role),
      lat        = COALESCE(excluded.lat,         lat),
      lon        = COALESCE(excluded.lon,         lon),
      alt        = COALESCE(excluded.alt,         alt),
      topic      = COALESCE(excluded.topic,       topic),
      updated_at = unixepoch()
  `),

  // Monotonic last_heard gate (task nodeinfo-replay-regression, 2026-07-25):
  // node_info/node_update is a BLE nodedb replay, not reception evidence — the
  // radio replays its whole onboard cache on every BLE sync, which for any
  // node it hasn't personally re-heard recently is itself stale. Without the
  // WHERE guard, that replay applies unconditionally and can roll a fresher
  // row's short_name/long_name/hw_model/position/last_heard BACKWARD to an
  // old snapshot. A NULL excluded.last_heard (no caller currently sends one)
  // or a NULL stored last_heard still allows the update — this only ever
  // rejects an incoming row strictly OLDER than what's already stored.
  upsertNode: db.prepare(`
    INSERT INTO nodes (num, node_id, short_name, long_name, hw_model, role, last_heard, snr, rssi, hops,
                       lat, lon, alt, battery, voltage, channel_util, air_util_tx, uptime_seconds, device, updated_at)
    VALUES (@num, @node_id, @short_name, @long_name, @hw_model, @role, @last_heard, @snr, @rssi, @hops,
            @lat, @lon, @alt, @battery, @voltage, @channel_util, @air_util_tx, @uptime_seconds, @device, unixepoch())
    ON CONFLICT(num) DO UPDATE SET
      node_id        = COALESCE(excluded.node_id,        node_id),
      short_name     = COALESCE(excluded.short_name,     short_name),
      long_name      = COALESCE(excluded.long_name,      long_name),
      hw_model       = COALESCE(excluded.hw_model,       hw_model),
      role           = COALESCE(excluded.role,           role),
      last_heard     = COALESCE(excluded.last_heard,     last_heard),
      snr            = COALESCE(excluded.snr,            snr),
      rssi           = COALESCE(excluded.rssi,           rssi),
      hops           = COALESCE(excluded.hops,           hops),
      lat            = COALESCE(excluded.lat,            lat),
      lon            = COALESCE(excluded.lon,            lon),
      alt            = COALESCE(excluded.alt,            alt),
      battery        = COALESCE(excluded.battery,        battery),
      voltage        = COALESCE(excluded.voltage,        voltage),
      channel_util   = COALESCE(excluded.channel_util,   channel_util),
      air_util_tx    = COALESCE(excluded.air_util_tx,    air_util_tx),
      uptime_seconds = COALESCE(excluded.uptime_seconds, uptime_seconds),
      device         = COALESCE(excluded.device,         device),
      updated_at     = unixepoch()
    WHERE excluded.last_heard IS NULL OR nodes.last_heard IS NULL OR excluded.last_heard >= nodes.last_heard
  `),

  insertEvent: db.prepare(`
    INSERT INTO events (ts, type, device, data) VALUES (@ts, @type, @device, @data)
  `),

  insertRangeTest: db.prepare(`
    INSERT INTO range_test_log (ts, from_num, rssi, snr, hops, seq, rx_device, via_mqtt)
    VALUES (@ts, @from_num, @rssi, @snr, @hops, @seq, @rx_device, @via_mqtt)
  `),

  queryRangeTest: db.prepare(`
    SELECT id, ts, from_num, rssi, snr, hops, seq, rx_device, via_mqtt
    FROM range_test_log ORDER BY ts DESC LIMIT ?
  `),

  clearRangeTest: db.prepare(`DELETE FROM range_test_log`),
  clearNodes:     db.prepare(`DELETE FROM nodes`),

  getNodeinfoByNum: db.prepare(`SELECT * FROM nodeinfo WHERE num = ? LIMIT 1`),

  setFavourite: db.prepare(`UPDATE nodeinfo SET favourite = @favourite WHERE num = @num`),

  queryFavourites: db.prepare(`
    SELECT num, node_id, COALESCE(long_name, short_name, node_id) AS label
    FROM nodeinfo WHERE favourite = 1 AND num IS NOT NULL
    ORDER BY COALESCE(long_name, short_name, node_id)
  `),

  // Full persisted row for a favourite, so it can be shown even when it has not
  // been heard since the last restart (the live cache is in-memory only).
  queryFavouriteNodes: db.prepare(`
    SELECT num, node_id, short_name, long_name, hw_model, role, lat, lon, alt, hops_away, obs_target
    FROM nodeinfo WHERE favourite = 1 AND num IS NOT NULL
  `),

  upsertTraceroute: db.prepare(`
    UPDATE nodeinfo SET last_traceroute = @json, updated_at = unixepoch() WHERE num = @num
  `),

  // Persist the live-computed hops-away (getHopsAway). No-op if the node has no
  // nodeinfo row yet (same as upsertTraceroute) — reloaded via enrichFromCache.
  upsertNodeHopsAway: db.prepare(`
    UPDATE nodeinfo SET hops_away = @hops, updated_at = unixepoch() WHERE num = @num
  `),

  insertTracerouteHistory: db.prepare(`
    INSERT INTO traceroute_history
      (ts, from_num, to_num, rx_device, route, route_back, snr_towards, snr_back, relay_positions, tx_device, rotator_az, status, rtt_ms, channel_util, air_util_tx)
    VALUES
      (@ts, @from_num, @to_num, @rx_device, @route, @route_back, @snr_towards, @snr_back, @relay_positions, @tx_device, @rotator_az, @status, @rtt_ms, @channel_util, @air_util_tx)
  `),

  // Failed dispatch attempts (timeout / send error) — payload columns stay NULL.
  // Without these rows every stat is survivorship-biased.
  insertTracerouteFailure: db.prepare(`
    INSERT INTO traceroute_history (ts, from_num, to_num, tx_device, rotator_az, status, rtt_ms, channel_util, air_util_tx)
    VALUES (@ts, @from_num, @to_num, @tx_device, @rotator_az, @status, @rtt_ms, @channel_util, @air_util_tx)
  `),

  queryTracerouteHistory: db.prepare(`
    SELECT th.*,
           n.lat    AS to_lat,
           n.lon    AS to_lon,
           n.short_name AS to_short_name
    FROM traceroute_history th
    LEFT JOIN nodes n ON n.num = th.to_num
    WHERE (@to_num IS NULL OR th.to_num = @to_num)
    ORDER BY th.ts DESC LIMIT @limit
  `),

  queryTracerouteHistoryByDevice: db.prepare(`
    SELECT th.*,
           n.lat    AS to_lat,
           n.lon    AS to_lon,
           n.short_name AS to_short_name
    FROM traceroute_history th
    LEFT JOIN nodes n ON n.num = th.to_num
    WHERE th.tx_device = @device
    ORDER BY th.ts DESC LIMIT @limit
  `),

  backfillTracerouteTxDevice: db.prepare(`
    UPDATE traceroute_history SET tx_device = @device WHERE tx_device IS NULL
  `),

  upsertNodeEnvMetrics: db.prepare(`
    INSERT INTO nodes (num, temperature, relative_humidity, barometric_pressure, last_heard, updated_at)
    VALUES (@num, @temperature, @relative_humidity, @barometric_pressure, @last_heard, unixepoch())
    ON CONFLICT(num) DO UPDATE SET
      temperature         = COALESCE(excluded.temperature,         temperature),
      relative_humidity   = COALESCE(excluded.relative_humidity,   relative_humidity),
      barometric_pressure = COALESCE(excluded.barometric_pressure, barometric_pressure),
      updated_at          = unixepoch()
  `),

  recordYagiTargeted: db.prepare(`
    UPDATE nodeinfo
    SET yagi_last_targeted = unixepoch(),
        yagi_target_count  = yagi_target_count + 1
    WHERE num = ?
  `),

  recordYagiContact: db.prepare(`
    UPDATE nodeinfo
    SET yagi_last_contact  = unixepoch(),
        yagi_contact_count = yagi_contact_count + 1,
        yagi_last_rssi     = COALESCE(@rssi, yagi_last_rssi),
        yagi_last_snr      = COALESCE(@snr,  yagi_last_snr),
        yagi_best_rssi     = CASE WHEN @rssi IS NOT NULL AND (yagi_best_rssi IS NULL OR @rssi > yagi_best_rssi)
                                  THEN @rssi ELSE yagi_best_rssi END,
        yagi_best_snr      = CASE WHEN @snr  IS NOT NULL AND (yagi_best_snr  IS NULL OR @snr  > yagi_best_snr)
                                  THEN @snr  ELSE yagi_best_snr  END
    WHERE num = @num
  `),

  getGeocode:  db.prepare(`SELECT address FROM geocode_cache WHERE num = ? LIMIT 1`),
  setGeocode:  db.prepare(`INSERT INTO geocode_cache (num, address) VALUES (?, ?)
                           ON CONFLICT(num) DO UPDATE SET address = excluded.address, ts = unixepoch()`),
  // Positioned nodes with no cached address, nearest work first. Drives the
  // backfill; an empty result is the normal steady state.
  geocodeTodo: db.prepare(`SELECT n.num FROM nodes n
                           LEFT JOIN geocode_cache g ON g.num = n.num
                           WHERE n.lat IS NOT NULL AND n.lon IS NOT NULL AND g.num IS NULL
                           LIMIT ?`),

  getConfig:   db.prepare(`SELECT value FROM config WHERE key = ?`),
  setConfig:   db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  deleteConfig: db.prepare(`DELETE FROM config WHERE key = ?`),
  getNodePos:  db.prepare(`
    SELECT lat, lon FROM nodes WHERE num = ? AND lat IS NOT NULL
    UNION ALL
    SELECT lat, lon FROM nodeinfo WHERE num = ? AND lat IS NOT NULL
    LIMIT 1
  `),

  getNodeDevices: db.prepare(`SELECT num, device FROM nodes WHERE device IS NOT NULL`),

  insertTilt: db.prepare(`
    INSERT INTO tilt_history (ts, node_id, pitch, roll, version, sample_count, window_ms,
      avg_roll, avg_pitch, min_roll, max_roll, min_pitch, max_pitch,
      max_delta, rms_motion)
    VALUES (@ts, @node_id, @pitch, @roll, @version, @sample_count, @window_ms,
      @avg_roll, @avg_pitch, @min_roll, @max_roll, @min_pitch, @max_pitch,
      @max_delta, @rms_motion)
  `),

  queryTilt: db.prepare(`
    SELECT ts, pitch, roll, version, sample_count, window_ms,
      avg_roll, avg_pitch, min_roll, max_roll, min_pitch, max_pitch,
      max_delta, rms_motion
    FROM tilt_history
    WHERE node_id = ? AND ts >= ? AND ncal = 0
    ORDER BY ts ASC
  `),

  queryAllTilt: db.prepare(`
    SELECT ts, node_id, pitch, roll, version, sample_count, window_ms,
      avg_roll, avg_pitch, min_roll, max_roll, min_pitch, max_pitch,
      max_delta, rms_motion
    FROM tilt_history
    WHERE ts >= ? AND ncal = 0
    ORDER BY ts ASC
  `),

  markNcal: db.prepare(`
    UPDATE tilt_history SET ncal = 1
    WHERE node_id = ? AND ts BETWEEN ? AND ?
  `),

  // OR IGNORE + the partial unique index on (num, packet_id): the same reading
  // arriving as both a `telemetry` event and a raw `packet`, or via N gateway
  // radios, collapses to one row. A NULL packet_id is never deduped.
  insertEnvHistory: db.prepare(`
    INSERT OR IGNORE INTO environment_history (ts, num, packet_id, temperature, relative_humidity, barometric_pressure, gas_resistance)
    VALUES (@ts, @num, @packet_id, @temperature, @relative_humidity, @barometric_pressure, @gas_resistance)
  `),

  insertDeviceMetricsHistory: db.prepare(`
    INSERT OR IGNORE INTO device_metrics_history
      (ts, num, packet_id, uptime_seconds, voltage, battery_level, channel_utilization, air_util_tx)
    VALUES
      (@ts, @num, @packet_id, @uptime_seconds, @voltage, @battery_level, @channel_utilization, @air_util_tx)
  `),

  insertDetectionEvent: db.prepare(`
    INSERT OR IGNORE INTO detection_events (ts, num, packet_id, raw)
    VALUES (@ts, @num, @packet_id, @raw)
  `),

  // node_status RPC reads (NODE_STATUS_RPC_SPEC). Read-only; ASC by ts so the
  // series arrive chart-ready and the browser never sorts.
  queryDeviceMetricsHistory: db.prepare(`
    SELECT ts, uptime_seconds, voltage, battery_level, channel_utilization, air_util_tx
    FROM device_metrics_history WHERE num = ? AND ts >= ?
    ORDER BY ts ASC
  `),

  queryDetectionEvents: db.prepare(`
    SELECT ts, raw
    FROM detection_events WHERE num = ? AND ts >= ?
    ORDER BY ts DESC LIMIT ?
  `),

  getNodeByNum: db.prepare(`SELECT * FROM nodes WHERE num = ? LIMIT 1`),

  insertSignalHistory: db.prepare(`
    INSERT OR IGNORE INTO signal_history (ts, num, packet_id, rssi, snr, hops, rx_device)
    VALUES (@ts, @num, @packet_id, @rssi, @snr, @hops, @rx_device)
  `),

  // Reference range for a node's BME680. Returns the ordered values so the
  // caller can take percentiles: MIN()/MAX() would let one spurious reading
  // (an esp3 at 1115 MΩ, or a cold-start artefact) define the whole scale.
  // Per-node because absolute resistance differs wildly between sensor units.
  queryGasValues: db.prepare(`
    SELECT gas_resistance AS v FROM environment_history
    WHERE num = ? AND gas_resistance IS NOT NULL AND ts >= ?
    ORDER BY gas_resistance ASC
  `),

  querySignalHistory: db.prepare(`
    SELECT ts, rssi, snr, rx_device FROM signal_history WHERE num = ? AND ts >= ?
    ORDER BY ts ASC
  `),

  // Most recent genuinely-direct capture for a node, any radio.
  //
  // The comment that stood here claimed `nodes.rssi`/`nodes.snr` "are themselves
  // gated to direct reception". THAT WAS FALSE — handleNodeInfo wrote mesh-gw's
  // ungated nodedb aggregate straight in (fixed 2026-07-29, task
  // `signal-ssot-header`). The invariant is documented in
  // docs/RSSI_ATTRIBUTION_SPEC.md; it was broken while the comment asserted it
  // held, which is why nobody looked. Left as a warning, not tidied away.
  latestSignalTs: db.prepare(`
    SELECT ts FROM signal_history WHERE num = ? ORDER BY ts DESC LIMIT 1
  `),

  // Each radio's MOST RECENT direct reading of a node — the row set the node
  // page's header summarises and the Reachability section lists, so the two
  // cannot disagree (docs/SIGNAL_SSOT_SPEC.md §2).
  //
  // rx_device IS NOT NULL is not a tidy-up: 18,681 of 29,897 rows predate the
  // per-radio key (635139d) and carry no attribution at all. Including them
  // would put an unattributable reading in a per-radio table. They are not
  // backfilled — inventing attribution we do not have is the defect this whole
  // task removes.
  //
  // LATEST per radio, never best-ever: GARG's best-ever is -17 dBm from 27 Jul,
  // when it sat on the bench beside the radios.
  latestDirectPerRadio: db.prepare(`
    SELECT rx_device, ts, rssi, snr FROM (
      SELECT rx_device, ts, rssi, snr,
             ROW_NUMBER() OVER (PARTITION BY rx_device ORDER BY ts DESC) rn
      FROM signal_history
      WHERE num = ? AND rx_device IS NOT NULL AND (rssi IS NOT NULL OR snr IS NOT NULL)
    ) WHERE rn = 1
  `),

  // Fallback for the header when a node has NO attributed rows: 18,681 of
  // 29,897 signal_history rows predate rx_device, and for a node last heard
  // before 635139d that can be all of them. The reading is still direct-gated —
  // only the RADIO is unknown — so dropping the Signal tile entirely would
  // withhold a fact we hold. Rendered without a radio name, which is the honest
  // shape: we know it arrived directly, we do not know on which antenna.
  latestDirectAny: db.prepare(`
    SELECT ts, rssi, snr FROM signal_history
    WHERE num = ? AND (rssi IS NOT NULL OR snr IS NOT NULL)
    ORDER BY ts DESC LIMIT 1
  `),

  // Hop counts per radio. From `messages`, NOT signal_history — the latter is
  // 100% hops=0 by construction (it stores direct receptions only, per
  // RSSI_ATTRIBUTION_SPEC), so a "least hops" derived from it would always be 0
  // and mean nothing. `messages` is the only store holding RELAYED receptions
  // with the radio that heard them.
  //
  // Returns the minimum and the direct/total split per radio, because a
  // best-case hop count without its typicality is how a 2.5 km link came to
  // render as "-36 dBm / hops 0".
  hopsByRadio: db.prepare(`
    SELECT device AS rx_device,
           MIN(hops)                                   AS min_hops,
           SUM(CASE WHEN hops = 0 THEN 1 ELSE 0 END)   AS direct_n,
           COUNT(*)                                    AS total_n,
           MAX(ts)                                     AS last_ts
    FROM messages
    WHERE from_num = ? AND ts >= ? AND hops IS NOT NULL AND device IS NOT NULL
    GROUP BY device
  `),

  // Traceroute outcomes since a node's last SUCCESSFUL trace. A verified hop
  // count can be correct and ancient at the same time; what the page must not
  // do is present it as current when the refresh path is dead. GARG: 8 ok (last
  // 14 Jul 17:51), then 880 timeouts. That count is the honest qualifier and it
  // is measured, not an adjective.
  tracerouteHealth: db.prepare(`
    SELECT
      (SELECT MAX(ts) FROM traceroute_history WHERE to_num = @num AND status = 'ok') AS last_ok_ts,
      (SELECT COUNT(*) FROM traceroute_history
         WHERE to_num = @num AND status != 'ok'
           AND ts > COALESCE((SELECT MAX(ts) FROM traceroute_history
                                WHERE to_num = @num AND status = 'ok'), 0)) AS failed_since
  `),

  // One-shot backfill: messages carry the envelope rssi/snr recorded at
  // reception, so they are the same datum, not a second source.
  backfillSignalFromMessages: db.prepare(`
    INSERT OR IGNORE INTO signal_history (ts, num, packet_id, rssi, snr, hops)
    SELECT ts, from_num, packet_id, rssi, snr, hops FROM messages
    WHERE (rssi IS NOT NULL OR snr IS NOT NULL) AND from_num IS NOT NULL
      AND hops = 0
  `),

  queryEnvHistory: db.prepare(`
    SELECT ts, temperature, relative_humidity, barometric_pressure, gas_resistance
    FROM environment_history WHERE num = ? AND ts >= ?
    ORDER BY ts ASC
  `),

  queryAllEnvHistory: db.prepare(`
    SELECT ts, num, temperature, relative_humidity, barometric_pressure, gas_resistance
    FROM environment_history WHERE ts >= ?
    ORDER BY ts ASC
  `),

};

export function getConfig(key, fallback = null) {
  const row = stmts.getConfig.get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setConfig(key, value) {
  stmts.setConfig.run(key, JSON.stringify(value));
}

export function deleteConfig(key) {
  stmts.deleteConfig.run(key);
}

/** Recent traceroutes that a DIRECTIONAL dispatch produced — the discovery
 *  runner's own attempts, newest first.
 *
 *  `rotator_az IS NOT NULL` is what distinguishes them: a passive trace of
 *  whatever just arrived carries no azimuth, because nothing aimed for it.
 *
 *  Exists so the runner's activity feed survives a restart. That feed is
 *  in-memory and pm2 watches src/, so every edit emptied it and the panel
 *  announced "no attempt has completed yet this session" mid-stride — which
 *  reads as nothing happening. The attempts were never lost; they were here.
 *
 *  A named query rather than exporting the database handle: `db` is deliberately
 *  module-private, and handing it out invites arbitrary SQL from anywhere. */
/** num -> last_heard, for every node we have ever heard. One query rather than
 *  one per row: the Observatory feeds render 100+ rows and a per-row lookup on
 *  every recompute is a needless N+1. */
/** num -> {lat, lon}, for every positioned node. Same batching reason as
 *  lastHeardMap(): the feeds need a bearing per row and a per-row query on
 *  every recompute is a needless N+1. */
export function positionMap() {
  const m = new Map();
  for (const r of db.prepare(`SELECT num, lat, lon FROM nodes
                              WHERE lat IS NOT NULL AND lon IS NOT NULL AND lat <> 0`).all()) {
    m.set(r.num, { lat: r.lat, lon: r.lon });
  }
  return m;
}

/** The busiest channel utilisation our own radios currently report, or null.
 *
 *  Read from `nodes`, which the telemetry path keeps current — NOT from the
 *  rotator, which has no such field. The busiest radio is the right one to gate
 *  on: if either of ours sees a loaded channel, adding to it is the thing the
 *  brake exists to avoid. */
export function ourChannelUtil(nums) {
  if (!nums || !nums.size) return null;
  const list = [...nums];
  const rows = db.prepare(
    `SELECT channel_util FROM nodes
      WHERE num IN (${list.map(() => '?').join(',')}) AND channel_util IS NOT NULL`
  ).all(...list);
  if (!rows.length) return null;
  return Math.max(...rows.map(r => r.channel_util));
}

/** ONE radio's last-reported airtime state. Task `timeout-diagnosis`.
 *
 *  Deliberately not `ourChannelUtil()`, which takes the MAX across our radios —
 *  right for a global brake, wrong here. The question a stored row has to answer
 *  is whether THIS radio was throttled when THIS packet went out, and a busy
 *  OMNI says nothing about a YAGI dispatch.
 *
 *  LAST-REPORTED, NOT INSTANTANEOUS. Device telemetry is periodic, so these are
 *  whatever the radio last told us and may be minutes old. They must never be
 *  described as readings taken at the moment of transmission.
 */
export function radioAirtime(num) {
  if (!num) return { channel_util: null, air_util_tx: null };
  const r = db.prepare('SELECT channel_util, air_util_tx FROM nodes WHERE num = ?').get(num);
  return {
    channel_util: r?.channel_util ?? null,
    air_util_tx:  r?.air_util_tx  ?? null,
  };
}

/** THE BOARD'S THREE VERDICTS. Task `board-verdicts`.
 *
 *  Peter, 2026-08-03: "at first glance it has been identical since it was first
 *  built, I see no progress and no evidence that anything is even happening."
 *
 *  The board's job is to say whether the hunt is WORKING, not to list state. Its
 *  specification is the five failures that were invisible on 2026-08-02/03:
 *  passive tracing off for 9.5 h; traceroute.enabled false for 5 days; close-range
 *  answer rate 58% -> 7%; the beam 148 deg off; the record flat 30 days. A board
 *  that would not surface those is not finished.
 *
 *  Every verdict carries a SERVER-WRITTEN basis string. BROWSER_CONTRACT gives the
 *  browser no decisions, and a coloured light with no stated reason is a magic
 *  number wearing a colour.
 */
export function boardVerdicts(days = 30) {
  const now  = Math.floor(Date.now() / 1000);
  const win  = Number(days) > 0 ? Number(days) : 3650;   // "all time" still needs a span
  const from = now - win * 86400;
  const prevFrom = from - win * 86400;
  const home = db.prepare(`
    SELECT (SELECT CAST(value AS REAL) FROM config WHERE key='home.lat') lat,
           (SELECT CAST(value AS REAL) FROM config WHERE key='home.lon') lon`).get();
  const KM = `6371.0*2*asin(min(1.0,sqrt(
      power(sin((n.lat-@hlat)*0.0174532925/2),2) +
      cos(@hlat*0.0174532925)*cos(n.lat*0.0174532925)*
      power(sin((n.lon-@hlon)*0.0174532925/2),2))))`;

  // ── LOOP ──────────────────────────────────────────────────────────────────
  // Judged against the CONFIGURED cadence, not a fixed number, so the verdict
  // follows discovery.interval_sec instead of contradicting it.
  const interval = Number((getConfig('discovery', {}) || {}).interval_sec) || 180;
  const lastTs = db.prepare('SELECT MAX(ts) t FROM traceroute_history').get()?.t ?? null;
  const since  = lastTs ? now - lastTs : null;
  const perHour = db.prepare(
    `SELECT COUNT(*) n FROM traceroute_history WHERE ts > ?`).get(now - 3600).n;
  let loopState = 'fault', loopBasis;
  if (since == null) {
    loopBasis = 'no attempt has ever been recorded';
  } else if (since <= interval * 3) {
    loopState = 'ok';   loopBasis = `last attempt ${since}s ago, ${perHour}/hour`;
  } else if (since <= interval * 20) {
    loopState = 'warn'; loopBasis = `last attempt ${Math.round(since / 60)} min ago, expected every ${interval}s`;
  } else {
    loopBasis = `nothing sent for ${Math.round(since / 3600)}h — expected every ${interval}s`;
  }

  // ── YIELD ─────────────────────────────────────────────────────────────────
  // Against the PREVIOUS window of equal length. A rate alone cannot show
  // degradation; only a comparison can, and degradation is what went unseen for
  // three weeks.
  const rate = (a, b) => {
    const r = db.prepare(
      `SELECT COUNT(*) att, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) ok
         FROM traceroute_history WHERE ts > ? AND ts <= ?`).get(a, b);
    return { att: r.att, ok: r.ok || 0, pct: r.att ? (100 * (r.ok || 0)) / r.att : null };
  };
  const cur = rate(from, now), prev = rate(prevFrom, from);
  let yState = 'ok', yBasis;
  if (!cur.att) {
    yState = 'fault'; yBasis = 'no attempts in this window';
  } else if (cur.ok === 0 && cur.att >= 20) {
    yState = 'fault'; yBasis = `0 of ${cur.att} answered`;
  } else if (prev.pct != null && prev.pct > 0) {
    const ratio = cur.pct / prev.pct;
    yState = ratio >= 0.8 ? 'ok' : ratio >= 0.5 ? 'warn' : 'fault';
    yBasis = `${cur.pct.toFixed(0)}% of ${cur.att}, previous period ${prev.pct.toFixed(0)}%`;
  } else {
    yBasis = `${cur.pct.toFixed(0)}% of ${cur.att} answered`;
  }

  // ── FRONTIER ──────────────────────────────────────────────────────────────
  const best = (a, b) => db.prepare(`
    SELECT MAX(${KM}) km FROM traceroute_history t JOIN nodes n ON n.num = t.to_num
     WHERE t.status='ok' AND n.lat IS NOT NULL AND n.lat <> 0 AND t.ts > @a AND t.ts <= @b`)
    .get({ a, b, hlat: home?.lat ?? 0, hlon: home?.lon ?? 0 })?.km ?? null;
  const curKm = best(from, now), prevKm = best(prevFrom, from);
  const rec = db.prepare(`
    SELECT MAX(${KM}) km, MAX(t.ts) ts FROM traceroute_history t JOIN nodes n ON n.num = t.to_num
     WHERE t.status='ok' AND n.lat IS NOT NULL AND n.lat <> 0`)
    .get({ hlat: home?.lat ?? 0, hlon: home?.lon ?? 0 });
  const recordKm = rec?.km != null ? Math.round(rec.km * 10) / 10 : null;
  // Days since the ALL-TIME record was last improved — the honest "are we
  // progressing" number, and the one the board has been hiding behind.
  const recAt = recordKm == null ? null : db.prepare(`
    SELECT MIN(t.ts) ts FROM traceroute_history t JOIN nodes n ON n.num = t.to_num
     WHERE t.status='ok' AND n.lat IS NOT NULL AND ${KM} >= @rk`)
    .get({ hlat: home?.lat ?? 0, hlon: home?.lon ?? 0, rk: recordKm - 0.05 })?.ts ?? null;
  const flatDays = recAt ? Math.floor((now - recAt) / 86400) : null;
  // THE VERDICT ONLY. Each of these used to open with `curKm`, which the card
  // prints directly above as its value — so every frontier card said its own
  // number twice and had less room for the thing that was actually missing.
  let fState = 'warn', fBasis;
  if (curKm == null) {
    fState = 'fault'; fBasis = 'nothing answered in this window';
  } else if (prevKm != null && curKm > prevKm) {
    fState = 'ok';    fBasis = `up from ${prevKm.toFixed(1)} km last period`;
  } else if (flatDays != null && flatDays > 7) {
    fState = 'fault'; fBasis = `record ${recordKm} km unbeaten ${flatDays} days`;
  } else {
    fBasis = prevKm != null ? `previous period ${prevKm.toFixed(1)} km` : 'no previous period to compare';
  }

  // ── SPARKLINES ────────────────────────────────────────────────────────────
  // Per day over the window. A day with too few attempts returns null and BREAKS
  // the line — the rule already proven in rateByBandByDay. A gap reads as "not
  // known"; a zero reads as "nothing happened", and they are different claims.
  const daily = db.prepare(`
    SELECT date(t.ts,'unixepoch') day, COUNT(*) att,
           SUM(CASE WHEN t.status='ok' THEN 1 ELSE 0 END) ok,
           MAX(CASE WHEN t.status='ok' THEN ${KM} END) km
      FROM traceroute_history t LEFT JOIN nodes n ON n.num = t.to_num
     WHERE t.ts > @from GROUP BY day ORDER BY day`)
    .all({ from, hlat: home?.lat ?? 0, hlon: home?.lon ?? 0 });
  const MIN_ATT = 15;

  // THE PLACE NAME, NOT THE POSTAL ADDRESS. Nominatim returns
  // "Clos des Mielles, Castel, GY5 7FX, Guernsey" and a stat card has room for
  // one word of it. The second field is the settlement; the first is the street,
  // which locates nothing at 176 km. Falls back to the first field when there
  // is only one.
  const locality = (addr) => {
    if (!addr) return null;
    const parts = String(addr).split(',').map(s => s.trim()).filter(Boolean);
    return parts[1] || parts[0] || null;
  };

  // ── LAST HIT ──────────────────────────────────────────────────────────────
  // Peter, 2026-08-03: "why is there no last hit card at the top with the other
  // cards, giving the location, bearing, km and age?"
  //
  // There was no reason. LOOP says whether we are trying, YIELD whether we are
  // answered, FRONTIER how far this period — and none of them says WHAT WE
  // ACTUALLY REACHED. It is the most concrete fact the system produces, and
  // answering "was that a hit?" meant a hand query against traceroute_history.
  //
  // Distance and bearing are computed HERE, not in the browser, along with a
  // finished basis string — the browser makes no decisions (BROWSER_CONTRACT).
  const lh = db.prepare(`
    SELECT t.ts, t.to_num, t.rtt_ms, n.long_name, n.lat, n.lon, g.address
      FROM traceroute_history t
      LEFT JOIN nodes n         ON n.num = t.to_num
      LEFT JOIN geocode_cache g ON g.num = t.to_num
     WHERE t.status = 'ok'
     ORDER BY t.ts DESC LIMIT 1`).get();

  let lastHit;
  if (!lh) {
    lastHit = { state: 'fault', name: null, km: null, bearing: null, age_sec: null,
                place: null, basis: 'nothing has ever answered' };
  } else {
    const age    = now - Number(lh.ts);
    const placed = lh.lat != null && lh.lat !== 0 && lh.lon != null;
    // A HIT WE CANNOT PLACE IS STILL A HIT. km and bearing stay NULL rather
    // than 0 — the target answered, we simply cannot say how far. Rendering a
    // zero here would claim a measurement we never made. Recurring, not
    // hypothetical: the only mission answer of 2026-08-03 was Pokey Hollow, a
    // HELTEC_V3 with no GPS that has never sent a position.
    const km  = placed ? Math.round(haversine(home?.lat, home?.lon, lh.lat, lh.lon) * 10) / 10 : null;
    const brg = placed ? Math.round(bearingDeg(home?.lat, home?.lon, lh.lat, lh.lon)) : null;
    const name = lh.long_name || `!${Number(lh.to_num).toString(16)}`;
    const when = age < 90 ? `${age}s ago`
               : age < 5400 ? `${Math.round(age / 60)} min ago`
               : age < 172800 ? `${Math.round(age / 3600)}h ago`
               : `${Math.round(age / 86400)}d ago`;
    // Freshness is judged against the same cadence the loop uses, so the two
    // cards cannot disagree about what "recent" means.
    const state = age <= interval * 20 ? 'ok' : age <= 86400 ? 'warn' : 'fault';
    // TWO LINES, ONE JOB EACH. `where` locates it, `basis` times it. Packing
    // both into one string produced a 110-character run that overflowed the
    // card and repeated the value already printed above it.
    lastHit = {
      state, name, km, bearing: brg, age_sec: age,
      place: lh.address || null,
      rtt_ms: lh.rtt_ms == null ? null : Number(lh.rtt_ms),
      where: `${name}${placed ? ` · ${brg}°` : ''}`
        + (locality(lh.address) ? ` · ${locality(lh.address)}` : ''),
      basis: placed ? when : `${when} · position unknown, distance unmeasurable`,
    };
  }

  // ── WHERE THE FRONTIER ACTUALLY IS ────────────────────────────────────────
  // Peter, 2026-08-03: "we need a last hit and a last frontier hit — or maybe
  // the frontier card already there needs the location?"
  //
  // The second reading is the right one, and the data settles it: the furthest
  // answered target IS the number the frontier card already shows. A separate
  // card would print 176.2 km twice and add a fifth column for nothing.
  //
  // So this does not become a card. It gives the existing frontier card the
  // three facts it was missing — WHO, WHICH WAY, and WHEN — because "176.2 km"
  // alone cannot be acted on: you cannot re-point an antenna at a scalar.
  //
  // LAST HIT stays separate and is genuinely a different question: on this day
  // the last hit was 67.5 km 24 minutes earlier while the frontier had not
  // moved in 29 days. A board showing only one of those reads as healthy while
  // the actual goal is static.
  const fh = db.prepare(`
    SELECT t.ts, t.to_num, n.long_name, n.lat, n.lon, g.address, ${KM} AS km
      FROM traceroute_history t
      JOIN nodes n              ON n.num = t.to_num
      LEFT JOIN geocode_cache g ON g.num = t.to_num
     WHERE t.status = 'ok' AND t.ts > @from
       AND n.lat IS NOT NULL AND n.lat <> 0
     ORDER BY km DESC, t.ts DESC LIMIT 1`)
    .get({ from, hlat: home?.lat ?? 0, hlon: home?.lon ?? 0 });

  let frontierHit;
  if (!fh) {
    frontierHit = { state: 'fault', name: null, km: null, bearing: null, age_sec: null,
                    place: null, basis: 'nothing answered in this window' };
  } else {
    const age = now - Number(fh.ts);
    const km  = Math.round(Number(fh.km) * 10) / 10;
    const brg = Math.round(bearingDeg(home?.lat, home?.lon, fh.lat, fh.lon));
    const name = fh.long_name || `!${Number(fh.to_num).toString(16)}`;
    const when = age < 5400 ? `${Math.round(age / 60)} min ago`
               : age < 172800 ? `${Math.round(age / 3600)}h ago`
               : `${Math.round(age / 86400)}d ago`;
    // Judged on AGE, not distance: a frontier reached once and never revisited
    // is the stagnation the board exists to expose.
    const state = age <= 86400 ? 'ok' : age <= 7 * 86400 ? 'warn' : 'fault';
    frontierHit = {
      state, name, km, bearing: brg, age_sec: age, place: fh.address || null,
      basis: `${name} · ${when} · ${brg}°`
        + (fh.address ? ` · ${(String(fh.address).split(',')[1] || String(fh.address).split(',')[0] || '').trim()}` : ''),
    };
  }

  // The frontier card states WHERE it got to, not just how far. Appended rather
  // than replacing fBasis, so the verdict (rising / flat / stalled) still leads
  // and the location qualifies it.
  const fWhere = frontierHit.name
    ? `${frontierHit.name} · ${frontierHit.bearing}°`
      + (locality(frontierHit.place) ? ` · ${locality(frontierHit.place)}` : '')
    : null;

  return {
    window_days: Number(days) || 0,
    // Hits per day, so the card carries a sparkline in the same grammar as its
    // neighbours without a second query.
    last_hit: { ...lastHit, series: daily.map(d => ({ day: d.day, v: d.ok })) },

    loop:     { state: loopState, since_sec: since, per_hour: perHour, basis: loopBasis,
                series: daily.map(d => ({ day: d.day, v: d.att })) },
    yield:    { state: yState, rate: cur.pct == null ? null : Math.round(cur.pct),
                prev_rate: prev.pct == null ? null : Math.round(prev.pct), basis: yBasis,
                series: daily.map(d => ({ day: d.day, v: d.att >= MIN_ATT ? Math.round(100 * d.ok / d.att) : null })) },
    frontier: { state: fState, window_km: curKm == null ? null : Math.round(curKm * 10) / 10,
                record_km: recordKm, flat_days: flatDays,
                // `where` is the location line; `basis` stays the verdict. The
                // card prints the km itself, so neither line repeats it.
                where: fWhere,
                basis: fBasis,
                // The reached target, published as fields too so the panel can
                // link or re-aim at it rather than re-parse the sentence.
                at_name: frontierHit.name, at_bearing: frontierHit.bearing,
                at_place: frontierHit.place, at_age_sec: frontierHit.age_sec,
                series: daily.map(d => ({ day: d.day, v: d.km == null ? null : Math.round(d.km * 10) / 10 })) },
  };
}

export function lastHeardMap() {
  const m = new Map();
  for (const r of db.prepare(`SELECT num, last_heard FROM nodes WHERE last_heard IS NOT NULL`).all()) {
    m.set(r.num, r.last_heard);
  }
  return m;
}

// ─── CHART SERIES ───────────────────────────────────────────────────────────
//
// Display aggregation, deliberately NOT inferences: the catalogue's rule is
// "small, and one thing", and a chart series is something the system draws
// rather than something it works out. See docs/OBSERVATORY_CHARTS.md.

/** Attempts and answers per day. The 27 July cliff — ~1,000/day to 1, because
 *  traceroute.enabled was false — took a database query to find and should have
 *  taken one glance. */
// ANALYSIS WINDOW. `days = 0` means ALL TIME and must omit the predicate entirely:
// a naive `ts > now - 0` matches nothing and would render an empty page as though
// there were no data. Task `observatory-window`.
function _windowSql(days, col = 'ts') {
  return Number(days) > 0
    ? `AND ${col} > strftime('%s','now') - (${Number(days)} * 86400)`
    : '';
}

// CENSORED DATA. `perf.failure_epoch` records when traceroute FAILURES began being
// stored; before it only successes were written (617 rows, all 'ok'). Any rate
// computed across that boundary reads 100% and is a lie. Task
// `rate-series-honest-epoch`.
//
// A MISSING epoch means "nothing known to be censored" and must change nothing —
// `ts >= null` would drop every row and render an empty page.
function _failureEpoch() {
  const v = getConfig('perf.failure_epoch', null);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function _epochSql(col = 'ts') {
  const e = _failureEpoch();
  return e ? `AND ${col} >= ${e}` : '';
}

export function attemptsByDay(days = 30) {
  return db.prepare(`
    SELECT date(ts, 'unixepoch')                            AS day,
           COUNT(*)                                         AS attempts,
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)   AS answers
    FROM traceroute_history
    WHERE 1=1 ${_windowSql(days, 'ts')}
    GROUP BY day ORDER BY day
  `).all();
}

/** Answer rate against how long the target had been silent. The strongest
 *  predictor measured (26.1 / 16.0 / 7.0 / 1.8 %) and the justification for
 *  max_silence_days — on screen so the setting can be argued with. */
export function answerRateBySilence(days = 0) {
  return db.prepare(`
    WITH heard AS (SELECT DISTINCT num FROM signal_history)
    SELECT CASE
             WHEN h.num IS NOT NULL                                        THEN 'direct RF'
             WHEN n.last_heard > strftime('%s','now') - 86400              THEN '< 24h'
             WHEN n.last_heard > strftime('%s','now') - 604800             THEN '< 7d'
             ELSE 'silent 7d+'
           END                                              AS bucket,
           COUNT(*)                                         AS attempts,
           SUM(CASE WHEN th.status = 'ok' THEN 1 ELSE 0 END) AS answers
    FROM traceroute_history th
    LEFT JOIN nodes n ON n.num = th.to_num
    LEFT JOIN heard h ON h.num = th.to_num
    WHERE 1=1 ${_windowSql(days, 'th.ts')} ${_epochSql('th.ts')}
    GROUP BY bucket
  `).all();
}

/** Answer rate by 25 km band. The chart that settles whether a run of silence is
 *  the targets or the setup. Distance is computed in SQL from the stored
 *  positions and the configured home. */
export function answerRateByDistance(days = 0) {
  return db.prepare(`
    WITH home AS (
      SELECT (SELECT CAST(value AS REAL) FROM config WHERE key='home.lat') AS lat,
             (SELECT CAST(value AS REAL) FROM config WHERE key='home.lon') AS lon
    ),
    d AS (
      SELECT th.status,
             6371.0 * 2 * asin(min(1.0, sqrt(
               power(sin((n.lat - home.lat) * 0.0174532925 / 2), 2) +
               cos(home.lat * 0.0174532925) * cos(n.lat * 0.0174532925) *
               power(sin((n.lon - home.lon) * 0.0174532925 / 2), 2)
             ))) AS km
      FROM traceroute_history th
      JOIN nodes n ON n.num = th.to_num
      CROSS JOIN home
      WHERE n.lat IS NOT NULL AND n.lat <> 0 AND home.lat IS NOT NULL
        ${_windowSql(days, 'th.ts')} ${_epochSql('th.ts')}
    )
    SELECT CAST(km / 25 AS INTEGER) * 25                    AS band,
           COUNT(*)                                         AS attempts,
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)   AS answers
    FROM d WHERE km <= 250
    GROUP BY band ORDER BY band
  `).all();
}

/** Answer rate per day SPLIT BY DISTANCE BAND. Task `rate-by-band-by-day`.
 *
 *  The aggregate daily series cannot separate a change in TARGET MIX from a
 *  change in PERFORMANCE, and that ambiguity hid a three-week collapse: the
 *  answer rate to nodes within 25 km fell from ~58% (early July) to ~7% (late
 *  July), while the 100+ km band sat at 0-4% throughout and never moved. Close
 *  targets cannot be explained by mix, so that is the rig degrading — and it
 *  reorders the project, because pursuing 200 km while 20 km is broken is the
 *  wrong problem.
 *
 *  LEFT JOIN, not the INNER JOIN answerRateByDistance() uses: position-less
 *  targets are a THIRD of today's attempts and answer at 15-21%. Dropping them
 *  would hide where a third of the airtime goes. They get their own bucket
 *  because they have no distance — never folded into a band.
 *
 *  `rate` is NULL below MIN_ATTEMPTS. 2026-08-02 shows 24% on n=21 and that is
 *  noise; a page drawing it as a recovery would mislead. The threshold lives
 *  here and not in the chart because BROWSER_CONTRACT gives the browser zero
 *  decisions — it renders a gap where rate is null and never qualifies a number
 *  itself. attempts/answers are always returned so the gap is still auditable.
 */
const BAND_MIN_ATTEMPTS = 15;

export function rateByBandByDay(days = 30) {
  const rows = db.prepare(`
    WITH home AS (
      SELECT (SELECT CAST(value AS REAL) FROM config WHERE key='home.lat') AS lat,
             (SELECT CAST(value AS REAL) FROM config WHERE key='home.lon') AS lon
    ),
    d AS (
      SELECT date(th.ts, 'unixepoch') AS day,
             th.status                AS status,
             CASE WHEN n.lat IS NULL OR n.lat = 0 THEN NULL ELSE
               6371.0 * 2 * asin(min(1.0, sqrt(
                 power(sin((n.lat - home.lat) * 0.0174532925 / 2), 2) +
                 cos(home.lat * 0.0174532925) * cos(n.lat * 0.0174532925) *
                 power(sin((n.lon - home.lon) * 0.0174532925 / 2), 2)
               )))
             END AS km
      FROM traceroute_history th
      LEFT JOIN nodes n ON n.num = th.to_num
      CROSS JOIN home
      WHERE 1=1 ${_windowSql(days, 'th.ts')}
    )
    SELECT day,
           CASE WHEN km IS NULL  THEN 'no-pos'
                WHEN km <  25    THEN '<25'
                WHEN km < 100    THEN '25-100'
                ELSE                  '100+'
           END                                              AS band,
           COUNT(*)                                         AS attempts,
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)   AS answers
    FROM d
    GROUP BY day, band
    ORDER BY day, band
  `).all();
  // A day is CENSORED if any part of it precedes perf.failure_epoch: before that
  // moment only successes were stored, so the day computes as 100%. 2026-07-03
  // straddles the boundary and is treated as censored — a partly-censored day
  // cannot honestly be presented as a rate.
  //
  // The rate is NULLED rather than the row dropped, so `attempts` and `answers`
  // stay visible and a reader can see WHY the rate is absent instead of finding a
  // silent hole. The chart already breaks its line on a null rate.
  const epoch = _failureEpoch();
  const censoredBefore = epoch
    ? new Date(epoch * 1000).toISOString().slice(0, 10)
    : null;
  return rows.map(r => ({
    ...r,
    censored: censoredBefore ? r.day <= censoredBefore : false,
    rate: (censoredBefore && r.day <= censoredBefore) || r.attempts < BAND_MIN_ATTEMPTS
      ? null
      : Math.round((100 * r.answers) / r.attempts),
  }));
}

/** Furthest target ANSWERED inside the window. Task `observatory-window`.
 *
 *  NOT the record. `reach.ladder`'s record_km is all-time and stays that way —
 *  it is the thing to beat (189.1 km, 2026-07-04), and windowed to 7 days it
 *  would read ~92 km and imply we had gone backwards. This is the other
 *  question, and Peter asked for it directly: "we have a farthest target in for
 *  example the last 7 days". Both belong on screen, labelled; serving only the
 *  all-time figure is how the ladder came to imply we were still reaching
 *  189.1 km while the last twelve hours topped out at 92.
 *
 *  Returns null when nothing was answered in the window — an honest empty, not a
 *  zero, because 0 km would draw as a data point.
 */
export function windowBestKm(days = 0) {
  const row = db.prepare(`
    WITH home AS (
      SELECT (SELECT CAST(value AS REAL) FROM config WHERE key='home.lat') AS lat,
             (SELECT CAST(value AS REAL) FROM config WHERE key='home.lon') AS lon
    )
    SELECT MAX(
             6371.0 * 2 * asin(min(1.0, sqrt(
               power(sin((n.lat - home.lat) * 0.0174532925 / 2), 2) +
               cos(home.lat * 0.0174532925) * cos(n.lat * 0.0174532925) *
               power(sin((n.lon - home.lon) * 0.0174532925 / 2), 2)
             )))
           ) AS km,
           COUNT(*) AS answered
    FROM traceroute_history th
    JOIN nodes n ON n.num = th.to_num
    CROSS JOIN home
    WHERE th.status = 'ok'
      AND n.lat IS NOT NULL AND n.lat <> 0 AND home.lat IS NOT NULL
      ${_windowSql(days, 'th.ts')}
  `).get();
  return {
    km:       row?.km != null ? Math.round(row.km * 10) / 10 : null,
    answered: row?.answered ?? 0,
  };
}

export function recentAimedTraceroutes(limit = 25) {
  return db.prepare(`
    SELECT ts, to_num, rotator_az, status
    FROM traceroute_history
    WHERE tx_device IS NOT NULL AND rotator_az IS NOT NULL
    ORDER BY ts DESC LIMIT ?
  `).all(limit);
}

export function insertRangeTestEntry(entry) {
  stmts.insertRangeTest.run(entry);
}

export function queryRangeTestLog(limit = 500) {
  return stmts.queryRangeTest.all(limit);
}

export function clearRangeTestLog() {
  stmts.clearRangeTest.run();
}

export function clearNodeCache() {
  stmts.clearNodes.run();
}

export function recordYagiTargeted(num) {
  stmts.recordYagiTargeted.run(num);
}

export function recordYagiContact(num, rssi, snr) {
  stmts.recordYagiContact.run({ num, rssi: rssi ?? null, snr: snr ?? null });
}

export function insertTilt(entry) {
  stmts.insertTilt.run(entry);
}

export function insertDeviceMetricsHistory(entry) {
  stmts.insertDeviceMetricsHistory.run(_finAll(entry,
    ['uptime_seconds', 'voltage', 'battery_level', 'channel_utilization', 'air_util_tx']));
}

// NaN reaches SQLite as the TEXT string 'NaN' in a REAL column — silent type
// pollution that reads as a present value. Sanitising in these wrappers rather
// than at each call site protects EVERY caller, including the bridge-events
// replay writer which bypassed the per-site guards.
const _fin = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
const _finAll = (entry, keys) => {
  const out = { ...entry };
  for (const k of keys) out[k] = _fin(out[k]);
  return out;
};

/** Mark a node as a discovery target, or clear it. Mirrors setNodeFavourite —
 *  a different flag with a different meaning, never the same one. */
export function setObsTarget(num, on) {
  const changed = db.prepare(`UPDATE nodeinfo SET obs_target = ? WHERE num = ?`)
    .run(on ? 1 : 0, num).changes;
  if (changed || !on) return changed;

  // NO nodeinfo ROW YET — CREATE ONE RATHER THAN REFUSE.
  //
  // 249 of 932 known nodes have never sent a NODEINFO packet, so they have no
  // nodeinfo row, and among them is the 189.1 km RECORD HOLDER. Refusing to
  // target the very node we are trying to beat is absurd: we can traceroute it,
  // we have a position for it, we simply do not know its name.
  //
  // node_id is the primary key, so it must be synthesised — Meshtastic's own
  // convention, '!' plus the num in lowercase hex, which is exactly what the
  // node would send for itself. If it ever does send identity, the upsert keyed
  // on that same node_id fills in the names over this row rather than
  // duplicating it.
  const nodeId = '!' + (num >>> 0).toString(16).padStart(8, '0');
  db.prepare(`INSERT OR IGNORE INTO nodeinfo (node_id, num) VALUES (?, ?)`).run(nodeId, num);
  return db.prepare(`UPDATE nodeinfo SET obs_target = ? WHERE num = ?`)
    .run(1, num).changes;
}

/** Every node currently marked as a discovery target. */
export function listObsTargets() {
  return db.prepare(`SELECT num, short_name, long_name FROM nodeinfo
                     WHERE obs_target = 1 AND num IS NOT NULL`).all();
}

export function setNodeFavourite(num, favourite) {
  return stmts.setFavourite.run({ num, favourite: favourite ? 1 : 0 }).changes;
}

export function listFavourites() {
  return stmts.queryFavourites.all();
}

export function listFavouriteNodes() {
  return stmts.queryFavouriteNodes.all();
}

// Task `packet-provenance-capture`. No dedup on purpose: two radios hearing one
// packet is two observations of two different links, and both are wanted — the
// same reasoning that made signal_history key on (num, packet_id, rx_device).
const _insertRelayObservation = db.prepare(`
  INSERT INTO relay_observation
    (ts, from_num, relay_byte, rx_device, hop_start, hop_limit, transport, decoded)
  VALUES
    (@ts, @from_num, @relay_byte, @rx_device, @hop_start, @hop_limit, @transport, @decoded)
`);
const _pruneRelayObservations = db.prepare(`DELETE FROM relay_observation WHERE ts < ?`);

const _insertEventLog = db.prepare(`
  INSERT INTO event_log (ts, kind, severity, summary, detail, source, probe_id)
  VALUES (@ts, @kind, @severity, @summary, @detail, @source, @probe_id)
`);
const _pruneEventLog = db.prepare(`DELETE FROM event_log WHERE ts < ?`);

export function insertEventLog(entry) {
  _insertEventLog.run({ severity: 'info', detail: null, source: null, probe_id: null, ...entry });
}

/** Newest first. The log page and the probe traces both read this. */
export function recentEventLog(limit = 200) {
  return db.prepare('SELECT * FROM event_log ORDER BY ts DESC, id DESC LIMIT ?').all(limit);
}

/** One probe's steps, oldest first — a trace reads forwards. */
export function probeTrace(probeId) {
  return db.prepare('SELECT * FROM event_log WHERE probe_id = ? ORDER BY id').all(probeId);
}

/** Interventions only, for marking the board's sparklines. */
export function interventions(days = 30) {
  return db.prepare(`
    SELECT ts, kind, summary FROM event_log
     WHERE kind IN ('config','deploy','mode') ${_windowSql(days, 'ts')}
     ORDER BY ts`).all();
}

export function pruneEventLog(days) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  return _pruneEventLog.run(cutoff).changes;
}

export function insertRelayObservation(entry) {
  _insertRelayObservation.run(entry);
}

// Age off by RETAIN_DAYS. Returns rows deleted so the caller can log honestly.
export function pruneRelayObservations(days) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  return _pruneRelayObservations.run(cutoff).changes;
}

export function insertSignalHistory(entry) {
  stmts.insertSignalHistory.run(_finAll({ packet_id: null, rssi: null, snr: null, hops: null, rx_device: null, ...entry }, ['rssi', 'snr']));
}

export function insertDetectionEvent(entry) {
  stmts.insertDetectionEvent.run(entry);
}

// packet_id defaults to null so callers that have no packet id (the
// bridge-events nodedb-replay writer) keep working unchanged — better-sqlite3
// throws on a missing named parameter. A null id is never deduped.
export function insertEnvHistory(entry) {
  stmts.insertEnvHistory.run(_finAll({ packet_id: null, gas_resistance: null, ...entry },
    ['temperature', 'relative_humidity', 'barometric_pressure', 'gas_resistance']));
}

export function queryEnvHistory(num, sinceTs) {
  return stmts.queryEnvHistory.all(num, sinceTs);
}

export function queryTiltHistory(nodeId, sinceTs) {
  return stmts.queryTilt.all(nodeId, sinceTs);
}

export function queryAllTiltHistory(sinceTs) {
  return stmts.queryAllTilt.all(sinceTs);
}

export function queryAllEnvHistory(sinceTs) {
  return stmts.queryAllEnvHistory.all(sinceTs);
}

export function markTiltNcal(nodeId, tsFrom, tsTo) {
  return stmts.markNcal.run(nodeId, tsFrom, tsTo).changes;
}

export function getCachedGeocode(num) {
  return stmts.getGeocode.get(num)?.address ?? null;
}

export function setCachedGeocode(num, address) {
  stmts.setGeocode.run(num, address);
}

/** Positioned nodes still lacking an address. */
export function geocodeBacklog(limit = 5000) {
  return stmts.geocodeTodo.all(limit).map(r => r.num);
}

const _getNodeinfo = db.prepare(`SELECT * FROM nodeinfo WHERE num = ? LIMIT 1`);
export function getMqttNode(num) {
  return _getNodeinfo.get(num) ?? null;
}

export function getConfigByPrefix(prefix) {
  const rows = db.prepare(`SELECT key, value FROM config WHERE key LIKE ?`).all(prefix + '%');
  const result = {};
  for (const { key, value } of rows) {
    result[key.slice(prefix.length)] = JSON.parse(value);
  }
  return result;
}

export function persistNodeMac(nodeId, mac) {
  setConfig('node_mac.' + mac, nodeId);
}

export function loadNodeMacMap() {
  // Returns Map<MAC, nodeId>. Filter to MAC-format keys (contain ':') to skip
  // any stale !hexid-keyed entries written by a prior scheme.
  return new Map(
    Object.entries(getConfigByPrefix('node_mac.')).filter(([k]) => k.includes(':'))
  );
}

const _migrateNodeDevice = db.prepare(`UPDATE nodes SET device = @mac WHERE device = @nodeId`);

const _migrateTxDevice   = db.prepare(`UPDATE traceroute_history SET tx_device = @mac WHERE tx_device = @nodeId`);
const _migrateMsgDevice  = db.prepare(`UPDATE messages SET device = @mac WHERE device = @nodeId`);
const _migrateRxDevices  = db.prepare(`UPDATE messages SET rx_devices = REPLACE(rx_devices, @nodeId, @mac) WHERE rx_devices LIKE '%' || @nodeId || '%'`);

// Identity Phase B: rewrite legacy !hex device ids to MACs in the device-
// attribution columns. Unmappable ids stay as-is (IDENTITY.md §7 amnesty).
export function migrateDeviceColumnsToMac(pairs) {
  let changed = 0;
  for (const { nodeId, mac } of pairs) {
    if (!nodeId || !mac) continue;
    changed += _migrateTxDevice.run({ nodeId, mac }).changes;
    changed += _migrateMsgDevice.run({ nodeId, mac }).changes;
    changed += _migrateRxDevices.run({ nodeId, mac }).changes;
  }
  return changed;
}

// Rewrite legacy nodes.device values stored as node_id (!hex) to the device's
// BLE MAC. nodes.device feeds restoreDeviceAttribution and must use the same
// MAC vocabulary the node_source filter compares against. Returns rows changed.
export function migrateNodeDeviceMac(pairs) {
  let changed = 0;
  for (const { nodeId, mac } of pairs) {
    if (!nodeId || !mac) continue;
    changed += _migrateNodeDevice.run({ nodeId, mac }).changes;
  }
  return changed;
}

// -- Alert rules --------------------------------------------------------------

const _getAllAlertRules  = db.prepare(`SELECT * FROM alert_rules ORDER BY type`);
const _getAlertRule      = db.prepare(`SELECT * FROM alert_rules WHERE type = ?`);
const _updateAlertRule   = db.prepare(`
  UPDATE alert_rules SET enabled = @enabled, threshold = @threshold, cooldown_minutes = @cooldown_minutes
  WHERE type = @type
`);
const _touchAlertSent    = db.prepare(`UPDATE alert_rules SET last_sent = @ts WHERE type = @type`);

export function getAlertRules()    { return _getAllAlertRules.all(); }
export function getAlertRule(type) { return _getAlertRule.get(type) ?? null; }
export function updateAlertRule({ type, enabled, threshold, cooldown_minutes }) {
  const existing = _getAlertRule.get(type);
  if (!existing) return 0;
  return _updateAlertRule.run({
    type,
    enabled:          enabled          !== undefined ? (enabled ? 1 : 0)   : existing.enabled,
    threshold:        threshold        !== undefined ? threshold             : existing.threshold,
    cooldown_minutes: cooldown_minutes !== undefined ? cooldown_minutes      : existing.cooldown_minutes,
  }).changes;
}
export function touchAlertLastSent(type, ts = Math.floor(Date.now() / 1000)) {
  _touchAlertSent.run({ type, ts });
}

// -- Reply tokens -------------------------------------------------------------

const _insertReplyToken  = db.prepare(`
  INSERT INTO reply_tokens (token, from_node_id, to_num, reply_id, channel, created_at, expires_at)
  VALUES (@token, @from_node_id, @to_num, @reply_id, @channel, @created_at, @expires_at)
`);
const _getReplyToken     = db.prepare(`SELECT * FROM reply_tokens WHERE token = ? AND expires_at > ?`);
const _deleteReplyToken  = db.prepare(`DELETE FROM reply_tokens WHERE token = ?`);
const _pruneReplyTokens  = db.prepare(`DELETE FROM reply_tokens WHERE expires_at < ?`);

export function createReplyToken(token, fromNodeId, toNum, replyId, channel = 0, ttlSeconds = 86400) {
  const now = Math.floor(Date.now() / 1000);
  _insertReplyToken.run({ token, from_node_id: fromNodeId, to_num: toNum, reply_id: replyId ?? null, channel, created_at: now, expires_at: now + ttlSeconds });
}
export function getReplyToken(token) {
  return _getReplyToken.get(token, Math.floor(Date.now() / 1000)) ?? null;
}
export function consumeReplyToken(token) {
  const row = getReplyToken(token);
  if (row) _deleteReplyToken.run(token);
  return row;
}
export function pruneExpiredTokens() {
  _pruneReplyTokens.run(Math.floor(Date.now() / 1000));
}

// -- Packet alert deduplication -----------------------------------------------
// Records that an alert has been sent for a given packet_id so the same packet
// never triggers a second email even if the bridge echoes the event again.
const _markAlerted = db.prepare(
  `UPDATE messages SET alerted_at = ? WHERE packet_id = ? AND alerted_at IS NULL`
);
const _isAlerted = db.prepare(
  `SELECT 1 FROM messages WHERE packet_id = ? AND alerted_at IS NOT NULL LIMIT 1`
);

const _alertedPacketIds = new Set();
const _ALERTED_CAP = 2000;

export function markPacketAlerted(packetId) {
  if (packetId == null) return;
  _alertedPacketIds.add(packetId);
  if (_alertedPacketIds.size > _ALERTED_CAP) {
    _alertedPacketIds.delete(_alertedPacketIds.values().next().value);
  }
  _markAlerted.run(Math.floor(Date.now() / 1000), packetId);
}

export function isPacketAlerted(packetId) {
  if (packetId == null) return false;
  if (_alertedPacketIds.has(packetId)) return true;
  return !!_isAlerted.get(packetId);
}

// Write alerted_at on the row if it was already marked in-session (i.e. the alert
// fired before the message row was inserted). No-op if not in the session Set.
export function syncAlertedAt(packetId) {
  if (packetId == null) return;
  if (!_alertedPacketIds.has(packetId)) return;
  _markAlerted.run(Math.floor(Date.now() / 1000), packetId);
}

// -- Tilt calibration ---------------------------------------------------------

export function getTiltCal() {
  return {
    zero:        getConfig('tilt.zero', null),
    north_angle: getConfig('tilt.north_angle', null),
  };
}

export function saveTiltCal({ zero, north_angle }) {
  if (zero !== undefined)        setConfig('tilt.zero', zero);
  if (north_angle !== undefined) setConfig('tilt.north_angle', north_angle);
}

export default db;
