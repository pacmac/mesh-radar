import { Router } from 'express';
import { sendMeshText } from './mesh-send.js';

const router = Router();

// Human chat send. Routes through the shared send path (POST + record), which is
// the one place outbound messages are logged. Category 'chat'.
router.post('/:nodeId/messages', async (req, res) => {
  const nodeId = req.params.nodeId;

  // NO DEFAULT CHANNEL. This was `req.body.channel ?? 0`, so a request that
  // omitted the field went out on the PUBLIC MESH. The browser form always sends
  // it, which is exactly what made the default dangerous — it could only ever
  // fire for a caller that had forgotten, and the penalty for forgetting was a
  // public broadcast. There is no safe default for "which channel"; the honest
  // answer to an unstated one is to refuse. Task `channel-callers-onto-resolver`.
  const channel = req.body?.channel;
  if (!Number.isInteger(channel)) {
    return res.status(400).json({
      error: 'channel required — an unstated channel would default to the public mesh',
    });
  }

  try {
    const result = await sendMeshText({
      gatewayNodeId: nodeId,
      text:     req.body.text ?? '',
      channel,
      to:       req.body.to ?? null,
      reply_id: req.body.reply_id ?? null,
      category: 'chat',
    });
    res.json(result);
  } catch (err) {
    // sendMeshText throws 'gateway <status>' on an upstream error.
    const m = /gateway (\d+)/.exec(err.message);
    if (m) return res.status(Number(m[1])).json({ error: err.message });
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
});

export default router;
