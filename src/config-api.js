import { Router } from 'express';
import { broadcastSettings, pokeDeviceList } from './ws-relay.js';
import { getConfig, setConfig } from './db.js';
import { nodeList } from './node-list.js';
import { modeConfigAll, isValidRole, MODE_KEYS } from './dash-mode.js';

const router = Router();

export const DEFAULTS = {
  'node_filters.max_age':     0,
  'node_filters.max_hops':    99,
  'node_filters.named_only':  false,
  'node_filters.has_pos':     false,
  'node_filters.hide_mqtt':   false,
  'node_filters.has_signal':  false,
  'node_filters.has_telem':   false,
  'node_filters.roles':       [],
  'node_filters.node_source': 'both',
  'node_sort.field':          'last_heard',
  'node_sort.dir':            -1,
  'radar.max_range_km':       50,
  'radar.log_scale':          true,   // adaptive quantile scale (linear = opt-out)
  'radar.crosshair':          false,
  'message_filter.channels':  [],
  'message_filter.hide_mqtt': false,
  'packet_sources':           [],
  'range_test.duration':      10,
  'perf.failure_epoch':       null,   // read-only stamp: when traceroute failure recording began
  'traceroute.enabled':       true,   // master switch for AUTOMATIC dispatch; a manual request is never gated
  // DISCOVERY STRATEGY. One key, because this list governs two things at once:
  // the generic PUT below rejects anything not in it, and ws-relay's
  // settingsEvent() iterates it to build the settings WS payload. Declaring it
  // here is what makes these settings both persistent and visible to the
  // browser without a fetch. See docs/DISCOVERY_STRATEGY.md.
  'discovery': {
    strategy:            'ladder',  // 'ladder' (window past the record) | 'portfolio' (no window)
    window_km:           25,        // ladder: furthest step past proven ground worth attempting
    attempts_per_target: 6,         // shots at one target before it retires
    cooldown_min:        30,        // spacing between shots at the same target
    // LIVENESS. Reception recency predicts a reply better than anything else we
    // measure — 26.1% for a node heard on direct RF against 1.8% for one silent
    // more than a week (21,864 stored attempts). A node we have not heard in
    // this many days is not attempted at all.
    max_silence_days:    14,
    interval_sec:        180,       // seconds between missions
    enabled:             true,      // runner on/off without leaving DISC mode
    // Targeting (docs/DISCOVERY_TARGETING.md). `mode` decides whether AUTO
    // picks at all; `strategy` above decides HOW it picks. Orthogonal.
    mode:                'auto',    // 'auto' | 'targets' | 'manual'
    pinned:              null,      // ONE node num, or null. A singleton by
                                    // construction — the point of pinning is
                                    // concentration, and a pinned list is just
                                    // the queue again.
  },
};

router.get('/', (req, res) => {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    result[key] = getConfig(key, fallback);
  }
  res.json(result);
});

const PASV_DEFAULTS = { stale_sec: 1800, stale_fail_sec: 600, timeout_sec: 60 };
const ACTV_DEFAULTS = { dwell_sec: 90,   retry_sec: 30 };
const SCAN_DEFAULTS = { step_deg:  5,    dwell_sec: 60 };

// Server-side clamps for the discovery settings. A BROWSER IS NOT A VALIDATOR:
// interval_sec 0 would hammer a shared mesh, and window_km 0 would empty the
// queue. Enforced on the way in so a hand-rolled PUT cannot bypass the form.
const DISCOVERY_LIMITS = {
  window_km:           [1, 250],
  attempts_per_target: [1, 50],
  cooldown_min:        [1, 1440],
  max_silence_days:    [1, 365],
  interval_sec:        [30, 3600],
};
const DISCOVERY_STRATEGIES = ['ladder', 'portfolio'];
const DISCOVERY_MODES = ['auto', 'targets', 'manual'];
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Number(v)));

router.get('/radar', (req, res) => {
  const pasv = { ...PASV_DEFAULTS, ...getConfig('pasv_config', {}) };
  const actv = { ...ACTV_DEFAULTS, ...getConfig('actv_config', {}) };
  const scan = { ...SCAN_DEFAULTS, ...getConfig('scan_config', {}) };
  const display = {
    max_range_km: getConfig('radar.max_range_km', DEFAULTS['radar.max_range_km']),
    log_scale:    getConfig('radar.log_scale',    DEFAULTS['radar.log_scale']),
    crosshair:    getConfig('radar.crosshair',    DEFAULTS['radar.crosshair']),
  };
  res.json({ display, pasv, actv, scan });
});

