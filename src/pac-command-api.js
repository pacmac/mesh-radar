// Remote configure/command for pac-host units — the command-channel counterpart
// to messages-api's chat send, but routed through pac-host's queue instead of a
// direct mesh-gw send. See docs/modules/pac-host.md.

import { Router } from 'express';
import { queueCommand, getQueue } from './pac-host.js';
import { numToNodeId } from './utils.js';

const router = Router();

// POST /nodes/:num/pac-command  { verb, args? }
// node-dash resolves the node num to pac-host's !hex unit id; verb/args pass
// through untouched — no mesh mechanics on this side (API.md §6.1/§8).
router.post('/nodes/:num/pac-command', async (req, res) => {
  const num = Number(req.params.num);
  const verb = (req.body?.verb ?? '').trim();
  if (!Number.isInteger(num) || !verb) {
    return res.status(400).json({ error: 'num and a non-empty verb required' });
  }
  try {
    const result = await queueCommand({ unit: numToNodeId(num), verb, args: req.body?.args });
    res.json(result);
  } catch (err) {
    const status = err.status ?? 502;
    res.status(status).json({ error: err.message });
  }
});

// GET /nodes/:num/pac-command — receipt polling: that unit's queue ledger.
router.get('/nodes/:num/pac-command', async (req, res) => {
  const num = Number(req.params.num);
  if (!Number.isInteger(num)) return res.status(400).json({ error: 'invalid num' });
  try {
    const ledger = await getQueue(numToNodeId(num));
    res.json(ledger);
  } catch (err) {
    const status = err.status ?? 502;
    res.status(status).json({ error: err.message });
  }
});

export default router;
