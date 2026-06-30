import { Router } from 'express';
import { rotator } from './rotator.js';
import { dashMode } from './dash-mode.js';
import { scanner } from './scanner.js';
import { activeTracker } from './active-tracker.js';
import { getConfig, setConfig } from './db.js';

const router = Router();

router.get('/status', (req, res) => {
  const fwStatus = rotator.status;
  res.json({
    connected:     rotator.connected,
    mode:          dashMode.value,
    dash_mode:     dashMode.value,
    scan_active:   scanner.active,
    scan_az:       scanner.active ? scanner.az : null,
    scan_dwell_az: scanner.active ? scanner.dwellAz : null,
    scan_contacts: scanner.contacts,
    ...fwStatus,
  });
});

router.post('/move', (req, res) => {
  const { az } = req.body;
  if (az == null) return res.status(400).json({ error: 'az required' });
  rotator.move(az);
  res.json({ moving: true, az });
});

router.post('/mode', (req, res) => {
  const { mode } = req.body;
  if (mode == null) return res.status(400).json({ error: 'mode required' });
  if (mode === 1 && scanner.active)
    return res.json({ mode: dashMode.value, refused: true });
  dashMode.set(mode);
  res.json({ mode });
});

router.post('/target', (req, res) => {
  const num = parseInt(req.body.num, 10);
  if (!num) return res.status(400).json({ error: 'num required' });
  if (dashMode.value !== 1) return res.status(409).json({ error: 'not in ACTV mode' });
  const ok = activeTracker.targetNum(num);
  if (!ok) return res.status(404).json({ error: 'node not in radar list or no position' });
  res.json({ targeted: num });
});

router.post('/scan/start', (req, res) => {
  if (scanner.active) return res.json({ started: false, reason: 'already scanning' });
  scanner.start();
  res.json({ started: true });
});

router.post('/scan/abort', (req, res) => {
  scanner.abort();
  res.json({ aborted: true });
});

router.post('/calibrate', (req, res) => {
  const ALLOWED = ['calMotor', 'qmcCali', 'calPwmMin', 'qmcOsStart', 'qmcOsEnd'];
  const { procedure } = req.body;
  if (!ALLOWED.includes(procedure)) return res.status(400).json({ error: 'unknown procedure' });
  rotator.sendAction(procedure);
  res.json({ sent: procedure });
});

router.post('/setvar', (req, res) => {
  const ALLOWED_VARS = ['setPwmRunPct', 'setPwmFreq', 'setNorthOffset'];
  const { action, val } = req.body;
  if (!ALLOWED_VARS.includes(action)) return res.status(400).json({ error: 'unknown var' });
  if (val == null) return res.status(400).json({ error: 'val required' });
  rotator.sendAction(action, [String(val)]);
  res.json({ sent: action, val });
});

router.post('/offset', (req, res) => {
  let { offset } = req.body;
  offset = parseFloat(offset);
  if (isNaN(offset)) return res.status(400).json({ error: 'offset must be a number' });
  offset = ((offset % 360) + 360) % 360;
  rotator.sendAction('setOffset', [String(offset)]);
  res.json({ sent: true, offset });
});

router.get('/firmware_config', (req, res) => {
  const s = rotator.status;
  const savedScan = getConfig('scan_config', {});
  const savedActv = getConfig('actv_config', {});
  res.json({
    motor: {
      pwm_min:        s.pwmMin  ?? null,
      pwm_run:        s.pwmRun  ?? null,
      pulses_per_deg: s.ppd     ?? null,
    },
    scan: {
      step_deg:  savedScan.step_deg  ?? 5,
      dwell_sec: savedScan.dwell_sec ?? 60,
    },
    actv: {
      dwell_sec: savedActv.dwell_sec ?? 90,
    },
  });
});

router.post('/firmware_config', (req, res) => {
  const { motor = {}, scan = {}, actv = {} } = req.body;
  if (motor.pwm_min        != null) rotator.sendAction('pwmMin', [Math.round(motor.pwm_min)]);
  if (motor.pwm_run        != null) rotator.sendAction('pwmRun', [Math.round(motor.pwm_run)]);
  if (motor.pulses_per_deg != null) rotator.sendAction('ppd',    [Number(motor.pulses_per_deg)]);
  if (scan.step_deg != null || scan.dwell_sec != null) {
    const current = getConfig('scan_config', {});
    if (scan.step_deg  != null) current.step_deg  = Number(scan.step_deg);
    if (scan.dwell_sec != null) current.dwell_sec = Number(scan.dwell_sec);
    setConfig('scan_config', current);
  }
  if (actv.dwell_sec != null) {
    setConfig('actv_config', { dwell_sec: Number(actv.dwell_sec) });
  }
  res.json({ sent: true });
});

export default router;
