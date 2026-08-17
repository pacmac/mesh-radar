import { Router } from 'express';
import { stmts } from './db.js';

const router = Router();

// POST /:nodeId/traceroute — REMOVED 2026-08-17, task `traceroute-callers-rewrite`.
//
// Peter: "no re-implementation logic will be decided until all existing calls to
// it are completely removed from code. then we will decide how it will work."
//
// This route held BOTH dispatch paths — the V2 `traceroute.run()` call and a V1
// legacy `bridge.post('/{sender}/traceroute')` that bypassed the module
// entirely. Both are gone. `src/traceroute.js` itself is untouched: what was
// wrong was who called it and how they decided the radio and the aim, not how a
// traceroute is dispatched and recorded.
//
// NOTHING IN node-dash NOW DISPATCHES A TRACEROUTE. That is the intended state
// until the replacement is designed, on a clean tree, as its own task.
//
// Two browser callers used to reach this route and are removed with it:
//   public/app-perf.js     the per-radio RF measurement button
//   public/app-radar.js    the radar's trace action
//
// The history GET below is untouched — it READS, and existing rows stay
// readable. They simply stop being added to.

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
