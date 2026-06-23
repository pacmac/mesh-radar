// Alert evaluator — polling (node_offline, temp_high, condensation)
// and event-driven (dm_received, broadcast_direct, tilt_high, ble_disconnect).
import { getAlertRule, touchAlertLastSent, createReplyToken, pruneExpiredTokens, isPacketAlerted, markPacketAlerted, getTiltCal } from './db.js';
import db from './db.js';
import { sendAlert } from './mailer.js';
import { randomUUID } from 'crypto';

const BROADCAST_NUM = 0xffffffff;

// Descriptions shown in alert emails and UI
export const ALERT_META = {
  node_offline:     { label: 'Node offline',          unit: 'min',  desc: 'Node not heard for N minutes' },
  ble_disconnect:   { label: 'BLE disconnected',      unit: null,   desc: 'Gateway lost BLE connection to radio' },
  temp_high:        { label: 'High enclosure temp',   unit: '°C',   desc: 'Enclosure temperature exceeds threshold' },
  condensation:     { label: 'Condensation risk',     unit: '°C',   desc: 'Dew point within N°C of temperature' },
  dm_received:      { label: 'Direct message',        unit: null,   desc: 'DM received on the gateway node' },
  broadcast_direct: { label: '0-hop broadcast',       unit: null,   desc: 'Broadcast message received with 0 hops' },
  tilt_high:        { label: 'Mast tilt',             unit: '°',    desc: 'Mast tilt exceeds threshold degrees' },
};

function canSend(rule) {
  if (!rule || !rule.enabled) return false;
  if (!rule.last_sent) return true;
  const cooldownSec = (rule.cooldown_minutes ?? 30) * 60;
  return (Math.floor(Date.now() / 1000) - rule.last_sent) >= cooldownSec;
}

function dewPoint(tempC, rhPct) {
  if (tempC == null || rhPct == null) return null;
  return tempC - ((100 - rhPct) / 5);
}

// -- Polling evaluator --------------------------------------------------------

let _nodeList = null;
let _db       = null;

export function startAlertPoller(nodeList) {
  _nodeList = nodeList;
  _db       = db;
  setInterval(runPollingChecks, 60_000);
  setInterval(pruneExpiredTokens, 86_400_000);
}

function runPollingChecks() {
  checkNodeOffline();
  checkTempAndCondensation();
}

function checkNodeOffline() {
  const rule = getAlertRule('node_offline');
  if (!canSend(rule)) return;
  const thresholdSec = (rule.threshold ?? 30) * 60;
  const cutoff = Math.floor(Date.now() / 1000) - thresholdSec;
  const nodes = _nodeList?.nodes ?? [];
  const offline = nodes.filter(n => n.last_heard && n.last_heard < cutoff && n.user?.short_name);
  if (!offline.length) return;
  const names = offline.slice(0, 5).map(n => n.user.short_name).join(', ');
  const more  = offline.length > 5 ? ` (+${offline.length - 5} more)` : '';
  touchAlertLastSent('node_offline');
  sendAlert('node_offline',
    `[mesh] Node offline: ${names}${more}`,
    `${offline.length} node(s) not heard for >${rule.threshold} minutes:\n\n${offline.map(n =>
      `  ${n.user.short_name} — last heard ${new Date((n.last_heard || 0) * 1000).toLocaleString()}`
    ).join('\n')}`
  ).catch(e => console.error('[alerts] node_offline send failed:', e.message));
}

function checkTempAndCondensation() {
  if (!_db) return;
  const row = _db.prepare(
    `SELECT temperature, relative_humidity FROM environment_history ORDER BY ts DESC LIMIT 1`
  ).get();
  if (!row) return;
  const { temperature: t, relative_humidity: rh } = row;

  const tempRule = getAlertRule('temp_high');
  if (canSend(tempRule) && t != null && t >= (tempRule?.threshold ?? 50)) {
    touchAlertLastSent('temp_high');
    sendAlert('temp_high',
      `[mesh] Enclosure temp ${t.toFixed(1)}°C`,
      `Enclosure temperature is ${t.toFixed(1)}°C, exceeding threshold of ${tempRule.threshold}°C.\nHumidity: ${rh?.toFixed(1) ?? '?'}%`
    ).catch(e => console.error('[alerts] temp_high send failed:', e.message));
  }

  const condRule = getAlertRule('condensation');
  if (canSend(condRule) && t != null && rh != null) {
    const dp = dewPoint(t, rh);
    if (dp != null && (t - dp) <= (condRule?.threshold ?? 3)) {
      touchAlertLastSent('condensation');
      sendAlert('condensation',
        `[mesh] Condensation risk — dew point ${dp.toFixed(1)}°C / temp ${t.toFixed(1)}°C`,
        `Condensation risk: enclosure temperature ${t.toFixed(1)}°C is within ${(t - dp).toFixed(1)}°C of dew point (${dp.toFixed(1)}°C).\nHumidity: ${rh.toFixed(1)}%`
      ).catch(e => console.error('[alerts] condensation send failed:', e.message));
    }
  }
}

