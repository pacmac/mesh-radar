import db, { getConfig } from './db.js';

export function queryMessages(limit = 100) {
  const channels = getConfig('message_filter.channels', []);
  const hideMqtt = getConfig('message_filter.hide_mqtt', false);

  const conditions = [];
  const params = [];

  if (channels.length > 0) {
    conditions.push(`channel IN (${channels.map(() => '?').join(',')})`);
    params.push(...channels);
  }

  if (hideMqtt) {
    conditions.push(`from_num NOT IN (SELECT num FROM mqtt_nodeinfo)`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Math.min(limit, 1000));

  return db.prepare(`SELECT * FROM messages ${where} ORDER BY ts DESC LIMIT ?`).all(...params);
}

export function queryNodes() {
  const maxAge    = getConfig('node_filters.max_age',    0);
  const maxHops   = getConfig('node_filters.max_hops',   99);
  const namedOnly = getConfig('node_filters.named_only', false);
  const hasPos    = getConfig('node_filters.has_pos',    false);
  const hideMqtt  = getConfig('node_filters.hide_mqtt',  false);
  const hasSignal = getConfig('node_filters.has_signal', false);
  const hasTelem  = getConfig('node_filters.has_telem',  false);
  const roles     = getConfig('node_filters.roles',      []);
  const sortField = getConfig('node_sort.field',         'last_heard');
  const sortDir   = getConfig('node_sort.dir',           -1);

  const conditions = [];
  const params = [];

  if (maxAge > 0) {
    conditions.push(`last_heard >= (unixepoch() - ?)`);
    params.push(maxAge);
  }
  if (maxHops < 99) {
    conditions.push(`hops <= ?`);
    params.push(maxHops);
  }
  if (namedOnly) conditions.push(`long_name IS NOT NULL`);
  if (hasPos)    conditions.push(`lat IS NOT NULL AND lon IS NOT NULL`);
  if (hideMqtt)  conditions.push(`num NOT IN (SELECT num FROM mqtt_nodeinfo WHERE num IS NOT NULL)`);
  if (hasSignal) conditions.push(`snr IS NOT NULL`);
  if (hasTelem)  conditions.push(`battery IS NOT NULL`);
  if (roles.length > 0) {
    conditions.push(`role IN (${roles.map(() => '?').join(',')})`);
    params.push(...roles);
  }

  const SAFE_FIELDS = new Set(['last_heard', 'snr', 'hops', 'long_name', 'updated_at']);
  const orderField = SAFE_FIELDS.has(sortField) ? sortField : 'last_heard';
  const orderDir   = sortDir >= 0 ? 'ASC' : 'DESC';

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM nodes ${where} ORDER BY ${orderField} ${orderDir}`).all(...params);
}
