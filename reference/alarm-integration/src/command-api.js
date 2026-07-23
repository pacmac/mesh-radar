// The addressed command/response send — the command-channel counterpart to the
// chat route (messages-api → Primary). Chats go on Primary; commands go on the
// Private/command channel, resolved BY NAME, never a body channel, never Primary.
// This is align's addressed-ping send generalized to any verb. See
// docs/modules/command-api.md.

import { Router } from 'express';
import { sendMeshText } from './mesh-send.js';
import { resolvePrimaryNodeId } from './device-config.js';
import { resolveCommandChannel } from './node-settings.js';
import { getDeviceChannelsByNodeId } from './ws-relay.js';
import { log } from './log.js';

const router = Router();

// Last 4 hex of the node num — the alarm's `@<suffix> <verb>` addressing grammar.
const hexSuffix = (num) => (Number(num) >>> 0).toString(16).padStart(8, '0').slice(-4);

// POST /nodes/:num/command  { command }
// The browser sends only the node + the verb (no addressing, no channel). The
// server addresses it (@suffix), resolves the Private channel by name, and sends
// it as a broadcast on Private. The response pairs back in the feed by reply_id.
router.post('/nodes/:num/command', async (req, res) => {
  const num = Number(req.params.num);
  const command = (req.body?.command ?? '').trim();
  if (!Number.isInteger(num) || !command) {
    return res.status(400).json({ error: 'num and a non-empty command required' });
  }

  const gatewayNodeId = resolvePrimaryNodeId();
  if (!gatewayNodeId) return res.status(503).json({ error: 'no gateway radio available to send from' });

  // Reused resolver (align/settings/chunk): the channel NAMED "Private", refusing
  // index 0. Never a body channel, never Primary.
  const ch = resolveCommandChannel(getDeviceChannelsByNodeId(gatewayNodeId));
  if (!ch.ok) return res.status(409).json({ error: ch.error });

  const suffix = hexSuffix(num);
  const text = `@${suffix} ${command}`;

  try {
    // Broadcast on Private with @suffix addressing (no `to` — a directed packet
    // fails PKI on the alarm). Recorded as category 'command' so it buckets to the
    // command feed; the reply threads under it by reply_id.
    const sent = await sendMeshText({
      gatewayNodeId,
      text,
      channel: ch.channel,
      category: 'command',
    });
    log.info('command', `@${suffix} "${command}" via ${gatewayNodeId} ch${ch.channel} (pkt ${sent?.id})`);
    res.json({ ok: true, state: 'sent', packet_id: sent?.id ?? null, channel: ch.channel, to: suffix });
  } catch (err) {
    // sendMeshText throws 'gateway <status>' on an upstream error.
    const m = /gateway (\d+)/.exec(err.message);
    if (m) return res.status(Number(m[1])).json({ error: err.message });
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

export default router;
