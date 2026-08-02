import { Router } from 'express';
import { rotator } from './rotator.js';
import { dashMode } from './dash-mode.js';
import { scanner } from './scanner.js';
import { activeTracker } from './active-tracker.js';
import { getConfig, setConfig } from './db.js';

const router = Router();

// Per-variant command vocabulary. Selected by rotator.variant; defaults to v4
// when the variant is not yet detected. v4 maps are unchanged from before.
const CAL_PROCEDURES = {
  v4: ['calMotor', 'qmcCali', 'calPwmMin', 'qmcOsStart', 'qmcOsEnd'],
  v5: ['dirtest', 'caltrue', 'caloffset', 'encsign'],
};
const SETVARS = {
  v4: ['setPwmRunPct', 'setPwmFreq', 'setNorthOffset'],
  v5: ['cur', 'hold', 'spd', 'ms', 'trackband', 'trackdelay'],
};
const OFFSET_CMD = { v4: 'setOffset', v5: 'caloffset' };
// Motor config field -> firmware command, per variant (firmware_config POST).
const MOTOR_WRITE = {
  v4: { pwm_min: 'pwmMin', pwm_run: 'pwmRun', pulses_per_deg: 'ppd' },
  v5: { run_ma: 'cur', hold_pct: 'hold', sps: 'spd', usteps: 'ms' },
};
// Motor config field -> status field to read back, per variant (GET).
const MOTOR_READ = {
  v4: { pwm_min: 'pwmMin', pwm_run: 'pwmRun', pulses_per_deg: 'ppd' },
  v5: { run_ma: 'curMa', hold_pct: 'holdPct', sps: 'sps', usteps: 'usteps' },
};

const variant = () => rotator.variant ?? 'v4';

router.get('/status', (req, res) => {
  const fwStatus = rotator.status;
  res.json({
    connected:     rotator.connected,
    variant:       rotator.variant,
    active_target: rotator.activeTarget,
    targets:       rotator.targets,
    mode:          dashMode.value,
    dash_mode:     dashMode.value,
    scan_active:   scanner.active,
    scan_az:       scanner.active ? scanner.az : null,
    scan_dwell_az: scanner.active ? scanner.dwellAz : null,
    scan_contacts: scanner.contacts,
    ...fwStatus,
  });
});

router.post('/active', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const ok = rotator.setActiveTarget(name);
  if (!ok) return res.status(404).json({ error: 'unknown target' });
  res.json({ active: name });
});

// Set one v5 device config value. Returns the device's own reply
// { ok, msg, value } — the device is the single validator (rejects
// out-of-range, not clamped). The schema (bounds/labels) is pushed over WS.
router.post('/config', async (req, res) => {
  const { id, value } = req.body;
  if (!id || value == null) return res.status(400).json({ error: 'id and value required' });
  const result = await rotator.setConfigValue(id, value);
  res.json(result);
});

router.post('/move', (req, res) => {
  const { az } = req.body;
  if (az == null) return res.status(400).json({ error: 'az required' });
  // Manual point is a PASV-only action. In ACTV the active-tracker owns the
  // rotator, and during a scan the scanner does — a competing manual move2az
  // aborts the in-progress closed-loop move (v5) and stutters the motor. This
  // is a BACKEND control: the browser does not decide it.
  if (dashMode.value === 1) return res.status(409).json({ refused: true, reason: 'ACTV mode owns the rotator' });
  if (scanner.active)        return res.status(409).json({ refused: true, reason: 'scan in progress' });
  rotator.move(az);
  res.json({ moving: true, az });
});

router.post('/mode', (req, res) => {
  const { mode } = req.body;
  if (mode == null) return res.status(400).json({ error: 'mode required' });
  // SCAN takes precedence over every mode that wants to point the rotator.
  // DISC aims the yagi at each mission's bearing, so it collides with a sweep
  // exactly as ACTV does and is refused on the same terms.
  if ((mode === 1 || mode === 3) && scanner.active)
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
  const ALLOWED = CAL_PROCEDURES[variant()];
  const { procedure } = req.body;
  if (!ALLOWED.includes(procedure)) return res.status(400).json({ error: 'unknown procedure' });
  rotator.sendAction(procedure);
  res.json({ sent: procedure });
});

router.post('/setvar', (req, res) => {
  const ALLOWED_VARS = SETVARS[variant()];
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
  rotator.sendAction(OFFSET_CMD[variant()], [String(offset)]);
  res.json({ sent: true, offset });
});

router.get('/firmware_config', (req, res) => {
  const s = rotator.status;
  const savedScan = getConfig('scan_config', {});
  const savedActv = getConfig('actv_config', {});
  const motor = {};
  for (const [field, statusKey] of Object.entries(MOTOR_READ[variant()])) {
    motor[field] = s[statusKey] ?? null;
  }
  res.json({
    motor,
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
  for (const [field, cmd] of Object.entries(MOTOR_WRITE[variant()])) {
    if (motor[field] == null) continue;
    const val = (field === 'pulses_per_deg') ? Number(motor[field]) : Math.round(Number(motor[field]));
    rotator.sendAction(cmd, [val]);
  }
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
