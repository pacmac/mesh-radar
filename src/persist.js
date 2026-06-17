import { stmts } from './db.js';

const BROADCAST_NUM = 0xffffffff;

export function handleEvent(event) {
  const { type, data, device, _replay } = event;
  const ts = Math.floor(Date.now() / 1000);

  if (type === 'packet') {
    handlePacket(data?.packet, device, ts, !!_replay);
  } else if (type === 'node_info' || type === 'nodeinfo') {
    handleNodeInfo(data, device);
  }
}

function handlePacket(packet, device, ts, replay) {
  if (!packet?.decoded) return;

  const { portnum } = packet.decoded;

  if (portnum === 'TEXT_MESSAGE_APP') {
    const text = packet.decoded.payload
      ? Buffer.from(packet.decoded.payload, 'base64').toString('utf8')
      : '';
    stmts.insertMessage.run({
      ts:        packet.rx_time || ts,
      from_num:  packet.from  || 0,
      to_num:    packet.to    || BROADCAST_NUM,
      text,
      channel:   packet.channel  ?? 0,
      is_dm:     packet.to !== BROADCAST_NUM ? 1 : 0,
      hop_limit: packet.hop_limit ?? null,
      snr:       packet.rx_snr   ?? null,
      rssi:      packet.rx_rssi  ?? null,
      packet_id: packet.id       ?? null,
      device:    device           ?? null,
      replay:    replay ? 1 : 0,
    });
    return;
  }

  if (portnum === 'TELEMETRY_APP') {
    const telem = packet.decoded.telemetry;
    if (!telem?.device_metrics) return;
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
}
