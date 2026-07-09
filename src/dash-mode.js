import { EventEmitter } from 'events';
import { getConfig, setConfig } from './db.js';
import { getRotatorAddress, getPrimaryMac, macToNodeId } from './device-config.js';

class DashMode extends EventEmitter {
  get value() {
    return getConfig('rotator.dash_mode', 0);
  }

  set(mode) {
    setConfig('rotator.dash_mode', mode);
    this.emit('change', { _mode: mode });
  }
}

export const dashMode = new DashMode();

// ── Per-mode radio roles — single source of truth for traceroute dispatch ──────
// Every automatic traceroute resolves its transmitter here instead of each call
// site picking a radio on its own. Roles resolve live at call time:
//   'rotator' → the YAGI (getRotatorAddress)   'primary' → the OMNI (getPrimaryMac)
//   'rx'      → the radio that heard the node (passive; ctx.rxDevice)
// Defaults below; a browser-editable override lives under config key 'mode_config'
// (per-mode { tx: <role|MAC> }), merged over the defaults — its UI is a later phase.
// Each mode has a listener (rx) role and a transmitter (tx) role. Roles resolve
// live at call time: 'rotator'→YAGI, 'primary'→OMNI, 'non-rotator'→any radio
// except the YAGI, 'all'→every radio, 'rx' (tx only)→whichever radio heard the
// packet. The defaults reproduce the historic hardcoded behaviour exactly.
const MODE_DEFAULTS = {
  pasv: { rx: 'non-rotator', tx: 'rx' },      // passive: hear on non-rotator radios, re-trace via the hearer
  actv: { rx: 'rotator',     tx: 'rotator' }, // active: the aimed YAGI hears and transmits
  scan: { rx: 'rotator',     tx: 'rotator' }, // scan: the sweeping YAGI hears and transmits
};
const MODE_NAME = { 0: 'pasv', 1: 'actv', 2: 'scan' };

// Map a mode (number or name) to its canonical name.
export function modeName(mode) {
  return typeof mode === 'string' ? mode : (MODE_NAME[mode] ?? 'pasv');
}

// Merge the stored 'mode_config' override for one mode over its defaults.
function modeCfg(mode) {
  const name = modeName(mode);
  return { ...MODE_DEFAULTS[name], ...(getConfig('mode_config', {})[name] || {}) };
}

// Does a role string match a device MAC? Resolves live against the current
// rotator/primary assignment. Unrecognised strings are treated as explicit MACs.
function roleMatchesMac(role, mac) {
  if (!mac) return false;
  const up  = String(mac).toUpperCase();
  const rot = getRotatorAddress()?.toUpperCase() ?? null;
  const pri = getPrimaryMac()?.toUpperCase() ?? null;
  switch (role) {
    case 'all':         return true;
    case 'rotator':     return up === rot;
    case 'non-rotator': return up !== rot;
    case 'primary':     return up === pri;
    default:            return up === String(role).toUpperCase();
  }
}

// Per-radio role predicates (mac = BLE MAC). The reception paths gate on
// isListenerForMode; badges (later phase) read both.
export function isListenerForMode(mode, mac) {
  return roleMatchesMac(modeCfg(mode).rx, mac);
}
export function isTransmitterForMode(mode, mac) {
  const tx = modeCfg(mode).tx;
  if (tx === 'rx') return isListenerForMode(mode, mac); // TX follows the hearing radio
  return roleMatchesMac(tx, mac);
}

// Resolve the single transmitter (dispatch) node_id for a mode. ctx.rxDevice (a
// MAC) is used by the 'rx' role; when it is absent the role falls back to primary.
export function transmitterForMode(mode, ctx = {}) {
  const role = modeCfg(mode).tx || 'primary';
  let mac;
  if      (role === 'rotator') mac = getRotatorAddress();
  else if (role === 'primary') mac = getPrimaryMac();
  else if (role === 'rx')      mac = ctx.rxDevice ?? getPrimaryMac();
  else                         mac = role; // explicit MAC / node_id passthrough
  return macToNodeId(mac);
}
