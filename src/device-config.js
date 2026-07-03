import { Router } from 'express';
import { getConfig, setConfig, deleteConfig, getConfigByPrefix } from './db.js';
import { pokeDeviceList } from './ws-relay.js';

const router = Router();
const PREFIX = 'device_cfg.';


let _onHomePosChange = null;
export function onHomePosChange(cb) { _onHomePosChange = cb; }

let _nodeIdToMac = null;
export function registerNodeIdToMacResolver(fn) { _nodeIdToMac = fn; }

let _macToNodeId = null;
export function registerMacToNodeIdResolver(fn) { _macToNodeId = fn; }

export function resolvePrimaryNodeId() {
  const mac = getPrimaryMac();
  if (!mac) return null;
  return _macToNodeId?.(mac) || mac;
}

const DEFAULT = {
  label:               null,   // display label: OMNI, YAGI, Y, O, etc.
  is_rotator:          false,  // this radio is physically on the rotator
  is_primary:          false,  // this radio drives the Overview tab / status display
  load_nodes_on_boot:  false,  // pre-load node list when bridge connects (slow; disable for dev)
  antenna_type:        null,   // text description e.g. "DL6WU 5el Yagi"
  beam_deg:            360,    // beam width in degrees (360 = omni)
  gain_dbi:            0,      // antenna gain in dBi
  cable_loss_db:       0,      // cable loss in dB
  fixed_lat:           null,   // fallback home position latitude (decimal degrees)
  fixed_lon:           null,   // fallback home position longitude (decimal degrees)
  color:               null,   // DaisyUI theme color for badges/radar
  ble_pin:             null,   // BLE pairing PIN — SSOT here. paired status = bleak_db SSOT, never stored here.
};

// Key is always uppercase MAC address e.g. "E9:B0:3F:17:27:91"
export function getDeviceCfg(address) {
  return { ...DEFAULT, ...getConfig(PREFIX + address.toUpperCase(), {}) };
}

// Returns { [MAC]: cfg }
export function getAllDeviceCfgs() {
  return getConfigByPrefix(PREFIX);
}

// Returns the BLE MAC address of the primary device.
export function getPrimaryMac() {
  for (const [mac, cfg] of Object.entries(getConfigByPrefix(PREFIX))) {
    if (cfg?.is_primary) return mac;
  }
  return null;
}

// Returns MAC address of the rotator device (for device identity comparisons).
export function getRotatorAddress() {
  for (const [mac, cfg] of Object.entries(getConfigByPrefix(PREFIX))) {
    if (cfg?.is_rotator) return mac;
  }
  return null;
}

// Called from ws-relay when a device appears. Migrates any legacy device_cfg.!hexid
// entry to the canonical MAC key using the exact live node ID. If the live node ID
// is absent or has no legacy entry, migration is deferred and an empty entry is
// bootstrapped. No identity is ever inferred from MAC-suffix arithmetic.
export function ensureDeviceCfgMac(addr, nodeId) {
  const mac = addr.toUpperCase();
  const all = getConfigByPrefix(PREFIX);

  if (nodeId && nodeId in all) {
    // Exact live pair known: migrate legacy !hexid entry to MAC key.
    setConfig(PREFIX + mac, all[nodeId]);
    deleteConfig(PREFIX + nodeId);
  } else if (getConfig(PREFIX + mac, null) === null) {
    // No exact pair available: defer migration, bootstrap empty entry only.
    setConfig(PREFIX + mac, { ...DEFAULT });
  }
}

// GET /device-config  →  all configs keyed by MAC address
router.get('/', (req, res) => {
  res.json(getAllDeviceCfgs());
});

// GET /device-config/:address  (MAC or !hexid)
router.get('/:address', (req, res) => {
  const raw = req.params.address;
  if (raw.startsWith('!')) {
    const mac = _nodeIdToMac?.(raw);
    if (mac) return res.json(getDeviceCfg(mac));
    // Device not currently live — read legacy !hexid key directly if present.
    const stored = getConfig(PREFIX + raw, null);
    return res.json(stored ? { ...DEFAULT, ...stored } : { ...DEFAULT });
  }
  res.json(getDeviceCfg(raw));
});

// PUT /device-config/:address  (MAC or !hexid)
router.put('/:address', (req, res) => {
  const raw = req.params.address;
  let mac;
  if (raw.startsWith('!')) {
    mac = _nodeIdToMac?.(raw);
    if (!mac) return res.status(404).json({ error: `Device ${raw} is not currently live` });
    // Migrate any legacy !hexid-keyed entry to MAC on first write.
    const legacy = getConfig(PREFIX + raw, null);
    if (legacy !== null) {
      if (getConfig(PREFIX + mac, null) === null) setConfig(PREFIX + mac, legacy);
      deleteConfig(PREFIX + raw);
    }
  } else {
    mac = raw.toUpperCase();
  }

  const existing = getDeviceCfg(mac);
  const updated = { ...existing };

  const {
    label, is_rotator, is_primary, load_nodes_on_boot,
    antenna_type, beam_deg, gain_dbi, cable_loss_db,
    fixed_lat, fixed_lon, color, ble_pin,
  } = req.body;

  if (label !== undefined)               updated.label               = label || null;
  if (is_rotator !== undefined)          updated.is_rotator          = !!is_rotator;
  if (load_nodes_on_boot !== undefined)  updated.load_nodes_on_boot  = !!load_nodes_on_boot;
  if (antenna_type !== undefined)        updated.antenna_type        = antenna_type || null;
  if (beam_deg !== undefined)            updated.beam_deg            = Number(beam_deg) || 360;
  if (gain_dbi !== undefined)            updated.gain_dbi            = Number(gain_dbi) || 0;
  if (cable_loss_db !== undefined)       updated.cable_loss_db       = Number(cable_loss_db) || 0;
  if (ble_pin !== undefined)             updated.ble_pin             = ble_pin || null;

  const homePosChanged = (fixed_lat !== undefined || fixed_lon !== undefined);
  if (fixed_lat !== undefined) updated.fixed_lat = fixed_lat != null && fixed_lat !== '' ? Number(fixed_lat) : null;
  if (fixed_lon !== undefined) updated.fixed_lon = fixed_lon != null && fixed_lon !== '' ? Number(fixed_lon) : null;
  if (color !== undefined)     updated.color     = color || null;

  if (is_primary !== undefined) {
    if (is_primary) {
      for (const [id, cfg] of Object.entries(getAllDeviceCfgs())) {
        if (id !== mac && cfg?.is_primary) {
          setConfig(PREFIX + id, { ...cfg, is_primary: false });
        }
      }
    }
    updated.is_primary = !!is_primary;
  }

  setConfig(PREFIX + mac, updated);
  if (homePosChanged && updated.is_primary) _onHomePosChange?.();
  // device_list carries per-device cfg (C2) — push the fresh settings
  pokeDeviceList();
  res.json(updated);
});

export default router;
