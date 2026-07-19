import {
  stmts, insertEnvHistory, syncAlertedAt, getConfig, setConfig,
  insertDeviceMetricsHistory, insertDetectionEvent, upsertNodeAppState,
  insertSignalHistory,
} from './db.js';
import db from './db.js';

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

// A device that has no sensor sends NaN, and better-sqlite3 stores JS NaN as
// the TEXT string 'NaN' in a REAL column — silent type pollution that reads as
// a present value to any consumer not checking typeof. An absent reading is
// NULL. Applied to every numeric telemetry field at the point of capture.
const fin = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

// The device's own `time` is WHEN THE READING WAS TAKEN, which beats arrival
// time for a delayed or relayed packet — but only if its clock is trustworthy.
// Tarr Exmoor 5 Repeater (132 days uptime, no GPS) reported a time 22.7 HOURS
// ahead, and `deviceTime(data.time, ts)` believed it: one row dated tomorrow, which
// stretches every chart axis a day forward. The same expression put 2,607 rows
// in 1970 when a device sent uptime instead of an epoch (backlog #3).
//
// So: accept the device clock only when it lands in a sane window around the
// gateway's, otherwise fall back to arrival. 1 minute of tolerance (Peter)
// covers ordinary drift; anything beyond that is the device being wrong, and
// our own arrival time is the better record.
//
// Where WE do the stamping, the timestamp is ours to get right — arrival time
// comes from the gateway clock and needs no allowance at all.
const EPOCH_2001 = 1_000_000_000;
const CLOCK_SKEW_GRACE_S = 60;
function deviceTime(t, arrivalTs) {
  // SYMMETRIC: drift goes both ways. A packet that just arrived cannot have
  // been measured in 2024 any more than tomorrow — device_metrics_history was
  // created today and still received rows dated 2024-07-03 through 2026-05-31
  // from 13 different nodes, all of them wrong clocks rather than old data.
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= EPOCH_2001) return arrivalTs;
  return Math.abs(t - arrivalTs) <= CLOCK_SKEW_GRACE_S ? t : arrivalTs;
}

// A reception describes a node's link ONLY when it arrived DIRECTLY. The
// envelope's rx_rssi/rx_snr are the signal at our gateway from whoever
// transmitted to us — for a relayed packet that is the RELAY, not the origin.
// Attributing it to packet.from wrote other nodes' link quality into a node's
// record: 462 of 977 stored samples (47%) were relay traffic, averaging
// -102 dBm against a true direct average of -35 dBm. That is the reported
// "twitching between -1XX and -33".
//
// Unknown hops count as NOT direct: their average (-100.1) matches the relayed
// population, not the direct one, so recording them would repeat the error with
// less evidence.
const isDirect = hops => hops === 0;

// Signal comes from the packet ENVELOPE, never a payload (iron rule 4).
// Deduped by (num, packet_id) so N gateway radios hearing one broadcast yield
// one row.
function _captureSignal(num, packetId, rssi, snr, ts, hops) {
  if (!num) return;
  if (!isDirect(hops)) return;
  if (rssi == null && snr == null) return;
  try {
    insertSignalHistory({ ts, num, packet_id: packetId ?? null, rssi: fin(rssi), snr: fin(snr), hops });
  } catch (e) {
    console.error(`[signal] insert failed for ${num}: ${e.message}`);
  }
}

