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
const MODE_DEFAULTS = {
  pasv: { tx: 'rx' },       // passive: re-trace via the radio that heard the node
  actv: { tx: 'rotator' },  // active: the aimed YAGI transmits (and perf measures it)
  scan: { tx: 'rotator' },  // scan: the sweeping YAGI transmits
};
const MODE_NAME = { 0: 'pasv', 1: 'actv', 2: 'scan' };

// Map a mode (number or name) to its canonical name.
export function modeName(mode) {
  return typeof mode === 'string' ? mode : (MODE_NAME[mode] ?? 'pasv');
}

// Resolve the transmitter (dispatch) node_id for a mode. ctx.rxDevice (a MAC) is
// used by the 'rx' role; when it is absent the role falls back to the primary radio.
export function transmitterForMode(mode, ctx = {}) {
  const name = modeName(mode);
  const cfg  = { ...MODE_DEFAULTS[name], ...(getConfig('mode_config', {})[name] || {}) };
  const role = cfg.tx || 'primary';
  let mac;
  if      (role === 'rotator') mac = getRotatorAddress();
  else if (role === 'primary') mac = getPrimaryMac();
  else if (role === 'rx')      mac = ctx.rxDevice ?? getPrimaryMac();
  else                         mac = role; // explicit MAC / node_id passthrough
  return macToNodeId(mac);
}
