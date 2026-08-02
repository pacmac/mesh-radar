import {
  stmts, insertEnvHistory, syncAlertedAt, getConfig, setConfig,
  insertDeviceMetricsHistory, insertDetectionEvent,
  insertSignalHistory,
} from './db.js';
import db from './db.js';

function _validCoord(lat, lon) {
  return lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

// lastHeard (task nodeinfo-replay-regression, 2026-07-25): nodeinfo has no
// last_heard column of its own to self-gate with (deliberately — adding one
// would be a schema migration; see docs/modules/db.md's nodeinfo note). This
// borrows the sibling nodes row's last_heard instead, which by construction
// was just written (or correctly rejected) by the caller's own
// stmts.upsertNode.run() moments earlier in the same function, and skips the
// nodeinfo write when the incoming data is strictly older than that — same
// "unknown freshness still writes" behavior as upsertNode's own gate when
// lastHeard is absent.
function _upsertCache(num, nodeId, u, pos, lastHeard) {
  if (!num || (!u?.short_name && !u?.long_name)) return;
  if (lastHeard != null) {
    const current = stmts.getNodeByNum.get(num);
    if (current?.last_heard != null && lastHeard < current.last_heard) return;
  }
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
//
// Hop arithmetic ALONE is not sufficient, and the first version of this gate
// (which tested only `hops === 0`) did not actually fix the bug above. mesh-gw
// confirmed it (xsession [inbound-relay-attribution], 2026-07-26): they pass the
// MeshPacket through verbatim and compute nothing, and a relayed packet CAN
// present hop_start - hop_limit == 0. Measured here before the fix: 1014 of one
// node's 8269 `hops === 0` rows averaged -39.7 dBm on a 2.5 km link whose
// free-space best case is about -59 dBm, with the strong and weak populations
// splitting exactly at -59/-60. That is relay traffic stored as direct.
//
// `relay_node` (MeshPacket field 19, top-level INSIDE data.packet — never on a
// typed event) is the discriminator: the low byte of the relaying node's num.
//
// TRAP: mesh-gw serialises with proto3 default-omission, so a zero-valued field
// is OMITTED entirely. `relay_node` absent therefore means "== 0" — NOT relayed
// — and must not be read as "unknown". The same applies to hop_limit.
//
// Being only a low byte, relay_node is an indicator and not a unique id: two
// nodes sharing a last byte are indistinguishable, so a genuine direct packet
// can be rejected roughly 1 time in 256. That is the right side to err on —
// a lost sample costs a gap, whereas admitting relay traffic corrupts the
// stored link quality, which is the bug being fixed.
//
// hop_start remains REQUIRED. Absent hop_start is no basis on which to judge,
// and the -100.1 evidence above says treat that as not-direct.
function isDirectPacket(pkt) {
  if (!pkt) return false;
  if ((pkt.relay_node ?? 0) !== 0) return false;
  if (pkt.hop_start == null) return false;
  return pkt.hop_start - (pkt.hop_limit ?? 0) === 0;
}

// Signal comes from the packet ENVELOPE, never a payload (iron rule 4).
// Deduped by (num, packet_id, rx_device): one row PER RADIO, so when OMNI and
// YAGI both hear a broadcast we keep both readings. They are not duplicates —
// two antennas measuring one identical packet is a direct A/B of the two, and
// the old (num, packet_id) key discarded whichever arrived second (task
// `signal-provenance-mixed-source`). A repeat from the same radio is still
// suppressed. rxDevice is a MAC (nodes.device vocabulary, IDENTITY.md); null
// is permitted and means "not attributed" — it dedups against other nulls.
function _captureSignal(num, packetId, rssi, snr, ts, hops, rxDevice) {
  if (!num) return;
  if (rssi == null && snr == null) return;
  try {
    insertSignalHistory({ ts, num, packet_id: packetId ?? null, rssi: fin(rssi), snr: fin(snr), hops, rx_device: rxDevice ?? null });
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

  // A typed AppRouter event carries the envelope alongside its payload, but NOT
  // `relay_node` — measured across live position/user/telemetry events, it is
  // absent at both the top level and inside data. So a typed event cannot
  // establish that a reception was direct, and must not write signal at all.
  //
  // Nothing is lost by that. Every reception carrying signal also arrives as a
  // `packet` event for the same packet_id on the same radio (sampled live:
  // 12 packet-only, 2 packet+typed pairs, ZERO typed-only), because a typed
  // event IS an AppRouter decode of that same packet. handlePacket does the
  // capture, with relay_node available to gate it.
  const evRssi = null;
  const evSnr  = null;

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
      _upsertCache(event.from_num, data.id, data, null, ts);
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
  } else if (type === 'node_update') {
    // AppRouter node cache update — nodedb replay, never writes nodes.device
    handleNodeInfo(data, null);
  }
}

// DETECTION_SENSOR_APP payloads are standard Meshtastic strings. Store the
// original text without interpreting application-specific grammars.
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
    raw,
  };

  try {
    insertDetectionEvent(row);
  } catch (e) {
    console.error(`[detection] insert failed for ${num}: ${e.message}`);
  }
}