export function handleEvent(event) {
  const { type, data, _replay } = event;
  // V2: __ble_addr (BLE MAC) is the device key on every event; `device` is
  // the V1 legacy field (also a MAC). node_id is NOT in this chain — it is
  // not a device key and would reintroduce mixed vocabulary (IDENTITY.md).
  const rxDevice = event.__ble_addr ?? event.addr ?? event.device ?? null;
  const ts = Math.floor(Date.now() / 1000);

  // Typed AppRouter events carry the envelope alongside their payload.
  const evHops = event.hops ?? null;
  if (event.from_num && (event.rx_rssi != null || event.rx_snr != null)) {
    _captureSignal(event.from_num, event.packet_id ?? null, event.rx_rssi, event.rx_snr, event.rx_time || ts, evHops);
  }
  // Only a direct reception may set a node's live signal. upsertNode COALESCEs,
  // so the last DIRECT value is retained instead of being overwritten by relay
  // traffic from a different link.
  const evRssi = isDirect(evHops) ? (event.rx_rssi ?? null) : null;
  const evSnr  = isDirect(evHops) ? (event.rx_snr  ?? null) : null;

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
        last_heard: ts, snr: evSnr, rssi: evRssi,
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
        snr: evSnr, rssi: evRssi, hops: event.hops ?? null,
        lat, lon, alt: data.altitude ?? null,
        battery: null, voltage: null, channel_util: null, air_util_tx: null, uptime_seconds: null,
        device: rxDevice,
      });
    }
  } else if (type === 'detectionsensor') {
    // AppRouter decoded DETECTION_SENSOR_APP. Standard registered portnum, so
    // it arrives typed — NOT via private_app. Registry name is `detectionsensor`
    // (meshtastic/python __init__.py), and it has no protobufFactory, so the
    // payload is a STRING.
    handleDetectionEvent(event, ts);
  } else if (type === 'private_app' && event.portnum === 260) {
    // PAC_ALARM_APP. Routed by NUMERIC portnum first, then payload `type` —
    // never by the 'PRIVATE_APP' string, which is a portnum-range label, not an
    // app identity. 256 (tilt) is handled in ws-relay and is untouched here.
    handlePrivateAppState(event, ts);
  } else if (type === 'node_update') {
    // AppRouter node cache update — nodedb replay, never writes nodes.device
    handleNodeInfo(data, null);
  }
}

// DETECTION_SENSOR_APP payloads are strings. Our nodes send a JSON envelope
// (mt-transport API.md §4); a stock Meshtastic detection module sends plain text
// ("X detected") on the same port by design. Both are stored — `raw` always
// holds the original. Never throws: one stock detection node anywhere in the
// mesh must not break ingestion for every other node.
function handleDetectionEvent(event, ts) {
  const num = event.from_num;
  if (!num) return;
  const raw = typeof event.data === 'string'
    ? event.data
    : (event.data?.text ?? event.text ?? '');
  if (!raw) return;

  const row = {
    ts:        event.rx_time || ts,
    num,
    packet_id: event.packet_id ?? null,
    type: null, kind: null, val: null, count_num: null, msg: null, more: null,
    raw,
  };

  let p = null;
  try { p = JSON.parse(raw); } catch { /* plain text — stored raw, typed cols stay null */ }

  if (p && typeof p.type === 'string') {
    // Unknown types are stored verbatim in `type` with the rest null —
    // accept what the device sends, do not filter (iron rule 2).
    row.type = p.type;
    row.msg  = typeof p.msg === 'string' ? p.msg : null;
    if (p.type === 'alarm' || p.type === 'cleared') {
      row.kind = typeof p.kind === 'string' ? p.kind : null;
      row.val  = Number.isFinite(p.val) ? p.val : null;
      row.more = p.more ? 1 : null;
    } else if (p.type === 'count') {
      row.count_num = Number.isFinite(p.num) ? p.num : null;
    }
  }

  try {
    insertDetectionEvent(row);
  } catch (e) {
    console.error(`[detection] insert failed for ${num}: ${e.message}`);
  }
}

// Latest-only cache of a private app's state, keyed (num, portnum, type).
// Payload is stored verbatim — no interpretation here; formatting belongs to
// the API layer, per NODE_STATUS_SPEC iron rule 1.
function handlePrivateAppState(event, ts) {
  const num = event.from_num;
  if (!num || !event.payload_b64) return;

  // NOT YET routed through the transport plugin — see DECISIONS D7.
  // The plugin's capability methods are uniformly async (they may do radio I/O),
  // but this is the synchronous ingestion choke point: handleEvent() is
  // `→ void` by contract. Awaiting here would make the whole persist path async,
  // which is a change to ingestion ordering, not a refactor.
  let p = null;
  try {
    p = JSON.parse(Buffer.from(event.payload_b64, 'base64').toString('utf8'));
  } catch {
    return;   // not JSON — portnum 260 is additive; other users are not our concern
  }
  if (!p || typeof p.type !== 'string') return;
  try {
    upsertNodeAppState({
      num,
      portnum: event.portnum,
      type:    p.type,
      ts:      event.rx_time || ts,
      payload: JSON.stringify(p),
    });
  } catch (e) {
    console.error(`[private_app] cache failed for ${num}/${event.portnum}: ${e.message}`);
  }
}

