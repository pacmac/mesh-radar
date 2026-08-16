// The single place that transmits an outbound mesh text AND records it.
//
// Every sender routes through sendMeshText() so no send can bypass the message
// log. See docs/modules/mesh-send.md.

import { stmts, syncAlertedAt } from './db.js';
import { nodeList } from './node-list.js';
import { getLiveNodeIdByMac, getLiveMacByNodeId, broadcastMessageHistory } from './ws-relay.js';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8001';
const BROADCAST_NUM = 0xffffffff;

// Record an outbound send. Mirrors what messages-api did inline: device is MAC
// vocabulary (matches the RX path + the (packet_id, device) dedup index), the
// key is 't-<id>' so a later re-heard 'r-<id>' row groups by packet_id in the
// feed rather than duplicating.
function recordOutbound({ gatewayNodeId, text, channel, to, reply_id, category, packetId }) {
  const resolvedId = String(gatewayNodeId).startsWith('!')
    ? gatewayNodeId : (getLiveNodeIdByMac(gatewayNodeId) || gatewayNodeId);
  const fromNum = String(resolvedId).startsWith('!') ? (parseInt(resolvedId.slice(1), 16) || 0) : 0;
  const toNum   = (to ?? BROADCAST_NUM) >>> 0;
  const node    = nodeList._cache?.get(fromNum);
  stmts.insertTxMessage.run({
    ts:          Math.floor(Date.now() / 1000),
    from_num:    fromNum,
    to_num:      toNum,
    text:        text ?? '',
    // No `?? 0` — sendMeshText refuses an unstated channel before it gets here,
    // so by this point it is always an integer the caller chose on purpose.
    channel,
    is_dm:       toNum !== BROADCAST_NUM ? 1 : 0,
    hop_limit:   null,
    snr:         null,
    rssi:        null,
    packet_id:   packetId,
    reply_id:    reply_id ?? null,
    device:      String(gatewayNodeId).includes(':') ? gatewayNodeId.toUpperCase() : (getLiveMacByNodeId(resolvedId) ?? gatewayNodeId),
    replay:      0,
    hops:        0,
    short_name:  node?.user?.short_name ?? null,
    long_name:   node?.user?.long_name  ?? null,
    message_key: 't-' + packetId,
    category:    category ?? null,
  });
  syncAlertedAt(packetId);
  // A radio never hears its own TX — push the fresh history so every connected
  // session sees the sent message live.
  broadcastMessageHistory();
}

// Transmit `text` from `gatewayNodeId` and record it. Throws on a gateway error
// (a send that failed must not appear as sent). Returns the gw result { id, to }.
export async function sendMeshText({ gatewayNodeId, text, channel, to = null, reply_id = null, category = null }) {
  // A SEND THAT DOES NOT NAME ITS CHANNEL IS REFUSED.
  //
  // This was `const body = { text, channel }` with no check, and JSON.stringify
  // DROPS an undefined key — so a caller who forgot the argument sent a body with
  // no channel at all and the gateway applied its own default of 0. Zero is a
  // PRIMARY, which is the public mesh. The failure mode was: omit an argument,
  // broadcast to strangers, and record it as a normal send.
  //
  // This module does not RESOLVE the channel — that is channels.js's job,
  // indexFor(radio, 'pub'|'pri'). It only refuses to guess. Keeping the two apart
  // is what lets the resolver's data source change without touching this path.
  //
  // 0 stays perfectly legal when a caller MEANS it (callout transmits publicly on
  // purpose). The rule is that it must be stated, not that it must be non-zero.
  if (!Number.isInteger(channel)) {
    throw new Error(`channel required: sendMeshText got ${JSON.stringify(channel)} — resolve it with channels.indexFor(radio, 'pub'|'pri')`);
  }
  const body = { text, channel };
  if (to != null)       body.to = to;
  if (reply_id != null) body.reply_id = reply_id;

  const r = await fetch(`${BRIDGE_URL}/${gatewayNodeId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`gateway ${r.status}`);
  const result = await r.json();

  if (result?.id) {
    try { recordOutbound({ gatewayNodeId, text, channel, to, reply_id, category, packetId: result.id }); }
    catch (e) { console.error('[mesh-send] record failed, packet_id:', result.id, e.message); }
  }
  return result;
}
