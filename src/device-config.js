// The REST API for EDITING this store is gone (2026-09-03, task
// devices-management-removed-meshgw-owns-it — node-dash "no longer
// responsible to manage devices"). What remains is read-only: the getter
// functions every backend module below still depends on (dash-mode, doors,
// resolve, node-filter, node-list, node-label, lifecycle, startup,
// snapshot-api, ws-relay), and the config storage they read. Values are
// frozen at whatever they currently hold — there is no longer any UI or API
// to change them, by design.
import { getConfig, setConfig, deleteConfig, getConfigByPrefix } from './db.js';

const PREFIX = 'device_cfg.';
const MAC_RE    = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;
const NODEID_RE = /^![0-9a-f]+$/i;


let _onHomePosChange = null;
export function onHomePosChange(cb) { _onHomePosChange = cb; }

let _nodeIdToMac = null;
export function registerNodeIdToMacResolver(fn) { _nodeIdToMac = fn; }

let _macToNodeId = null;
export function registerMacToNodeIdResolver(fn) { _macToNodeId = fn; }

// Registered once by ws-relay.js. Returns mesh-gw's live `install` object for a
// MAC, or null before the device has reported one. mesh-gw is SSOT for `label`
// and `is_rotator` — docs/gw/modules/device_install_object.md,
// docs/modules/device-config.md ("mesh-gw is now SSOT...", 2026-09-03).
let _installFor = null;
export function registerInstallLookup(fn) { _installFor = fn; }

export function resolvePrimaryNodeId() {
  return macToNodeId(getPrimaryMac());
}

// Resolve a BLE MAC to its live node_id, falling through to the MAC itself when
// the live pair is unknown. Shared by resolvePrimaryNodeId and dash-mode's
// per-mode transmitter resolution.
export function macToNodeId(mac) {
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
  // HEIGHT OF THIS ANTENNA ABOVE THE GROUND AT THE MAST BASE, in metres.
  //
  // Sits beside the antenna's other physical properties rather than with the
  // position, because it is a property of the ANTENNA, not of the site. Two
  // radios on one mast can be at different heights.
  //
  // Absolute height above sea level = home.alt + this. They are deliberately
  // separate numbers: home.alt is ground (30 m here, SRTM bare earth) and this is
  // the mast. Folding them into one figure loses the ability to correct either.
  //
  // Peter, 2026-08-05: "antenna height is +5 meters from ground."
  //
  // Null means unknown — never assume zero, which would silently claim the
  // antenna is lying on the ground.
  antenna_height_m:    null,   // metres above ground at the mast base
  fixed_lat:           null,   // fallback home position latitude (decimal degrees)
  fixed_lon:           null,   // fallback home position longitude (decimal degrees)
  color:               null,   // DaisyUI theme color for badges/radar
  ble_pin:             null,   // BLE pairing PIN — SSOT here. paired status = bleak_db SSOT, never stored here.
};

// Key is always uppercase MAC address e.g. "E9:B0:3F:17:27:91"
export function getDeviceCfg(address) {
  const mac     = address.toUpperCase();
  const stored  = getConfig(PREFIX + mac, {});
  const install = _installFor?.(mac) ?? null;
  return {
    ...DEFAULT,
    ...stored,
    // mesh-gw is SSOT for these two once it has reported an install object —
    // a stale local flag must never outrank a live one (2026-09-03).
    ...(install ? { label: install.alias ?? null, is_rotator: install.antenna?.rotator != null } : {}),
  };
}

// Returns { [MAC]: cfg } — same mesh-gw merge as getDeviceCfg, for every stored device.
export function getAllDeviceCfgs() {
  const stored = getConfigByPrefix(PREFIX);
  const merged = {};
  for (const mac of Object.keys(stored)) merged[mac] = getDeviceCfg(mac);
  return merged;
}

// Returns the BLE MAC address of the primary device. is_primary has no
// mesh-gw equivalent, so this reads the local store directly (unaffected by
// the SSOT change above).
export function getPrimaryMac() {
  for (const [mac, cfg] of Object.entries(getConfigByPrefix(PREFIX))) {
    if (cfg?.is_primary) return mac;
  }
  return null;
}

// Returns MAC address of the rotator device (for device identity comparisons).
// Reads through getDeviceCfg so a mesh-gw-reported rotator is recognised even
// when the local store was never told (2026-09-03).
export function getRotatorAddress() {
  for (const mac of Object.keys(getConfigByPrefix(PREFIX))) {
    if (getDeviceCfg(mac).is_rotator) return mac;
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
  } else if (MAC_RE.test(mac) && getConfig(PREFIX + mac, null) === null) {
    // No exact pair available: defer migration, bootstrap empty entry only.
    // MAC-shaped keys only — junk keys must never grow cfg rows (device-remove-op).
    setConfig(PREFIX + mac, { ...DEFAULT });
  }
}

// One-time idempotent cleanup: drop malformed cfg rows created before key
// validation existed (e.g. device_cfg.UNDEFINED from PUT /device-config/undefined).
for (const key of Object.keys(getConfigByPrefix(PREFIX))) {
  if (!MAC_RE.test(key) && !NODEID_RE.test(key)) {
    deleteConfig(PREFIX + key);
    console.log(`[device-config] purged malformed cfg row: ${PREFIX}${key}`);
  }
}

