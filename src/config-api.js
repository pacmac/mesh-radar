import { Router } from 'express';
import { getConfig, setConfig } from './db.js';

const router = Router();

const DEFAULTS = {
  'node_filters.max_age':    0,
  'node_filters.max_hops':   99,
  'node_filters.named_only': false,
  'node_filters.has_pos':    false,
  'node_filters.hide_mqtt':  false,
  'node_filters.has_signal': false,
  'node_filters.has_telem':  false,
  'node_filters.roles':      [],
  'node_sort.field':         'last_heard',
  'node_sort.dir':           -1,
  'radar.max_range_km':      50,
  'radar.log_scale':         false,
  'radar.crosshair':         false,
  'message_filter.channels': [],
  'message_filter.hide_mqtt': false,
  'packet_sources': [],
};

router.get('/', (req, res) => {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    result[key] = getConfig(key, fallback);
  }
  res.json(result);
});

router.get('/:key', (req, res) => {
  const { key } = req.params;
  if (!(key in DEFAULTS)) return res.status(404).json({ error: 'Unknown config key' });
  res.json({ key, value: getConfig(key, DEFAULTS[key]) });
});

router.put('/:key', (req, res) => {
  const { key } = req.params;
  if (!(key in DEFAULTS)) return res.status(404).json({ error: 'Unknown config key' });
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  setConfig(key, value);
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
  res.json(updates);
});

export default router;
