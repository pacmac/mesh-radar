import { Router } from 'express';
import { stmts, syncAlertedAt } from './db.js';
import { nodeList } from './node-list.js';
import { getLiveNodeIdByMac, getLiveMacByNodeId } from './ws-relay.js';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8001';

const router = Router();

router.post('/:nodeId/messages', async (req, res) => {
  const nodeId = req.params.nodeId;
  // Resolve to live !hexid — nodeId may be a BLE MAC when the live node_id is not yet known.
  // parseInt on a raw MAC (e.g. "E9:B0:3F:17:27:91") only reads the first byte (0xE9=233).
  const resolvedId = nodeId.startsWith('!') ? nodeId : (getLiveNodeIdByMac(nodeId) || nodeId);
  const fromNum = resolvedId.startsWith('!') ? (parseInt(resolvedId.slice(1), 16) || 0) : 0;
  try {
    const upstream = await fetch(`${BRIDGE_URL}/${nodeId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const text = await upstream.text();
    res.status(upstream.status).type('application/json').send(text);
    if (!upstream.ok) return;
    let result;
    try {
      result = JSON.parse(text);
      if (!result?.id) return;
      // Store our own sent message so reply threading survives page reload.
      const BROADCAST_NUM = 0xffffffff;
      const toNum = (req.body.to ?? BROADCAST_NUM) >>> 0;
      const node = nodeList._cache?.get(fromNum);
      stmts.insertTxMessage.run({
        ts:          Math.floor(Date.now() / 1000),
        from_num:    fromNum,
        to_num:      toNum,
        text:        req.body.text ?? '',
        channel:     req.body.channel ?? 0,
        is_dm:       toNum !== BROADCAST_NUM ? 1 : 0,
        hop_limit:   null,
        snr:         null,
        rssi:        null,
        packet_id:   result.id,
        reply_id:    req.body.reply_id ?? null,
        // Phase B: messages.device is MAC vocabulary (matches the RX path,
        // keeps the (packet_id, device) dedup index single-vocabulary)
        device:      nodeId.includes(':') ? nodeId.toUpperCase() : (getLiveMacByNodeId(resolvedId) ?? nodeId),
        replay:      0,
        hops:        0,
        short_name:  node?.user?.short_name ?? null,
        long_name:   node?.user?.long_name  ?? null,
        message_key: 't-' + result.id,
      });
      syncAlertedAt(result.id);
    } catch (persistErr) {
      console.error('[messages] post-send persistence error, packet_id:', result?.id, persistErr.message);
    }
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

export default router;
