import { stmts, insertEnvHistory, syncAlertedAt, getConfig, setConfig } from './db.js';
import db from './db.js';

// ── Sensor heartbeat capture (NODE_STATUS_SPEC §4) ──────────────────────────
// Loose contract: text starts with 'v=' and yields ≥3 key=value tokens.
// ALL pairs land in kv verbatim (unknown keys kept — the sensor firmware may
// add fields freely); typed extraction is opportunistic for charting only.
export function parseSensorHeartbeat(text) {
  if (!text) return null;

  // JSON heartbeat: {"type":"status", fw, upt, boot, vbat, batt, env(bool),
  // temp, hum, trig, beat, ...} — the firmware moved off the v= text format
  // (heartbeat-json-parse). env is an OK flag: false ⇒ fault, temp/hum junk.
  if (text[0] === '{') {
    let o = null;
    try { o = JSON.parse(text); } catch { o = null; }
    if (o && o.type === 'status') {
      const envOk = o.env !== false;
      return {
        kv: o,
        fw:       o.fw ?? null,
        up_s:     Number.isFinite(o.upt)  ? o.upt  : null,
        boot:     Number.isFinite(o.boot) ? o.boot : null,
        rst:      o.rst ?? null,
        vbat_v:   Number.isFinite(o.vbat) ? o.vbat : null,
        vbat_pct: Number.isFinite(o.batt) ? o.batt : null,
        temp_c:   envOk && Number.isFinite(o.temp) ? o.temp : null,
        rh_pct:   envOk && Number.isFinite(o.hum)  ? o.hum  : null,
        env_err:  envOk ? 0 : 1,
        trig:     Number.isFinite(o.trig) ? o.trig : null,
        hb_s:     Number.isFinite(o.beat) ? o.beat : null,
      };
    }
    return null;   // other JSON message types (sleep, schema, …) aren't heartbeats
  }

  if (!text.startsWith('v=')) return null;
  const kv = {};
  let pairs = 0;
  for (const tok of text.trim().split(/\s+/)) {
    const i = tok.indexOf('=');
    if (i > 0) { kv[tok.slice(0, i)] = tok.slice(i + 1); pairs++; }
  }
  if (pairs < 3) return null;

  const intOf = (s) => { const m = /^-?\d+/.exec(s ?? ''); return m ? parseInt(m[0], 10) : null; };

  let vbat_v = null, vbat_pct = null;
  const vm = /^([\d.]+)V(?:\/(\d+)%)?/.exec(kv.vbat ?? '');
  if (vm) { vbat_v = Number(vm[1]); vbat_pct = vm[2] != null ? Number(vm[2]) : null; }

  // env=35.1C/25%  |  env=ERR:0.0C/0%  — a fault marker keeps env_err=1 and
  // nulls the junk numbers (fault preserved for display, kept out of charts)
  let temp_c = null, rh_pct = null, env_err = 0;
  if (kv.env != null) {
    const em = /^(ERR[^:]*:)?(-?[\d.]+)C\/(\d+)%/.exec(kv.env);
    if (em) {
      if (em[1]) env_err = 1;
      else { temp_c = Number(em[2]); rh_pct = Number(em[3]); }
    } else if (/err/i.test(kv.env)) {
      env_err = 1;
    }
  }

  return {
    kv,
    fw:       kv.v   ?? null,
    up_s:     intOf(kv.up),
    boot:     intOf(kv.boot),
    rst:      kv.rst ?? null,
    vbat_v, vbat_pct, temp_c, rh_pct, env_err,
    trig:     intOf(kv.trig),
    hb_s:     intOf(kv.hb),
  };
}

function _insertHeartbeat(ts, num, packetId, text, hb) {
  stmts.insertSensorHeartbeat.run({
    ts, num, packet_id: packetId ?? null, raw: text, kv: JSON.stringify(hb.kv),
    fw: hb.fw, up_s: hb.up_s, boot: hb.boot, rst: hb.rst,
    vbat_v: hb.vbat_v, vbat_pct: hb.vbat_pct,
    temp_c: hb.temp_c, rh_pct: hb.rh_pct, env_err: hb.env_err,
    trig: hb.trig, hb_s: hb.hb_s,
  });
}

