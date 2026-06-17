import { Router } from 'express';
import { getConfig, setConfig, getConfigByPrefix } from './db.js';

const router = Router();
const PREFIX = 'device_cfg.';

const DEFAULT = {
  label:         null,   // display label: OMNI, YAGI, Y, O, etc.
  is_rotator:    false,  // this radio is physically on the rotator
  is_primary:    false,  // this radio drives the Overview tab / status display
  antenna_type:  null,   // text description e.g. "DL6WU 5el Yagi"
  beam_deg:      360,    // beam width in degrees (360 = omni)
  gain_dbi:      0,      // antenna gain in dBi
  cable_loss_db: 0,      // cable loss in dB
};

export function getDeviceCfg(nodeId) {
  return { ...DEFAULT, ...getConfig(PREFIX + nodeId, {}) };
}

export function getAllDeviceCfgs() {
  return getConfigByPrefix(PREFIX);
}

export function getRotatorDeviceId() {
  const all = getConfigByPrefix(PREFIX);
  for (const [nodeId, cfg] of Object.entries(all)) {
    if (cfg?.is_rotator) return nodeId;
  }
  return null;
}

export function getPrimaryDeviceId() {
  const all = getConfigByPrefix(PREFIX);
  for (const [nodeId, cfg] of Object.entries(all)) {
    if (cfg?.is_primary) return nodeId;
  }
  return null;
}

// GET /device-config  →  all per-device configs keyed by node_id
router.get('/', (req, res) => {
  res.json(getAllDeviceCfgs());
});

// GET /device-config/:nodeId
router.get('/:nodeId', (req, res) => {
  res.json(getDeviceCfg(req.params.nodeId));
});

// PUT /device-config/:nodeId  body: { label?, is_rotator?, is_primary? }
router.put('/:nodeId', (req, res) => {
  const nodeId = req.params.nodeId;
  const existing = getDeviceCfg(nodeId);
  const updated = { ...existing };

  const { label, is_rotator, is_primary, antenna_type, beam_deg, gain_dbi, cable_loss_db } = req.body;
  if (label !== undefined)         updated.label         = label || null;
  if (is_rotator !== undefined)    updated.is_rotator    = !!is_rotator;
  if (antenna_type !== undefined)  updated.antenna_type  = antenna_type || null;
  if (beam_deg !== undefined)      updated.beam_deg      = Number(beam_deg) || 360;
  if (gain_dbi !== undefined)      updated.gain_dbi      = Number(gain_dbi) || 0;
  if (cable_loss_db !== undefined) updated.cable_loss_db = Number(cable_loss_db) || 0;

  if (is_primary !== undefined) {
    if (is_primary) {
      // clear primary from all other devices first
      const all = getAllDeviceCfgs();
      for (const [id, cfg] of Object.entries(all)) {
        if (id !== nodeId && cfg?.is_primary) {
          setConfig(PREFIX + id, { ...cfg, is_primary: false });
        }
      }
    }
    updated.is_primary = !!is_primary;
  }

  setConfig(PREFIX + nodeId, updated);
  res.json(updated);
});

export default router;
