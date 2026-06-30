import { Router } from 'express';
import { queryRangeTestLog, clearRangeTestLog } from './db.js';
import { resolveNodeLabel, resolveDeviceLabel } from './node-label.js';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8001';

let _rangeTimer = { active: false, endsAt: null, nodeId: null };
let _rangeTimerHandle = null;

async function _bridgePutRangeTest(nodeId, enabled) {
  const body = enabled ? { enabled: true, sender: 60 } : { enabled: false, sender: 0 };
  await fetch(`${BRIDGE_URL}/${nodeId}/config/range_test`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function getRangeTimer() {
  const remaining = _rangeTimer.endsAt ? Math.max(0, Math.round((_rangeTimer.endsAt - Date.now()) / 1000)) : null;
  return { ..._rangeTimer, remaining };
}

const router = Router();

router.get('/log', (req, res) => {
  const limit = parseInt(req.query.limit) || 500;
  const rows = queryRangeTestLog(limit).map(r => ({
    ...r,
    from_name: resolveNodeLabel(r.from_num),
    rx_name:   resolveDeviceLabel(r.rx_device),
  }));
  res.json({ log: rows, count: rows.length });
});

router.delete('/log', (req, res) => {
  clearRangeTestLog();
  res.json({ cleared: true });
});

router.get('/timer', (req, res) => {
  res.json(getRangeTimer());
});

router.post('/start', async (req, res) => {
  const { nodeId, durationMin } = req.body;
  if (!nodeId) return res.status(400).json({ error: 'nodeId required' });
  const duration = Math.max(1, parseInt(durationMin) || 10);
  if (_rangeTimerHandle) { clearTimeout(_rangeTimerHandle); _rangeTimerHandle = null; }
  try {
    await _bridgePutRangeTest(nodeId, true);
  } catch (err) {
    return res.status(502).json({ error: 'bridge: ' + err.message });
  }
  const endsAt = Date.now() + duration * 60 * 1000;
  _rangeTimer = { active: true, endsAt, nodeId };
  _rangeTimerHandle = setTimeout(async () => {
    try { await _bridgePutRangeTest(nodeId, false); } catch (e) { console.error('[range_test] auto-disable failed:', e.message); }
    _rangeTimer = { active: false, endsAt: null, nodeId: null };
    _rangeTimerHandle = null;
  }, duration * 60 * 1000);
  res.json({ started: true, endsAt, nodeId, durationMin: duration });
});

router.post('/stop', async (req, res) => {
  const nodeId = _rangeTimer.nodeId || req.body?.nodeId;
  if (_rangeTimerHandle) { clearTimeout(_rangeTimerHandle); _rangeTimerHandle = null; }
  _rangeTimer = { active: false, endsAt: null, nodeId: null };
  if (nodeId) {
    try { await _bridgePutRangeTest(nodeId, false); } catch (err) { return res.status(502).json({ error: 'bridge: ' + err.message }); }
  }
  res.json({ stopped: true });
});

export default router;