router.put('/radar', (req, res) => {
  const { display = {}, pasv = {}, actv = {}, scan = {} } = req.body;

  if (Object.keys(display).length) {
    const allowed = ['max_range_km', 'log_scale', 'crosshair'];
    for (const k of allowed) {
      if (display[k] !== undefined) setConfig(`radar.${k}`, display[k]);
    }
  }
  if (Object.keys(pasv).length) {
    const current = getConfig('pasv_config', {});
    const allowed = ['stale_sec', 'stale_fail_sec', 'timeout_sec'];
    for (const k of allowed) {
      if (pasv[k] !== undefined) current[k] = Number(pasv[k]);
    }
    setConfig('pasv_config', current);
  }
  if (Object.keys(actv).length) {
    const current = getConfig('actv_config', {});
    const allowed = ['dwell_sec', 'retry_sec'];
    for (const k of allowed) {
      if (actv[k] !== undefined) current[k] = Number(actv[k]);
    }
    setConfig('actv_config', current);
  }
  if (Object.keys(scan).length) {
    const current = getConfig('scan_config', {});
    const allowed = ['step_deg', 'dwell_sec'];
    for (const k of allowed) {
      if (scan[k] !== undefined) current[k] = Number(scan[k]);
    }
    setConfig('scan_config', current);
  }

  res.json({ ok: true });
  broadcastSettings();
});

// Discovery strategy — same shape as /radar above: GET returns the effective
// settings (defaults merged with the stored override), PUT allowlists and clamps.
router.get('/discovery', (req, res) => {
  res.json({ ...DEFAULTS.discovery, ...getConfig('discovery', {}) });
});

router.put('/discovery', (req, res) => {
  const body = req.body?.values ?? req.body ?? {};
  const cur  = { ...DEFAULTS.discovery, ...getConfig('discovery', {}) };

  if (body.strategy !== undefined) {
    if (!DISCOVERY_STRATEGIES.includes(body.strategy)) {
      return res.status(400).json({ error: `invalid strategy: ${body.strategy}` });
    }
    cur.strategy = body.strategy;
  }
  for (const [k, range] of Object.entries(DISCOVERY_LIMITS)) {
    if (body[k] === undefined) continue;
    const n = clamp(body[k], range);
    if (!Number.isFinite(n)) return res.status(400).json({ error: `invalid ${k}` });
    cur[k] = n;
  }
  if (body.enabled !== undefined) cur.enabled = !!body.enabled;
  if (body.mode !== undefined) {
    if (!DISCOVERY_MODES.includes(body.mode)) {
      return res.status(400).json({ error: `invalid mode: ${body.mode}` });
    }
    cur.mode = body.mode;
  }
  if (body.pinned !== undefined) {
    if (body.pinned === null || body.pinned === '') {
      cur.pinned = null;
    } else {
      const n = Number(body.pinned);
      if (!Number.isInteger(n) || n <= 0) {
        return res.status(400).json({ error: 'pinned must be a positive node num or null' });
      }
      cur.pinned = n;
    }
  }

  setConfig('discovery', cur);
  res.json(cur);
  broadcastSettings();
});

// Per-mode radio roles (config-editor form flow). GET returns the effective
// config (defaults merged with any override); PUT writes allowlisted rx/tx roles
// per mode. dash-mode owns the role vocabulary and defaults (SSOT).
router.get('/modes', (req, res) => {
  res.json(modeConfigAll());
});

router.put('/modes', (req, res) => {
  const body = req.body || {};
  const current = getConfig('mode_config', {});
  for (const mode of MODE_KEYS) {
    const upd = body[mode];
    if (!upd || typeof upd !== 'object') continue;
    const cur = { ...current[mode] };
    if (upd.rx !== undefined) {
      if (!isValidRole(upd.rx, 'rx')) return res.status(400).json({ error: `invalid rx role for ${mode}: ${upd.rx}` });
      cur.rx = upd.rx;
    }
    if (upd.tx !== undefined) {
      if (!isValidRole(upd.tx, 'tx')) return res.status(400).json({ error: `invalid tx role for ${mode}: ${upd.tx}` });
      cur.tx = upd.tx;
    }
    current[mode] = cur;
  }
  setConfig('mode_config', current);
  res.json(modeConfigAll());
  pokeDeviceList();   // roles changed → refresh RX/TX badges on device_list
});

router.get('/:key', (req, res) => {
  const { key } = req.params;
  if (!(key in DEFAULTS)) return res.status(404).json({ error: 'Unknown config key' });
  res.json({ key, value: getConfig(key, DEFAULTS[key]) });
});

const NODE_FILTER_KEYS = new Set(Object.keys(DEFAULTS).filter(k => k.startsWith('node_filters.')));

router.put('/:key', (req, res) => {
  const { key } = req.params;
  if (!(key in DEFAULTS)) return res.status(404).json({ error: 'Unknown config key' });
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  setConfig(key, value);
  if (NODE_FILTER_KEYS.has(key)) nodeList.refilter();
  res.json({ key, value });
  broadcastSettings();
});

router.put('/', (req, res) => {
  const updates = req.body;
  if (typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'body must be an object of key/value pairs' });
  }
  const unknown = Object.keys(updates).filter(k => !(k in DEFAULTS));
  if (unknown.length) return res.status(400).json({ error: `Unknown keys: ${unknown.join(', ')}` });
  for (const [key, value] of Object.entries(updates)) setConfig(key, value);
  if (Object.keys(updates).some(k => NODE_FILTER_KEYS.has(k))) nodeList.refilter();
  res.json(updates);
  broadcastSettings();
});

export default router;