// One-shot backfill from pre-existing messages (distinct per packet_id).
// Flag bumped to _v2 when JSON heartbeats were added — re-runs once, and the
// INSERT OR IGNORE dedups already-captured v= rows by packet_id.
if (!getConfig('migrations.sensor_heartbeats_backfill_v2', false)) {
  const rows = db.prepare(`
    SELECT MIN(ts) AS ts, from_num, text, packet_id FROM messages
    WHERE text LIKE 'v=%' OR text LIKE '{%status%'
    GROUP BY CASE WHEN packet_id IS NOT NULL THEN packet_id ELSE id END
  `).all();
  let n = 0;
  for (const r of rows) {
    const hb = parseSensorHeartbeat(r.text);
    if (hb && r.from_num) { _insertHeartbeat(r.ts, r.from_num, r.packet_id, r.text, hb); n++; }
  }
  setConfig('migrations.sensor_heartbeats_backfill_v2', true);
  if (n) console.log(`[persist] sensor_heartbeats backfill: ${n} rows`);
}
// ────────────────────────────────────────────────────────────────────────────

function _validCoord(lat, lon) {
  return lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function _upsertCache(num, nodeId, u, pos) {
  if (!num || (!u?.short_name && !u?.long_name)) return;
  const node_id = nodeId || u?.id || `!${num.toString(16).padStart(8, '0')}`;
  const lat = pos?.latitude_i  != null ? pos.latitude_i  / 1e7 : null;
  const lon = pos?.longitude_i != null ? pos.longitude_i / 1e7 : null;
  const validPos = _validCoord(lat, lon);
  stmts.upsertNodeinfo.run({
    node_id,
    num,
    short_name: u.short_name ?? null,
    long_name:  u.long_name  ?? null,
    hw_model:   u.hw_model   ?? null,
    role:       u.role       ?? null,
    lat:  validPos ? lat        : null,
    lon:  validPos ? lon        : null,
    alt:  validPos ? (pos?.altitude ?? null) : null,
    topic: null,
  });
}

const BROADCAST_NUM = 0xffffffff;

export function handleEvent(event) {
  const { type, data, _replay } = event;
  // V2: __ble_addr (BLE MAC) is the device key on every event; `device` is
  // the V1 legacy field (also a MAC). node_id is NOT in this chain — it is
  // not a device key and would reintroduce mixed vocabulary (IDENTITY.md).
  const rxDevice = event.__ble_addr ?? event.addr ?? event.device ?? null;
  const ts = Math.floor(Date.now() / 1000);

  if (type === 'packet') {
    handlePacket(data?.packet, rxDevice, ts, !!_replay);
  } else if (type === 'node_info' || type === 'nodeinfo') {
    // nodedb replay, not reception evidence — never writes nodes.device
    handleNodeInfo(data, null);
  } else if (type === 'telemetry') {
    handleTelemetryEvent(event, rxDevice);
  } else if (type === 'user') {
    // AppRouter decoded NODEINFO_APP
    if (event.from_num && data) {
      stmts.upsertNode.run({
        num: event.from_num, node_id: data.id ?? null,
        short_name: data.short_name ?? null, long_name: data.long_name ?? null,
        hw_model: data.hw_model ?? null, role: data.role ?? null,
        last_heard: ts, snr: event.rx_snr ?? null, rssi: event.rx_rssi ?? null,
        hops: event.hops ?? null, lat: null, lon: null, alt: null,
        battery: null, voltage: null, channel_util: null, air_util_tx: null, uptime_seconds: null,
        device: rxDevice,
      });
      _upsertCache(event.from_num, data.id, data, null);
    }
  } else if (type === 'position') {
    // AppRouter decoded POSITION_APP
    if (event.from_num && data) {
      const lat = data.latitude_i  != null ? data.latitude_i  / 1e7 : null;
      const lon = data.longitude_i != null ? data.longitude_i / 1e7 : null;
      stmts.upsertNode.run({
        num: event.from_num, node_id: null, short_name: null, long_name: null,
        hw_model: null, role: null, last_heard: ts,
        snr: event.rx_snr ?? null, rssi: event.rx_rssi ?? null, hops: event.hops ?? null,
        lat, lon, alt: data.altitude ?? null,
        battery: null, voltage: null, channel_util: null, air_util_tx: null, uptime_seconds: null,
        device: rxDevice,
      });
    }
  } else if (type === 'node_update') {
    // AppRouter node cache update — nodedb replay, never writes nodes.device
    handleNodeInfo(data, null);
  }
}

function handleTelemetryEvent(event, rxDevice) {
  const { data, from_num, rx_snr, rx_rssi } = event;
  if (!from_num || !data) return;
  const ts = Math.floor(Date.now() / 1000);
  if (data.device_metrics) {
    const m = data.device_metrics;
    stmts.upsertNode.run({
      num:            from_num,
      node_id:        null,
      short_name:     null,
      long_name:      null,
      hw_model:       null,
      role:           null,
      last_heard:     data.time || ts,
      snr:            rx_snr  ?? null,
      rssi:           rx_rssi ?? null,
      hops:           null,
      lat:            null,
      lon:            null,
      alt:            null,
      battery:        m.battery_level       ?? null,
      voltage:        m.voltage             ?? null,
      channel_util:   m.channel_utilization ?? null,
      air_util_tx:    m.air_util_tx         ?? null,
      uptime_seconds: m.uptime_seconds      ?? null,
      device:         rxDevice ?? null,
    });
  } else if (data.environment_metrics) {
    const m = data.environment_metrics;
    stmts.upsertNodeEnvMetrics.run({
      num:                 from_num,
      temperature:         m.temperature         ?? null,
      relative_humidity:   m.relative_humidity   ?? null,
      barometric_pressure: m.barometric_pressure ?? null,
      last_heard:          data.time || ts,
    });
    insertEnvHistory({
      ts:                  data.time || ts,
      num:                 from_num,
      temperature:         m.temperature         ?? null,
      relative_humidity:   m.relative_humidity   ?? null,
      barometric_pressure: m.barometric_pressure ?? null,
    });
  }
}

function handlePacket(packet, device, ts, replay) {
  if (!packet?.decoded) return;

  const { portnum } = packet.decoded;

  if (portnum === 'TEXT_MESSAGE_APP') {
    const text = packet.decoded.payload
      ? Buffer.from(packet.decoded.payload, 'base64').toString('utf8')
      : '';
    const user = packet.decoded.user;
    const pktId = packet.id ?? null;
    const rxStmt = pktId ? stmts.insertRxMessage : stmts.insertMessage;
    rxStmt.run({
      ts:          packet.rx_time || ts,
      from_num:    packet.from  || 0,
      to_num:      packet.to    || BROADCAST_NUM,
      text,
      channel:     packet.channel  ?? 0,
      is_dm:       packet.to !== BROADCAST_NUM ? 1 : 0,
      hop_limit:   packet.hop_limit ?? null,
      snr:         packet.rx_snr   ?? null,
      rssi:        packet.rx_rssi  ?? null,
      packet_id:   pktId,
      reply_id:    packet.decoded.reply_id ?? null,
      device:      device                  ?? null,
      replay:      replay ? 1 : 0,
      hops:        (packet.hop_start != null && packet.hop_limit != null)
                     ? Math.max(0, packet.hop_start - packet.hop_limit) : null,
      short_name:  user?.short_name ?? null,
      long_name:   user?.long_name  ?? null,
      message_key: pktId ? 'r-' + pktId : null,
    });
    syncAlertedAt(packet.id ?? null);
    // Structured sensor heartbeat? Capture it (NODE_STATUS_SPEC §4). Any
    // node — the monitored-device flag gates display, not capture.
    const hb = parseSensorHeartbeat(text);
    if (hb && packet.from) _insertHeartbeat(packet.rx_time || ts, packet.from, pktId, text, hb);
    return;
  }

  if (portnum === 'TELEMETRY_APP') {
    const telem = packet.decoded.telemetry;
    if (telem?.device_metrics) {
      const m = telem.device_metrics;
      stmts.upsertNode.run({
        num:           packet.from || 0,
        node_id:       null,
        short_name:    null,
        long_name:     null,
        hw_model:      null,
        role:          null,
        last_heard:    packet.rx_time || Math.floor(Date.now() / 1000),
        snr:           packet.rx_snr  ?? null,
        rssi:          packet.rx_rssi ?? null,
        hops:          null,
        lat:           null,
        lon:           null,
        alt:           null,
        battery:       m.battery_level  ?? null,
        voltage:       m.voltage        ?? null,
        channel_util:  m.channel_utilization ?? null,
        air_util_tx:   m.air_util_tx    ?? null,
        uptime_seconds: m.uptime_seconds ?? null,
        device,
      });
    } else if (telem?.environment_metrics) {
      const m   = telem.environment_metrics;
      const num = packet.from || 0;
      const ts  = packet.rx_time || Math.floor(Date.now() / 1000);
      stmts.upsertNodeEnvMetrics.run({
        num,
        temperature:         m.temperature         ?? null,
        relative_humidity:   m.relative_humidity   ?? null,
        barometric_pressure: m.barometric_pressure ?? null,
        last_heard:          ts,
      });
      insertEnvHistory({
        ts,
        num,
        temperature:         m.temperature         ?? null,
        relative_humidity:   m.relative_humidity   ?? null,
        barometric_pressure: m.barometric_pressure ?? null,
      });
    }
    return;
  }

  if (portnum === 'NODEINFO_APP') {
    const u = packet.decoded.user;
    if (!u || !packet.from) return;
    stmts.upsertNode.run({
      num:           packet.from,
      node_id:       u.id         ?? null,
      short_name:    u.short_name ?? null,
      long_name:     u.long_name  ?? null,
      hw_model:      u.hw_model   ?? null,
      role:          u.role       ?? null,
      last_heard:    packet.rx_time || Math.floor(Date.now() / 1000),
      snr:           packet.rx_snr  ?? null,
      rssi:          packet.rx_rssi ?? null,
      hops:          null,
      lat:           null,
      lon:           null,
      alt:           null,
      battery:       null,
      voltage:       null,
      channel_util:  null,
      air_util_tx:   null,
      uptime_seconds: null,
      device,
    });
    _upsertCache(packet.from, u.id, u, null);
    return;
  }

  if (portnum === 'POSITION_APP') {
    const pos = packet.decoded.position;
    if (!pos) return;
    stmts.upsertNode.run({
      num:           packet.from || 0,
      node_id:       null,
      short_name:    null,
      long_name:     null,
      hw_model:      null,
      role:          null,
      last_heard:    packet.rx_time || Math.floor(Date.now() / 1000),
      snr:           packet.rx_snr  ?? null,
      rssi:          packet.rx_rssi ?? null,
      hops:          null,
      lat:           pos.latitude_i  != null ? pos.latitude_i  / 1e7 : null,
      lon:           pos.longitude_i != null ? pos.longitude_i / 1e7 : null,
      alt:           pos.altitude    ?? null,
      battery:       null,
      voltage:       null,
      channel_util:  null,
      air_util_tx:   null,
      uptime_seconds: null,
      device,
    });
  }
}

function handleNodeInfo(data, device) {
  const node = data?.node_info ?? data;
  if (!node?.num) return;
  const u = node.user || {};
  const pos = node.position || {};
  const m = node.device_metrics || {};
  stmts.upsertNode.run({
    num:           node.num,
    node_id:       u.id          ?? null,
    short_name:    u.short_name  ?? null,
    long_name:     u.long_name   ?? null,
    hw_model:      u.hw_model    ?? null,
    role:          u.role        ?? null,
    last_heard:    node.last_heard ?? null,
    snr:           node.snr      ?? null,
    rssi:          node.rssi     ?? null,
    hops:          node.hops     ?? null,
    lat:           pos.latitude_i  != null ? pos.latitude_i  / 1e7 : null,
    lon:           pos.longitude_i != null ? pos.longitude_i / 1e7 : null,
    alt:           pos.altitude   ?? null,
    battery:       m.battery_level  ?? null,
    voltage:       m.voltage        ?? null,
    channel_util:  m.channel_utilization ?? null,
    air_util_tx:   m.air_util_tx    ?? null,
    uptime_seconds: m.uptime_seconds ?? null,
    device,
  });
  _upsertCache(node.num, u.id, u, pos);
}