// -- Event-driven hooks -------------------------------------------------------

export function handleAlertEvent(ev) {
  try {
    _dispatchAlertEvent(ev);
  } catch (e) {
    console.error('[alerts] event dispatch error:', e.message);
  }
}

function _dispatchAlertEvent(ev) {
  if (ev.type === 'bridge_disconnected') {
    const rule = getAlertRule('ble_disconnect');
    if (!canSend(rule)) return;
    touchAlertLastSent('ble_disconnect');
    sendAlert('ble_disconnect',
      '[mesh] BLE disconnected',
      'The gateway lost its BLE connection to the radio. It will attempt to reconnect automatically.'
    ).catch(e => console.error('[alerts] ble_disconnect send failed:', e.message));
    return;
  }

  if (ev.type === 'tilt_update' && ev.data) {
    const rule = getAlertRule('tilt_high');
    if (!canSend(rule)) return;
    const cal   = getTiltCal();
    const pitch = (ev.data.pitch ?? 0) - (cal.zero?.pitch ?? 0);
    const roll  = (ev.data.roll  ?? 0) - (cal.zero?.roll  ?? 0);
    const tilt  = Math.max(Math.abs(pitch), Math.abs(roll));
    if (tilt < (rule?.threshold ?? 10)) return;
    touchAlertLastSent('tilt_high');
    sendAlert('tilt_high',
      `[mesh] Mast tilt ${tilt.toFixed(1)}°`,
      `Mast tilt detected: pitch ${pitch.toFixed(1)}°, roll ${roll.toFixed(1)}°.\nThreshold: ${rule.threshold}°`
    ).catch(e => console.error('[alerts] tilt_high send failed:', e.message));
    return;
  }

  if (ev.type === 'packet' && ev.data?.packet?.decoded?.portnum === 'TEXT_MESSAGE_APP') {
    const pkt  = ev.data.packet;
    const toNum = (pkt.to >>> 0);
    const isDm  = toNum !== BROADCAST_NUM;
    const hops  = (pkt.hop_start != null && pkt.hop_limit != null)
      ? Math.max(0, pkt.hop_start - pkt.hop_limit) : null;
    const text  = pkt.decoded?.payload
      ? Buffer.from(pkt.decoded.payload, 'base64').toString('utf8') : '';
    const fromShort = pkt.decoded?.user?.short_name || `!${(pkt.from >>> 0).toString(16).slice(-4).toUpperCase()}`;
    const pktId = pkt.id ?? null;

    if (isDm) {
      const rule = getAlertRule('dm_received');
      if (!canSend(rule)) return;
      if (pktId != null && isPacketAlerted(pktId)) return;
      touchAlertLastSent('dm_received');
      markPacketAlerted(pktId);
      const token = randomUUID();
      createReplyToken(token, ev.device, pkt.from >>> 0, pktId, pkt.channel ?? 0);
      sendAlert('dm_received',
        `[mesh] DM from ${fromShort} [reply:${token}]`,
        `Direct message from ${fromShort}:\n\n  "${text}"\n\nReply by replying to this email (keep the subject line intact).`,
        { replyToken: token }
      ).catch(e => console.error('[alerts] dm_received send failed:', e.message));
      return;
    }

    if (!isDm && hops === 0) {
      const rule = getAlertRule('broadcast_direct');
      if (!canSend(rule)) return;
      if (pktId != null && isPacketAlerted(pktId)) return;
      touchAlertLastSent('broadcast_direct');
      markPacketAlerted(pktId);
      const token = randomUUID();
      createReplyToken(token, ev.device, BROADCAST_NUM, pktId, pkt.channel ?? 0);
      sendAlert('broadcast_direct',
        `[mesh] Direct broadcast from ${fromShort} [reply:${token}]`,
        `0-hop broadcast from ${fromShort}:\n\n  "${text}"\n\nReply by replying to this email (keep the subject line intact).`,
        { replyToken: token }
      ).catch(e => console.error('[alerts] broadcast_direct send failed:', e.message));
    }
  }
}
