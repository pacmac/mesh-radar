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
// `passive` — does the passive tracer act in this mode? It is a system rule, not
// a user knob: PUT /config/modes copies only rx and tx, so an override can never
// carry it. It gates ONLY whether passive acts; passive keeps PASV's radio roles
// in every mode and never takes the YAGI.
// AIM AND RADIO ARE PART OF WHAT A MODE IS (task `traceroute-rework`).
// Peter, 2026-08-04: "we have a config page to define what a mode should do."
//
// Added, nothing here changed: rx/tx/passive keep the exact values and the
// reasoning below them. Before this the aim was a side-effect buried in
// mission-runner._aim(), which is how DISC came to compute a door bearing and
// discard it — aim-at-the-door never once executed.
//
//   aim:   'auto' | 'door' | 'endpoint' | 'none'
//
//   'auto' is the one that thinks — see traceroute._decideAim. The static
//   choices are explicit overrides for experiments. ACTV and DISC both defaulted
//   to a static choice, and ACTV's was 'endpoint', which measurement says is
//   wrong 87.1% of the time.
//   radio: 'auto' | 'omni' | 'yagi'      'auto' defers to the tx role
const MODE_DEFAULTS = {
  pasv: { rx: 'non-rotator', tx: 'rx',      passive: true,  aim: 'none',     radio: 'auto' }, // passive: hear on non-rotator radios, re-trace via the hearer
  actv: { rx: 'rotator',     tx: 'rotator', passive: false, aim: 'auto',     radio: 'auto' }, // active: the aimed YAGI hears and transmits
  scan: { rx: 'rotator',     tx: 'rotator', passive: false, aim: 'none',     radio: 'auto' }, // scan: the sweeping YAGI hears and transmits
  // DISC REMOVED 2026-08-18. Peter: "DISC is deprecated, it is part of
  // observatory" — and observatory is in
  // archive/observatory-and-discovery-2026-08-18.tar.gz, along with the
  // mission-runner that DISC existed to drive. A mode whose engine has been
  // archived is a button that cannot do anything.
  //
  // Kept from its comment because the MEASUREMENT is still worth having: DISC
  // used to switch the passive tracer off entirely (passive-tracer.js tested
  // `dashMode.value !== 0`). Measured 2026-08-02 — passive ran 17.0 traces/h
  // answering 3.8% (n=5,557) before DISC was selected at 10:53, then managed
  // 1 trace in 9.5 h while DISC returned 0 answers for 132 attempts. The only
  // prober that was working got silently disabled by the mode meant to improve
  // reach. If a discovery mode is ever rebuilt, that is the trap to avoid.
  //
  // Its roles were rx:'all', tx:'rotator', passive:true, aim:'auto' — listen on
  // everything because a reply can arrive at either radio, transmit only on the
  // aimed YAGI because an unaimed 234 km attempt on the omni is worthless.
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
// 'disc' removed 2026-08-18 with observatory.
//
// A legacy stored mode of 3 is safe: modeName() already falls back to 'pasv'.
//
// THIS LIST DOES NOT DRIVE THE MODE BUTTONS. I assumed modeVocabulary() served
// it to the browser and that removing 'disc' here would take the tab with it —
// it did not, and a screenshot caught it still on screen. The buttons in
// public/index.html are hand-written, one per mode, and had to be removed
// separately. tab-cfg.html says the same of the Modes cards ("three hand-written
// cards"). Anyone removing or adding a mode must edit BOTH.
export const MODE_KEYS = ['pasv', 'actv', 'scan'];
export const RX_ROLES  = ['rotator', 'non-rotator', 'primary', 'all'];
export const TX_ROLES  = ['rotator', 'primary', 'non-rotator', 'all', 'rx'];
// 'auto' FIRST, because it is the one that thinks. The others are explicit
// overrides — useful for experiments, wrong as a standing policy.
//
// The static choices are what Peter objected to: "right now traceroute still
// points at eps". Aiming at the endpoint puts the actual first hop OUTSIDE the
// 35 degree beam 87.1% of the time (n=2726), and more than 135 degrees out —
// behind the antenna — 53.4% of the time.
export const AIM_MODES   = ['auto', 'door', 'endpoint', 'none'];
export const RADIO_MODES = ['auto', 'omni', 'yagi'];

// LABELS LIVE HERE TOO. Naming a thing is a decision, and the browser does not
// make decisions — it had its own retyped copy of the role lists AND its own
// labels for them (app.js:251-262), free to drift from what isValidRole accepts.
// Peter, 2026-08-04: "do NOT break the UI golden rule."
const LABELS = {
  rotator:      'Rotator',
  'non-rotator':'Any non-rotator',
  primary:      'Primary',
  all:          'All radios',
  rx:           'Whichever heard it',
  door:         'The door it routes through',
  endpoint:     'The node itself',
  none:         'Do not aim',
  auto:         "Whatever the mode's TX resolves to",
  omni:         'Omni',
  yagi:         'Yagi (rotator)',
};
const opt = (v) => ({ value: v, label: LABELS[v] ?? v });

/** The vocabulary the Modes page offers, derived from the SAME constants the
 *  validators test against — so what is offered and what is accepted cannot
 *  disagree. */
export function modeVocabulary() {
  return {
    rx:    RX_ROLES.map(opt),
    tx:    TX_ROLES.map(opt),
    aim:   AIM_MODES.map(opt),
    radio: RADIO_MODES.map(opt),
    modes: [...MODE_KEYS],
    // The FIELD labels too. The page must not name "Listener (RX)" any more than
    // it names "Rotator" — same rule, same reason.
    fields: [
      { key: 'rx',    label: 'Listener (RX)' },
      { key: 'tx',    label: 'Transmitter (TX)' },
      { key: 'aim',   label: 'Aim at' },
      { key: 'radio', label: 'Radio' },
    ],
  };
}

export function isValidAim(v)   { return typeof v === 'string' && AIM_MODES.includes(v); }
export function isValidRadio(v) { return typeof v === 'string' && RADIO_MODES.includes(v); }
const MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;

// Validate a role string for a given kind ('rx' | 'tx'): a known keyword or a MAC.
export function isValidRole(role, kind) {
  if (typeof role !== 'string' || !role) return false;
  const known = kind === 'tx' ? TX_ROLES : RX_ROLES;
  return known.includes(role) || MAC_RE.test(role);
}

// Does the passive tracer act in this mode? Consumers must ask this rather than
// testing a mode number — a bare `dashMode.value !== 0` in passive-tracer.js is
// what silently disabled passive tracing for the whole of DISC.
export function passiveTracingAllowed(mode) {
  return modeCfg(mode).passive === true;
}

/** Which modes permit passive tracing, as a list. Task `hooks-per-mode-scope`.
 *
 *  A per-mode hook must DECLARE its modes, and that declaration has to come from
 *  here rather than being written out again at the hook — two lists that can
 *  disagree is how the original bug happened, just one level up. */
export function modesAllowingPassive() {
  // Derived from MODE_DEFAULTS, NOT MODE_KEYS. MODE_KEYS is declared further down
  // this file, and passive-tracer.js imports us and evaluates during our own
  // module init — reading MODE_KEYS from there threw
  // "Cannot access 'MODE_KEYS' before initialization" and took the service down
  // on 2026-08-03. MODE_DEFAULTS is declared at the top and is the actual source.
  return Object.keys(MODE_DEFAULTS).filter(k => MODE_DEFAULTS[k]?.passive === true);
}

// The full effective per-mode config (defaults merged with any stored override).
export function modeConfigAll() {
  return Object.fromEntries(MODE_KEYS.map((k) => [k, modeCfg(k)]));
}

// Resolve the single transmitter (dispatch) node_id for a mode. ctx.rxDevice (a
// MAC) is used by the 'rx' role; when it is absent the role falls back to primary.
/** What this mode points at, and which radio it prefers. Asked of dash-mode
 *  rather than decided by each caller — the same rule that already owns rx/tx,
 *  and the rule whose absence let the aim live in mission-runner. */
export function modeAim(mode) {
  const name = typeof mode === 'number' ? modeName(mode) : mode;
  return modeCfg(name)?.aim ?? 'none';
}
export function modeRadio(mode) {
  const name = typeof mode === 'number' ? modeName(mode) : mode;
  return modeCfg(name)?.radio ?? 'auto';
}

export function transmitterForMode(mode, ctx = {}) {
  const role = modeCfg(mode).tx || 'primary';
  let mac;
  if      (role === 'rotator') mac = getRotatorAddress();
  else if (role === 'primary') mac = getPrimaryMac();
  else if (role === 'rx')      mac = ctx.rxDevice ?? getPrimaryMac();
  else                         mac = role; // explicit MAC / node_id passthrough
  return macToNodeId(mac);
}
