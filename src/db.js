import Database from 'better-sqlite3';
import path from 'path';

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
    hops      INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_sig_dedup  ON signal_history(num, packet_id) WHERE packet_id IS NOT NULL;
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
// Migrations for columns added after initial schema
{
  const thCols = db.prepare(`PRAGMA table_info(traceroute_history)`).all().map(r => r.name);
  if (!thCols.includes('tx_device'))  db.exec(`ALTER TABLE traceroute_history ADD COLUMN tx_device TEXT`);
  if (!thCols.includes('rotator_az')) db.exec(`ALTER TABLE traceroute_history ADD COLUMN rotator_az REAL`);
  if (!thCols.includes('status'))     db.exec(`ALTER TABLE traceroute_history ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'`);
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
// Favourites live on nodeinfo (persistent), NOT nodes (wiped by clearNodeCache).
{
  const niCols = db.prepare(`PRAGMA table_info(nodeinfo)`).all().map(r => r.name);
  if (!niCols.includes('favourite')) {
    db.exec(`ALTER TABLE nodeinfo ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0`);
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
    SELECT num, node_id, short_name, long_name, hw_model, role, lat, lon, alt, hops_away
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
      (ts, from_num, to_num, rx_device, route, route_back, snr_towards, snr_back, relay_positions, tx_device, rotator_az, status)
    VALUES
      (@ts, @from_num, @to_num, @rx_device, @route, @route_back, @snr_towards, @snr_back, @relay_positions, @tx_device, @rotator_az, @status)
  `),

  // Failed dispatch attempts (timeout / send error) — payload columns stay NULL.
  // Without these rows every stat is survivorship-biased.
  insertTracerouteFailure: db.prepare(`
    INSERT INTO traceroute_history (ts, from_num, to_num, tx_device, rotator_az, status)
    VALUES (@ts, @from_num, @to_num, @tx_device, @rotator_az, @status)
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

  getGeocode:  db.prepare(`SELECT address FROM nodeinfo WHERE num = ? AND address IS NOT NULL LIMIT 1`),
  setGeocode:  db.prepare(`UPDATE nodeinfo SET address = ? WHERE num = ?`),

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
    INSERT OR IGNORE INTO signal_history (ts, num, packet_id, rssi, snr, hops)
    VALUES (@ts, @num, @packet_id, @rssi, @snr, @hops)
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
    SELECT ts, rssi, snr FROM signal_history WHERE num = ? AND ts >= ?
    ORDER BY ts ASC
  `),

  // Most recent genuinely-direct capture for a node — `nodes.rssi`/`nodes.snr`
  // are themselves gated to direct reception (see persist.js isDirect/COALESCE)
  // but carry no timestamp of their own, so this is how the Signal card knows
  // how stale that frozen value is once the node goes relay-only (task
  // node-signal-freeze, 2026-07-25).
  latestSignalTs: db.prepare(`
    SELECT ts FROM signal_history WHERE num = ? ORDER BY ts DESC LIMIT 1
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

export function setNodeFavourite(num, favourite) {
  return stmts.setFavourite.run({ num, favourite: favourite ? 1 : 0 }).changes;
}

export function listFavourites() {
  return stmts.queryFavourites.all();
}

export function listFavouriteNodes() {
  return stmts.queryFavouriteNodes.all();
}

export function insertSignalHistory(entry) {
  stmts.insertSignalHistory.run(_finAll({ packet_id: null, rssi: null, snr: null, hops: null, ...entry }, ['rssi', 'snr']));
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
  stmts.setGeocode.run(address, num);
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
