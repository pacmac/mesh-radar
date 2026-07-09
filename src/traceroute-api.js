import { Router } from 'express';
import { bridge } from './bridge.js';
import { traceroute } from './traceroute.js';
import { stmts } from './db.js';
import { dashMode, transmitterForMode } from './dash-mode.js';
import { FF } from './feature-flags.js';

const router = Router();

router.post('/:nodeId/traceroute', async (req, res) => {
  const targetNum = parseInt((req.params.nodeId || '').replace('!', ''), 16);
  if (!targetNum) return res.status(400).json({ error: 'invalid nodeId' });
  // Optional { via } — dispatch through a specific radio so its RF chain
  // gets measured (per-device performance). Accepts a BLE MAC (the perf
  // page's vocabulary since Phase B) or a !hex node id. Default: primary.
  const via = typeof req.body?.via === 'string' &&
    (/^![0-9a-f]{8}$/i.test(req.body.via) || /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(req.body.via))
    ? req.body.via : null;
  const sender = via ?? transmitterForMode(dashMode.value);
  if (!sender) return res.status(503).json({ error: 'no primary device configured' });
  try {
    // ── [V1] LEGACY — remove when SSOT_TRACEROUTE verified ────────────────
    if (!FF.SSOT_TRACEROUTE) {
      const result = await bridge.post(`/${sender}/traceroute`, { to: targetNum });
      res.json(result);
    // ── [V2] SSOT — traceroute.js owns dispatch ────────────────────────────
    } else {
      const result = await traceroute.dispatch({ to: targetNum, device: sender });
      res.json(result);
    }
    // ───────────────────────────────────────────────────────────────────────
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/traceroute_history', (req, res) => {
  const to_num = req.query.to_num ? parseInt(req.query.to_num) : null;
  const limit  = Math.min(parseInt(req.query.limit ?? 200), 1000);
  const device = typeof req.query.device === 'string' && req.query.device ? req.query.device : null;
  try {
    const rows = device
      ? stmts.queryTracerouteHistoryByDevice.all({ device, limit })
      : stmts.queryTracerouteHistory.all({ to_num, limit });
    res.json(rows.map(r => ({
      ...r,
      route:           JSON.parse(r.route           || '[]'),
      route_back:      JSON.parse(r.route_back      || '[]'),
      snr_towards:     JSON.parse(r.snr_towards     || '[]'),
      snr_back:        JSON.parse(r.snr_back        || '[]'),
      relay_positions: JSON.parse(r.relay_positions || '{}'),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
