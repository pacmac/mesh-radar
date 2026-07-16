import { Router } from 'express';
import { getConfig, setConfig, deleteConfig, getConfigByPrefix } from './db.js';
import { pokeDeviceList } from './ws-relay.js';
import { bridge } from './bridge.js';

let _broadcastAll = () => {};

async function runAutoPurge(nodeId) {
  console.log(`[auto-purge] wiping nodedb on ${nodeId}`);
  try {
    const result = await bridge.post(`/${nodeId}/purge_nodedb`, {});
    const nodeCount = result?.node_count ?? null;
    if (nodeCount !== null && nodeCount > 1) {
      console.warn(`[auto-purge] ${nodeId}: purge complete but node_count=${nodeCount} (expected 1)`);
    }
    const ts = Math.floor(Date.now() / 1000);
    setConfig(`auto_purge_last_run_ts_${nodeId}`, ts);
    _broadcastAll({ type: 'auto_purge_complete', device: nodeId, ts, node_count: nodeCount });
    console.log(`[auto-purge] done — node_count=${nodeCount}`);
  } catch (e) {
    console.error(`[auto-purge] failed on ${nodeId}:`, e.message);
    _broadcastAll({ type: 'auto_purge_error', device: nodeId, error: e.message });
  }
}

export function startAutoPurgeScheduler(broadcastAll) {
  _broadcastAll = broadcastAll;
  setInterval(() => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const today = now.toDateString();
    const enabled = getConfigByPrefix('auto_purge_enabled_');
    for (const [nodeId, isEnabled] of Object.entries(enabled)) {
      if (!isEnabled) continue;
      const purgeTime = getConfig(`auto_purge_time_${nodeId}`, '02:00');
      if (hhmm !== purgeTime) continue;
      const lastRun = getConfig(`auto_purge_last_run_ts_${nodeId}`, null);
      const lastRunDate = lastRun ? new Date(lastRun * 1000).toDateString() : null;
      if (lastRunDate === today) continue;
      runAutoPurge(nodeId);
    }
  }, 60 * 1000);
}

const router = Router();


// Purge settings for a device key — rides the WS device_list (settings-via-ws).
// Legacy keys were written with whatever id the browser sent (historically !hex).
export function getAutoPurgeCfg(key) {
  if (!key) return null;
  return {
    enabled:     getConfig(`auto_purge_enabled_${key}`, false),
    purge_time:  getConfig(`auto_purge_time_${key}`, '02:00'),
    last_run_ts: getConfig(`auto_purge_last_run_ts_${key}`, null),
  };
}

// Removes all purge rows for a device key (node_id or MAC) — device-remove-op.
export function removeAutoPurgeCfg(key) {
  if (!key) return;
  deleteConfig(`auto_purge_enabled_${key}`);
  deleteConfig(`auto_purge_time_${key}`);
  deleteConfig(`auto_purge_last_run_ts_${key}`);
}

router.get('/auto-purge', (req, res) => {
  const nodeId = req.query.device;
  if (!nodeId) return res.status(400).json({ error: 'device required' });
  res.json({
    enabled:     getConfig(`auto_purge_enabled_${nodeId}`, false),
    purge_time:  getConfig(`auto_purge_time_${nodeId}`, '02:00'),
    last_run_ts: getConfig(`auto_purge_last_run_ts_${nodeId}`, null),
  });
});

router.put('/auto-purge', (req, res) => {
  const { device: nodeId, enabled, purge_time } = req.body;
  if (!nodeId) return res.status(400).json({ error: 'device required' });
  setConfig(`auto_purge_enabled_${nodeId}`, !!enabled);
  if (purge_time && /^\d{2}:\d{2}$/.test(purge_time)) setConfig(`auto_purge_time_${nodeId}`, purge_time);
  res.json({ ok: true });
  pokeDeviceList();
});

router.post('/purge-nodedb', async (req, res) => {
  const { device: nodeId } = req.body;
  if (!nodeId) return res.status(400).json({ error: 'device required' });
  try {
    const result = await bridge.post(`/${nodeId}/purge_nodedb`, {});
    const nodeCount = result?.node_count ?? null;
    const ts = Math.floor(Date.now() / 1000);
    setConfig(`auto_purge_last_run_ts_${nodeId}`, ts);
    _broadcastAll({ type: 'auto_purge_complete', device: nodeId, ts, node_count: nodeCount });
    res.json({ ok: true, node_count: nodeCount });
  } catch (e) {
    _broadcastAll({ type: 'auto_purge_error', device: nodeId, error: e.message });
    res.status(500).json({ error: e.message });
  }
});

export default router;
