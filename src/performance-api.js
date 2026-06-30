import { Router } from 'express';
import { queryTiltHistory, markTiltNcal, queryEnvHistory, getTiltCal, saveTiltCal } from './db.js';

export function createPerformanceRouter(broadcastAll) {
  const router = Router();

  router.get('/tilt_history', (req, res) => {
    const nodeId = req.query.node_id || '';
    const hours  = parseFloat(req.query.hours) || 4;
    const since  = Math.floor(Date.now() / 1000) - hours * 3600;
    res.json(queryTiltHistory(nodeId, since));
  });

  router.post('/tilt_history/ncal', (req, res) => {
    const { node_id, ts, window_sec = 90 } = req.body;
    if (!node_id || ts == null) return res.status(400).json({ error: 'node_id and ts required' });
    const changed = markTiltNcal(node_id, ts - window_sec, ts + window_sec);
    res.json({ marked: changed });
  });

  router.get('/env_history', (req, res) => {
    const num   = parseInt(req.query.num) || 0;
    const hours = parseFloat(req.query.hours) || 24;
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    res.json(queryEnvHistory(num, since));
  });

  router.get('/tilt_cal', (_req, res) => {
    res.json(getTiltCal());
  });

  router.put('/tilt_cal', (req, res) => {
    const body = req.body;
    saveTiltCal({
      zero:        'zero'        in body ? (body.zero        ?? null) : undefined,
      north_angle: 'north_angle' in body ? (body.north_angle ?? null) : undefined,
    });
    const cal = getTiltCal();
    broadcastAll({ type: 'tilt_cal', zero: cal.zero, north_angle: cal.north_angle });
    res.json({ ok: true });
  });

  return router;
}
