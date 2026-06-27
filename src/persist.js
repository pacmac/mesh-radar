import { stmts, insertEnvHistory } from './db.js';

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
  const { type, data, device, _replay } = event;
  const ts = Math.floor(Date.now() / 1000);

  if (type === 'packet') {
    handlePacket(data?.packet, device, ts, !!_replay);
  } else if (type === 'node_info' || type === 'nodeinfo') {
    handleNodeInfo(data, device);
  } else if (type === 'telemetry') {
    handleTelemetryEvent(event);
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
        device,
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
        device,
      });
    }
  } else if (type === 'node_update') {
    // AppRouter node cache update — has merged user/position/metrics data
    handleNodeInfo(data, device);
  }
}

function handleTelemetryEvent(event) {
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
      device:         event.device ?? null,
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
    stmts.insertMessage.run({
      ts:         packet.rx_time || ts,
      from_num:   packet.from  || 0,
      to_num:     packet.to    || BROADCAST_NUM,
      text,
      channel:    packet.channel  ?? 0,
      is_dm:      packet.to !== BROADCAST_NUM ? 1 : 0,
      hop_limit:  packet.hop_limit ?? null,
      snr:        packet.rx_snr   ?? null,
      rssi:       packet.rx_rssi  ?? null,
      packet_id:  packet.id              ?? null,
      reply_id:   packet.decoded.reply_id ?? null,
      device:     device                  ?? null,
      replay:     replay ? 1 : 0,
      hops:       (packet.hop_start != null && packet.hop_limit != null)
                    ? Math.max(0, packet.hop_start - packet.hop_limit) : null,
      short_name: user?.short_name ?? null,
      long_name:  user?.long_name  ?? null,
    });
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
