import { Router } from 'express';
import { getConfig, setConfig, deleteConfig, getConfigByPrefix } from './db.js';

const router = Router();
const PREFIX = 'device_cfg.';

// Derive !hexid node_id from BLE MAC address.
// Last 4 bytes of MAC = Meshtastic node number (verified on ESP32 + nRF52).
export function macToNodeId(mac) {
  return '!' + mac.replace(/:/g, '').slice(-8).toLowerCase();
}

// Inverse: derive the expected MAC suffix from a node_id for matching.
// Only the last 4 bytes are deterministic — the prefix bytes vary by hardware.
function nodeIdSuffix(nodeId) {
  return nodeId.replace(/^!/, '').toLowerCase();
}

let _onHomePosChange = null;
export function onHomePosChange(cb) { _onHomePosChange = cb; }

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

// Returns node_id (!hexid) of the primary device, derived from its MAC key.
export function getPrimaryDeviceId() {
  for (const [mac, cfg] of Object.entries(getConfigByPrefix(PREFIX))) {
    if (cfg?.is_primary) return macToNodeId(mac);
  }
  return null;
}

// Returns node_id (!hexid) of the rotator device, derived from its MAC key.
export function getRotatorDeviceId() {
  for (const [mac, cfg] of Object.entries(getConfigByPrefix(PREFIX))) {
    if (cfg?.is_rotator) return macToNodeId(mac);
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

// Look up device config by node_id (!hexid) — matches by MAC suffix.
export function getDeviceCfgByNodeId(nodeId) {
  const suffix = nodeIdSuffix(nodeId);
  for (const [mac, cfg] of Object.entries(getConfigByPrefix(PREFIX))) {
    if (mac.replace(/:/g, '').toLowerCase().endsWith(suffix)) {
      return { ...DEFAULT, ...cfg };
    }
  }
  return { ...DEFAULT };
}

// Called from ws-relay when a device first appears with a known MAC address.
// Migrates any legacy device_cfg.!hexid entry to the canonical MAC key.
export function ensureDeviceCfgMac(addr) {
  const mac = addr.toUpperCase();
  if (getConfig(PREFIX + mac, null) !== null) return; // already exists

  const suffix = mac.replace(/:/g, '').toLowerCase().slice(-8);
  const all    = getConfigByPrefix(PREFIX);
  const oldKey = Object.keys(all).find(k =>
    !k.includes(':') && k.replace(/[^0-9a-f]/gi, '').toLowerCase().endsWith(suffix)
  );

  if (oldKey) {
    // Migrate: copy data to MAC key, delete old !hexid key
    setConfig(PREFIX + mac, all[oldKey]);
    deleteConfig(PREFIX + oldKey);
  } else {
    // Bootstrap empty entry
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
    res.json(getDeviceCfgByNodeId(raw));
  } else {
    res.json(getDeviceCfg(raw));
  }
});

// PUT /device-config/:address  (MAC or !hexid)
router.put('/:address', (req, res) => {
  const raw = req.params.address;
  // Resolve to MAC key
  let mac;
  if (raw.startsWith('!')) {
    const suffix = nodeIdSuffix(raw);
    mac = Object.keys(getConfigByPrefix(PREFIX)).find(
      k => k.replace(/:/g, '').toLowerCase().endsWith(suffix)
    );
    if (!mac) return res.status(404).json({ error: `No device config found for ${raw}` });
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
  res.json(updated);
});

export default router;
