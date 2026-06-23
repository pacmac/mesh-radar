import { Router } from 'express';
import { getConfig, setConfig } from './db.js';
import { nodeList } from './node-list.js';

const router = Router();

const DEFAULTS = {
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
  'radar.log_scale':          false,
  'radar.crosshair':          false,
  'message_filter.channels':  [],
  'message_filter.hide_mqtt': false,
  'packet_sources':           [],
  'range_test.duration':      10,
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
});

export default router;
