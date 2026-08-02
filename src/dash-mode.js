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
  // DISC — discovery. Peter, 2026-08-02: "well this is a new mode isnt it?"
  //
  // It is, and the roles are why. A discovery mission chooses a distant target
  // and pursues it, so it must TRANSMIT on the aimed YAGI — the first
  // implementation dispatched a 234 km attempt on the omni at no particular
  // azimuth, which is close to worthless. But it must LISTEN on everything: the
  // reply can come back down any path and arrive at either radio, and hearing
  // it on the omni is still hearing it.
  //
  // That rx:'all' + tx:'rotator' combination is what makes it a mode of its own
  // rather than a flag on ACTV, whose rx is the rotator alone.
  disc: { rx: 'all',         tx: 'rotator' },
};
const MODE_NAME = { 0: 'pasv', 1: 'actv', 2: 'scan', 3: 'disc' };

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

// Per-radio role predicates (mac = BLE MAC).
// A radio listens if it matches the rx (discovery) role OR the tx role — the
// route tracer automatically listens for its own traceroute replies. tx==='rx'
// means "the hearing radio itself", so it adds no new radio here (and skipping
// it avoids recursion with isTransmitterForMode below).
export function isListenerForMode(mode, mac) {
  const c = modeCfg(mode);
  if (roleMatchesMac(c.rx, mac)) return true;
  if (c.tx && c.tx !== 'rx' && roleMatchesMac(c.tx, mac)) return true;
  return false;
}
export function isTransmitterForMode(mode, mac) {
  const tx = modeCfg(mode).tx;
  if (tx === 'rx') return isListenerForMode(mode, mac); // TX follows the hearing radio
  return roleMatchesMac(tx, mac);
}

// Role vocabulary (SSOT). rx roles exclude 'rx' (which only means "the hearing
// radio" and is meaningless as a listener); tx roles include it.
export const MODE_KEYS = ['pasv', 'actv', 'scan', 'disc'];
export const RX_ROLES  = ['rotator', 'non-rotator', 'primary', 'all'];
export const TX_ROLES  = ['rotator', 'primary', 'non-rotator', 'all', 'rx'];
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;

// Validate a role string for a given kind ('rx' | 'tx'): a known keyword or a MAC.
export function isValidRole(role, kind) {
  if (typeof role !== 'string' || !role) return false;
  const known = kind === 'tx' ? TX_ROLES : RX_ROLES;
  return known.includes(role) || MAC_RE.test(role);
}

// The full effective per-mode config (defaults merged with any stored override).
export function modeConfigAll() {
  return Object.fromEntries(MODE_KEYS.map((k) => [k, modeCfg(k)]));
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
