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
    rx_device TEXT
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

  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup  ON messages(packet_id, device) WHERE packet_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_ts     ON messages(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_from   ON messages(from_num);
  CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_type     ON events(type);
  CREATE INDEX IF NOT EXISTS idx_nodes_updated   ON nodes(updated_at DESC);
`);

// Migrations for columns added after initial schema
const existingCols = db.prepare(`PRAGMA table_info(messages)`).all().map(r => r.name);
if (!existingCols.includes('reply_id')) {
  db.exec(`ALTER TABLE messages ADD COLUMN reply_id INTEGER`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_id) WHERE reply_id IS NOT NULL`);
}
const tiltCols = db.prepare(`PRAGMA table_info(tilt_history)`).all().map(r => r.name);
if (!tiltCols.includes('ncal')) {
  db.exec(`ALTER TABLE tilt_history ADD COLUMN ncal INTEGER NOT NULL DEFAULT 0`);
}
const nodeinfoCols = db.prepare(`PRAGMA table_info(nodeinfo)`).all().map(r => r.name);
if (!nodeinfoCols.includes('first_heard')) {
  db.exec(`ALTER TABLE nodeinfo ADD COLUMN first_heard INTEGER`);
  db.exec(`UPDATE nodeinfo SET first_heard = unixepoch() - (7 * 86400) WHERE first_heard IS NULL`);
}

export const stmts = {
  insertMessage: db.prepare(`
    INSERT OR IGNORE INTO messages (ts, from_num, to_num, text, channel, is_dm, hop_limit, snr, rssi, packet_id, reply_id, device, replay)
    VALUES (@ts, @from_num, @to_num, @text, @channel, @is_dm, @hop_limit, @snr, @rssi, @packet_id, @reply_id, @device, @replay)
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
  `),

  insertEvent: db.prepare(`
    INSERT INTO events (ts, type, device, data) VALUES (@ts, @type, @device, @data)
  `),

  insertRangeTest: db.prepare(`
    INSERT INTO range_test_log (ts, from_num, rssi, snr, hops, seq, rx_device)
    VALUES (@ts, @from_num, @rssi, @snr, @hops, @seq, @rx_device)
  `),

  queryRangeTest: db.prepare(`
    SELECT id, ts, from_num, rssi, snr, hops, seq, rx_device
    FROM range_test_log ORDER BY ts DESC LIMIT ?
  `),

  clearRangeTest: db.prepare(`DELETE FROM range_test_log`),
  clearNodes:     db.prepare(`DELETE FROM nodes`),

  getConfig:   db.prepare(`SELECT value FROM config WHERE key = ?`),
  setConfig:   db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  getNodePos:  db.prepare(`SELECT lat, lon FROM nodes WHERE num = ? AND lat IS NOT NULL`),

  insertTilt: db.prepare(`
    INSERT INTO tilt_history (ts, node_id, pitch, roll, x_g, y_g, z_g)
    VALUES (@ts, @node_id, @pitch, @roll, @x_g, @y_g, @z_g)
  `),

  queryTilt: db.prepare(`
    SELECT ts, pitch, roll, x_g, y_g, z_g FROM tilt_history
    WHERE node_id = ? AND ts >= ? AND ncal = 0
    ORDER BY ts ASC
  `),

  markNcal: db.prepare(`
    UPDATE tilt_history SET ncal = 1
    WHERE node_id = ? AND ts BETWEEN ? AND ?
  `),

};

export function getConfig(key, fallback = null) {
  const row = stmts.getConfig.get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setConfig(key, value) {
  stmts.setConfig.run(key, JSON.stringify(value));
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

export function insertTilt(entry) {
  stmts.insertTilt.run(entry);
}

export function queryTiltHistory(nodeId, sinceTs) {
  return stmts.queryTilt.all(nodeId, sinceTs);
}

export function markTiltNcal(nodeId, tsFrom, tsTo) {
  return stmts.markNcal.run(nodeId, tsFrom, tsTo).changes;
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

export default db;
