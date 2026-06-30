import { Router } from 'express';
import { getConfig, setConfig, getAlertRules, updateAlertRule } from './db.js';
import { ALERT_META } from './alerts.js';
import { sendTestAlert } from './mailer.js';

export const ALERT_SMTP_KEYS = [
  'alerts.smtp_host', 'alerts.smtp_port', 'alerts.smtp_user', 'alerts.smtp_pass',
  'alerts.smtp_from', 'alerts.smtp_to', 'alerts.imap_host', 'alerts.imap_port',
];

const router = Router();

router.get('/config', (req, res) => {
  const result = {};
  for (const k of ALERT_SMTP_KEYS) result[k] = getConfig(k, null);
  res.json(result);
});

router.put('/config', (req, res) => {
  for (const [k, v] of Object.entries(req.body)) {
    if (ALERT_SMTP_KEYS.includes(k)) setConfig(k, v);
  }
  res.json({ ok: true });
});

router.get('/rules', (req, res) => {
  const rules = getAlertRules().map(r => ({
    ...r,
    label: ALERT_META[r.type]?.label ?? r.type,
    desc:  ALERT_META[r.type]?.desc  ?? '',
    unit:  ALERT_META[r.type]?.unit  ?? null,
  }));
  res.json(rules);
});

router.put('/rules/:type', (req, res) => {
  const { type } = req.params;
  const { enabled, threshold, cooldown_minutes } = req.body;
  const changed = updateAlertRule({
    type,
    enabled:          enabled          != null ? (enabled ? 1 : 0) : undefined,
    threshold:        threshold        != null ? Number(threshold) : null,
    cooldown_minutes: cooldown_minutes != null ? Number(cooldown_minutes) : undefined,
  });
  if (!changed) return res.status(404).json({ error: 'unknown alert type' });
  res.json({ ok: true });
});

router.post('/test', async (req, res) => {
  try {
    await sendTestAlert();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
