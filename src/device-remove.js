// The ONE device-removal operation (task device-remove-op).
// gw DELETE /ble/known/{addr} is the complete gateway-side removal (disconnect
// + drop from bridge_config.yaml + BlueZ un-bond, docs/gw/API_REST.md §Forget);
// this endpoint composes it with the node-dash cleanup that never existed:
// device_cfg rows, auto_purge rows, node_mac registry, ws-relay in-memory state.
import { Router } from 'express';
import { bridge } from './bridge.js';
import { deleteConfig } from './db.js';
import { deleteDeviceCfg } from './device-config.js';
import { removeAutoPurgeCfg } from './auto-purge-api.js';
import { getLiveNodeIdByMac, pruneDevice } from './ws-relay.js';

const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const router = Router();

// DELETE /device/:mac → { removed, node_id, gw: 'removed' | 'already_gone' }
router.delete('/:mac', async (req, res) => {
  const mac = req.params.mac.toUpperCase();
  if (!MAC_RE.test(mac)) {
    return res.status(400).json({ error: `not a MAC address: ${req.params.mac}` });
  }

  // Gateway first. Local state is only cleaned when the gw no longer knows the
  // device — otherwise the next device_snapshot would resurrect a half-removed
  // device and the dash would stop mirroring the gw.
  let gw = 'removed';
  try {
    await bridge.delete(`/ble/known/${encodeURIComponent(mac)}`);
  } catch (err) {
    if (err.status !== 404) {
      return res.status(502).json({ error: `gateway remove failed: ${err.message}` });
    }
    gw = 'already_gone';
  }

  const nodeId = getLiveNodeIdByMac(mac);
  deleteDeviceCfg(mac);
  if (nodeId) {
    deleteDeviceCfg(nodeId);      // legacy !hexid-keyed cfg row, if any
    removeAutoPurgeCfg(nodeId);
  }
  removeAutoPurgeCfg(mac);        // rows keyed by MAC (mixed-keying legacy)
  deleteConfig('node_mac.' + mac);
  pruneDevice(mac, nodeId);       // in-memory prune + device_list rebroadcast

  console.log(`[device-remove] ${mac} removed (node_id=${nodeId ?? 'unknown'}, gw=${gw})`);
  res.json({ removed: mac, node_id: nodeId, gw });
});

export default router;
