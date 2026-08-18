import db, { getConfig } from './db.js';
import { getChannelNameByMac } from './ws-relay.js';

export function queryMessages(limit = 100) {
  const channels = getConfig('message_filter.channels', []);

  const conditions = [];
  const params = [];

  if (channels.length > 0) {
    conditions.push(`channel IN (${channels.map(() => '?').join(',')})`);
    params.push(...channels);
  }

  // THE `message_filter.hide_mqtt` BRANCH IS REMOVED, 2026-08-18, task
  // `filters-dead-mqtt-sql`. It read:
  //
  //     if (hideMqtt) conditions.push(`from_num NOT IN (SELECT num FROM mqtt_nodeinfo)`)
  //
  // `mqtt_nodeinfo` has never existed in data/node-dash.db. This function IS live
  // — index.js:266 and ws-relay.js:636 — and worked only because the config key
  // is unset and defaults false. One config write away from throwing
  // `no such table` and taking out BOTH the Messages page and the
  // message_history WS replay. Nothing in public/ can set it, so it was a
  // landmine with no path to it rather than a live outage.
  //
  // NOT replaced with an empty table. A filter that silently matches nothing is
  // worse than one that throws: the page looks filtered and is not.

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(Math.min(limit, 1000));

  return db.prepare(`
    SELECT
      MIN(m.id)                                           AS id,
      MIN(m.ts)                                           AS ts,
      MIN(m.from_num)                                     AS from_num,
      MIN(m.to_num)                                       AS to_num,
      MIN(m.text)                                         AS text,
      MIN(m.channel)                                      AS channel,
      MIN(m.is_dm)                                        AS is_dm,
      MIN(m.hop_limit)                                    AS hop_limit,
      MAX(m.snr)                                          AS snr,
      MAX(m.rssi)                                         AS rssi,
      MAX(m.hops)                                         AS hops,
      m.packet_id, m.reply_id,
      COALESCE(MAX(m.rx_devices), GROUP_CONCAT(m.device)) AS rx_devices,
      -- (device MAC, channel index) pairs for per-row channel-name resolution.
      -- '@' separator: a MAC already contains ':'. Resolved in JS below.
      GROUP_CONCAT(DISTINCT m.device || '@' || m.channel) AS _dev_chans,
      MAX(m.replay)                                       AS replay,
      MAX(m.category)                                     AS category,
      COALESCE(MIN(m.short_name), MIN(n.short_name))     AS short_name,
      COALESCE(MIN(m.long_name),  MIN(n.long_name))      AS long_name,
      MIN(m.status)                                       AS status,
      -- Stable logical identity = the GROUP BY expression itself, so it cannot
      -- change as more rows for the same message arrive. NOT MIN(message_key):
      -- a sent message gets a 't-<id>' row, and when the second gateway hears
      -- the transmission an 'r-<id>' row too, which would flip MIN() from
      -- 't-' to 'r-' and change the key of an already-rendered message.
      CASE WHEN m.packet_id IS NOT NULL
           THEN 'k-' || m.packet_id
           ELSE 'k-row-' || MIN(m.id) END                 AS message_key
    FROM messages m
    LEFT JOIN nodes n ON n.num = m.from_num
    ${where}
    GROUP BY CASE WHEN m.packet_id IS NOT NULL THEN m.packet_id ELSE m.id END
    ORDER BY MAX(m.ts) DESC LIMIT ?
  `).all(...params)
    // channel_name resolves the raw per-gateway index -> logical channel name via
    // (device,index)->name; the first pair that resolves wins (all pairs of one
    // packet agree). _dev_chans is internal — stripped from the output.
    .map(({ _dev_chans, ...r }) => {
      let channel_name = null;
      for (const pair of (_dev_chans || '').split(',')) {
        const at = pair.lastIndexOf('@');
        if (at < 0) continue;
        const name = getChannelNameByMac(pair.slice(0, at), pair.slice(at + 1));
        if (name) { channel_name = name; break; }
      }
      return { ...r, channel_name };
    });
}

// queryNodes() REMOVED 2026-08-18, task `filters-dead-mqtt-sql`.
//
// It had ZERO CALLERS in src/ or public/ — this module's own spec had already
// noted it was "not imported by any module ... or is dead code pending removal".
//
// It was also BROKEN, which is why it could not simply be left alone: it filtered
// on `mqtt_nodeinfo`, a table that has never existed in data/node-dash.db, and
// `node_filters.hide_mqtt` is set TRUE in config — so the branch was reached and
// SQLite answered `no such table: mqtt_nodeinfo`. Calling it threw. A dead
// function is tidy-up; a dead function that throws the moment anyone wires it up
// is a trap for whoever wires it up.
//
// NOTHING IS LOST. The live node list never used this — it is filtered in
// node-filter.js against the in-memory cache — and MQTT-only nodes are actually
// excluded by `node_filters.hide_mqtt_only`, which tests `rf_last_heard`, our own
// RF evidence. See docs/modules/filters.md.