function handleTelemetryEvent(event, rxDevice) {
  const { data, from_num, rx_snr, rx_rssi, packet_id } = event;
  // Same rule as everywhere else: only a direct reception describes this node's
  // link. A telemetry event is a typed event and carries no relay_node, so it
  // cannot prove directness and never sets signal — the paired `packet` event
  // does that. See the evRssi/evSnr note in handleEvent.
  const direct = false;
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

// ─── Packet observers — core EMITS, it does not reach in ────────────────────
//
// The same extension-point idiom as registerNodeSection (node-status.js) and
// registerWsWiring (ws-relay.js). It exists so the observatory can see every
// packet WITHOUT persist.js importing it: core is not permitted to name a
// plugin, and tests/test_observatory_boundary.mjs enforces that. The
// composition root wires the two together.
//
// Called for EVERY packet, direct or relayed. That is the point — the nodes
// worth locating are the distant relayed ones, which _captureSignal below
// deliberately excludes (relayed RSSI describes the last hop, not the origin).
const _packetObservers = [];
export function registerPacketObserver(fn) { _packetObservers.push(fn); }

function _notifyPacketObservers(packet, device, ts, replay) {
  for (const fn of _packetObservers) {
    // ISOLATED ON PURPOSE. This runs on the hot path for every packet. Core
    // emitting into a plugin must never become core DEPENDING on the plugin
    // working — a throw in an observer must not take down packet ingestion.
    try { fn(packet, device, ts, replay); }
    catch (e) { console.error(`[persist] packet observer failed: ${e.message}`); }
  }
}

function handlePacket(packet, device, ts, replay) {
  if (!packet?.decoded) return;

  _notifyPacketObservers(packet, device, ts, replay);

  // Envelope signal for every DIRECT packet, regardless of portnum — the
  // densest honest source of a node's own link quality over time.
  // hop_limit omitted means 0 (proto3 default-omission), so it is defaulted here
  // rather than making the whole computation null — see isDirectPacket.
  const pktDirect = isDirectPacket(packet);
  const pktHops = packet.hop_start != null
    ? Math.max(0, packet.hop_start - (packet.hop_limit ?? 0)) : null;
  if (pktDirect) {
    _captureSignal(packet.from, packet.id ?? null, packet.rx_rssi, packet.rx_snr,
                   packet.rx_time || ts, pktHops, device);
  }
  const pktRssi = pktDirect ? (packet.rx_rssi ?? null) : null;
  const pktSnr  = pktDirect ? (packet.rx_snr  ?? null) : null;

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
    const nodeInfoTs = packet.rx_time || Math.floor(Date.now() / 1000);
    stmts.upsertNode.run({
      num:           packet.from,
      node_id:       u.id         ?? null,
      short_name:    u.short_name ?? null,
      long_name:     u.long_name  ?? null,
      hw_model:      u.hw_model   ?? null,
      role:          u.role       ?? null,
      last_heard:    nodeInfoTs,
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
    _upsertCache(packet.from, u.id, u, null, nodeInfoTs);
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
    // NEVER the nodedb aggregate. RSSI_ATTRIBUTION_SPEC's invariant is that
    // nodes.rssi/snr hold the last DIRECT reception; every other write path here
    // gates on that, and this one did not. node.snr/node.rssi come from mesh-gw's
    // nodedb — a cached figure from whichever radio last saw the node, direct or
    // relayed, with no attribution and no timestamp of its own. Combined with
    // upsertNode's COALESCE (a null never clears), one bad write persisted
    // indefinitely: GARG's header read "-98 dBm / +6.8 dB" while signal_history
    // held zero positive-SNR rows in 24h and nothing near -98 on either radio.
    // null here means "this event is not reception evidence", which is true —
    // COALESCE then keeps the last genuinely-direct value. See
    // docs/SIGNAL_SSOT_SPEC.md §1a.
    snr:           null,
    rssi:          null,
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
  _upsertCache(node.num, u.id, u, pos, node.last_heard ?? null);
}