function handleTelemetryEvent(event, rxDevice) {
  const { data, from_num, rx_snr, rx_rssi, packet_id } = event;
  // Same rule as everywhere else: only a direct reception describes this node's
  // link, so a relayed telemetry packet must not set its signal.
  const direct = isDirect(event.hops ?? null);
  if (!from_num || !data) return;
  const ts = Math.floor(Date.now() / 1000);
  if (data.device_metrics) {
    const m = data.device_metrics;
    insertDeviceMetricsHistory({
      ts:                  deviceTime(data.time, ts),
      num:                 from_num,
      packet_id:           packet_id ?? null,
      uptime_seconds:      fin(m.uptime_seconds),
      voltage:             fin(m.voltage),
      battery_level:       fin(m.battery_level),
      channel_utilization: fin(m.channel_utilization),
      air_util_tx:         fin(m.air_util_tx),
    });
    stmts.upsertNode.run({
      num:            from_num,
      node_id:        null,
      short_name:     null,
      long_name:      null,
      hw_model:       null,
      role:           null,
      last_heard:     deviceTime(data.time, ts),
      snr:            direct ? (rx_snr  ?? null) : null,
      rssi:           direct ? (rx_rssi ?? null) : null,
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
      last_heard:          deviceTime(data.time, ts),
    });
    insertEnvHistory({
      ts:                  deviceTime(data.time, ts),
      num:                 from_num,
      packet_id:           packet_id ?? null,
      temperature:         fin(m.temperature),
      relative_humidity:   fin(m.relative_humidity),
      barometric_pressure: fin(m.barometric_pressure),
      gas_resistance:      fin(m.gas_resistance),
    });
  }
}

function handlePacket(packet, device, ts, replay) {
  if (!packet?.decoded) return;

  // Envelope signal for every DIRECT packet, regardless of portnum — the
  // densest honest source of a node's own link quality over time.
  const pktHops = (packet.hop_start != null && packet.hop_limit != null)
    ? Math.max(0, packet.hop_start - packet.hop_limit) : null;
  _captureSignal(packet.from, packet.id ?? null, packet.rx_rssi, packet.rx_snr,
                 packet.rx_time || ts, pktHops);
  const pktRssi = isDirect(pktHops) ? (packet.rx_rssi ?? null) : null;
  const pktSnr  = isDirect(pktHops) ? (packet.rx_snr  ?? null) : null;

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
    return;
  }

  if (portnum === 'TELEMETRY_APP') {
    const telem = packet.decoded.telemetry;
    if (telem?.device_metrics) {
      const m = telem.device_metrics;
      insertDeviceMetricsHistory({
        ts:                  packet.rx_time || ts,
        num:                 packet.from || 0,
        packet_id:           packet.id ?? null,
        uptime_seconds:      fin(m.uptime_seconds),
        voltage:             fin(m.voltage),
        battery_level:       fin(m.battery_level),
        channel_utilization: fin(m.channel_utilization),
        air_util_tx:         fin(m.air_util_tx),
      });
      stmts.upsertNode.run({
        num:           packet.from || 0,
        node_id:       null,
        short_name:    null,
        long_name:     null,
        hw_model:      null,
        role:          null,
        last_heard:    packet.rx_time || Math.floor(Date.now() / 1000),
        snr:           pktSnr,
        rssi:          pktRssi,
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
        packet_id:           packet.id ?? null,
        temperature:         fin(m.temperature),
        relative_humidity:   fin(m.relative_humidity),
        barometric_pressure: fin(m.barometric_pressure),
        gas_resistance:      fin(m.gas_resistance),
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
      snr:           pktSnr,
      rssi:          pktRssi,
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
      snr:           pktSnr,
      rssi:          pktRssi,
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
