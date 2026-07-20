import { Router } from 'express';
import { sendMeshText } from './mesh-send.js';

const router = Router();

// Human chat send. Routes through the shared send path (POST + record), which is
// the one place outbound messages are logged. Category 'chat'.
router.post('/:nodeId/messages', async (req, res) => {
  const nodeId = req.params.nodeId;
  try {
    const result = await sendMeshText({
      gatewayNodeId: nodeId,
      text:     req.body.text ?? '',
      channel:  req.body.channel ?? 0,
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
