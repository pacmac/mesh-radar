// Remote configure/command for pac-host units — the command-channel counterpart
// to messages-api's chat send, but routed through pac-host's queue instead of a
// direct mesh-gw send. See docs/modules/pac-host.md.

import { Router } from 'express';
import { queueCommand } from './pac-host.js';
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

// NOTE: deliberately no GET route here. Queue/receipt data is page data —
// BROWSER_CONTRACT: it arrives over WS only (pac-host.js polls + pushes
// pac_host_queues, replayed on connect, broadcast on change). A GET route for
// this was here briefly and was a real bug (Peter, 2026-07-25): the browser
// fetched it on click, which is not real-time and not permitted. Do not
// re-add it — see docs/modules/pac-command-api.md.

export default router;
