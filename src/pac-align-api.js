// Antenna-alignment actions for pac-host's align session — the browser's one
// sanctioned write path for Yagi Align (target/n/replyWindowSec are the only
// node-dash-originated values; everything else is pac-host's view-model,
// pushed over WS by pac-host.js, never fetched here). See docs/modules/pac-host.md.

import { Router } from 'express';
import { alignPing, alignStop, alignConfig } from './pac-host.js';

const router = Router();

// POST /align/ping  { target, n? }
// target is a raw node num (API.md "Antenna alignment") — no !hex conversion,
// unlike commands. n is 1-5; pac-host defaults it when omitted.
router.post('/align/ping', async (req, res) => {
  const target = Number(req.body?.target);
  if (!Number.isInteger(target)) {
    return res.status(400).json({ error: 'target (node num) required' });
  }
  const n = req.body?.n !== undefined ? Number(req.body.n) : undefined;
  try {
    res.json(await alignPing({ target, n }));
  } catch (err) {
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

// POST /align/stop
router.post('/align/stop', async (_req, res) => {
  try {
    res.json(await alignStop());
  } catch (err) {
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

// POST /align/config  { replyWindowSec }  (5-120, server-validated)
router.post('/align/config', async (req, res) => {
  const replyWindowSec = Number(req.body?.replyWindowSec);
  if (!Number.isFinite(replyWindowSec)) {
    return res.status(400).json({ error: 'replyWindowSec required' });
  }
  try {
    res.json(await alignConfig({ replyWindowSec }));
  } catch (err) {
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

// NOTE: deliberately no GET route here — the view-model is page data
// (BROWSER_CONTRACT): pac-host.js polls GET /mesh/align and pushes
// pac_host_align over WS, replayed on connect, broadcast on change. Same
// invariant as pac-command-api.js's queue ledger — do not add one.

export default router;
