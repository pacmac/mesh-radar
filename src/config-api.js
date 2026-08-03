import { Router } from 'express';
import { broadcastSettings, pokeDeviceList } from './ws-relay.js';
import { getConfig, setConfig } from './db.js';
import { logEvent } from './hooks.js';
import { nodeList } from './node-list.js';
import { modeConfigAll, isValidRole, MODE_KEYS } from './dash-mode.js';
import { calloutConfig, renderTemplate } from './callout.js';

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
  // Retention for relay_observation (task `packet-provenance-capture`). ~29k
  // rows/day at the observed ~20 packets/min, so this cannot be left unbounded.
  // Enforced inline every 5,000 inserts by src/relay-observation.js.
  'relay_observation.retain_days': 30,
  // The analysis window for every Observatory series. SERVER state, not a browser
  // control: Peter, 2026-08-03 — "the browser is a presentation layer ONLY, this
  // filtering must be done backend so anyone using the browser sees the same
  // thing." 0 means ALL TIME. Task `observatory-window`.
  'observatory.window_days':  30,
  // Peter, 2026-08-03: "my got feeling is less than 5 times in the window. that
  // will discard spurioos hits, but it needs to ve a knob." Threshold for the
  // rare-sender hook; counted over observatory.window_days.
  'alerts.rare_sender_max':   5,
  // The explorer profile: distant, consistent, multi-hop, never answered.
  // Peter, 2026-08-04: "should flag this node as being an explorer."
  'explorers.min_km':         40,
  'explorers.min_hops':       2,
  'explorers.min_traffic':    20,
  // Retention for event_log (task `event-log`). ~6k rows/day at ~50 probes/hour
  // with ~5 events each — far less than relay_observation, but still bounded.
  'event_log.retain_days':    30,
  // How often the standing analysis tasks run. They read history rather than the
  // wire, so they gain nothing from running often. Task `hooks-standing-tasks`.
  'standing_tasks.every_min': 60,
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
    // HOLD THE BEAM for this long once aimed, so the shot goes out on the
    // bearing we aimed at. The yagi is shared with the garage alarm and the v4
    // drifts, so "aimed" and "still aimed a few seconds later" differ. Sized to
    // the real reply window — a measured round trip took 2.9 s — rather than to
    // the full timeout, which would monopolise the antenna.
    hold_sec:            15,
    // HOW LONG WE QUEUE FOR A BEAM SOMEONE ELSE HOLDS, before giving the tick
    // up. The rotator reports the milliseconds left on the current hold, so
    // this is compared against a real number, not guessed at. 5 s because the
    // holds we cause are `hold_sec`-sized and the alarm's are short moves; a
    // longer patience would queue behind the alarm rather than yield to it,
    // and 0 restores the old behaviour of deferring the whole 180 s tick.
    aim_patience_sec:    5,
    // WAS HARDCODED IN mission-runner, and it underpins every rate conclusion:
    // timeout_sec decides what counts as a miss AND dominates the real cadence,
    // because a 90 s wait inside a 180 s interval means the configured rate is
    // not the achieved rate. A timing that changes a measurement must be a knob.
    mission_timeout_sec: 90,
    aim_timeout_sec:     90,
    recompute_min:       15,
    // AIRTIME GOVERNANCE. Peter's "not so much as to become a nuisance" (§1)
    // with numbers attached.
    //
    // The rationale is COURTESY AND CONTROL, not a measured performance fix.
    // High-volume days do answer worse (§3b) but the cause is unknown and the
    // congestion explanation is disproved — so these exist to bound what we put
    // on a shared band and to make the rate an experiment we can run, NOT
    // because throttling is known to raise the answer rate.
    max_attempts_per_day: 400,
    // Skip a tick while the transmitting radio reports the channel busier than
    // this. Deliberately generous: no answer-rate effect was measurable at any
    // utilisation (§3b), so this is a brake for the mesh's benefit, not ours.
    channel_util_pause:   50,
    // WHAT COUNTS AS PROVEN GROUND — the anchor the window measures from.
    // "Answered once" let a 1-in-63 fluke at 189.1 km drag the search 90 km
    // into a band the charts show answering ~0%. Reliable reach ends at 95 km.
    proven_min_hits:     3,
    proven_min_rate:     10,   // percent
    // A newly discovered node is eligible for the queue for this long, so it
    // gets one aimed run rather than a single passive trace.
    new_node_hours:      48,
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

const PASV_DEFAULTS = { stale_sec: 1800, stale_fail_sec: 600, timeout_sec: 60,
  // Targets with zero lifetime successes drop to the slow lane after this many
  // attempts — a BACKOFF, not a cap. 26.6% of 30 days of attempts went to nodes
  // that have never answered; a hard cap would have lost first contact with 16
  // of the 113 nodes that eventually did.
  dead_after_attempts: 10, dead_retry_hours: 12 };
const ACTV_DEFAULTS = { dwell_sec: 90,   retry_sec: 30 };
const SCAN_DEFAULTS = { step_deg:  5,    dwell_sec: 60 };

// Server-side clamps for the discovery settings. A BROWSER IS NOT A VALIDATOR:
// interval_sec 0 would hammer a shared mesh, and window_km 0 would empty the
// queue. Enforced on the way in so a hand-rolled PUT cannot bypass the form.
// The ENGINE clamps again on read (calloutConfig), so these are a courtesy to
// the user rather than the enforcement — MESH_REACH_SPEC §8 requires the real
// ceiling to live in the transmit path, not in a config validator.
const CALLOUT_LIMITS = {
  min_km:         [0, 250],
  max_per_day:    [0, 12],
  cooldown_days:  [3, 365],
  heard_within_h: [1, 168],
  channel:        [0, 7],
};

const DISCOVERY_LIMITS = {
  window_km:           [1, 250],
  attempts_per_target: [1, 50],
  cooldown_min:        [1, 1440],
  max_silence_days:    [1, 365],
  hold_sec:            [0, 120],
  proven_min_hits:     [1, 50],
  proven_min_rate:     [0, 100],
  new_node_hours:      [0, 720],
  mission_timeout_sec: [10, 300],
  aim_timeout_sec:     [10, 300],
  aim_patience_sec:    [0, 60],
  recompute_min:       [1, 240],
  max_attempts_per_day: [1, 5000],
  channel_util_pause:   [1, 100],
  interval_sec:        [30, 3600],
};
// BOUNDS FOR THE OLDER TIMING KNOBS. These wrote `Number(x)` with no limits,
// and it was not theoretical: PUT /config/radar {"pasv":{"timeout_sec":-99}}
// was accepted and stored. A negative traceroute timeout times out every
// dispatch instantly and records a miss WITHOUT EVER WAITING — manufacturing a
// blackout indistinguishable from a dead mesh. MESH_REACH_SPEC §3c.
const RADAR_LIMITS = {
  pasv: { stale_sec: [30, 86400], stale_fail_sec: [30, 86400], timeout_sec: [5, 300] },
  actv: { dwell_sec: [5, 3600],   retry_sec: [5, 3600] },
  scan: { step_deg:  [1, 180],    dwell_sec: [5, 3600] },
};

// An ENUM, not a clamped range: the intermediate values are meaningless and a
// free-form number is exactly the unclamped-config defect raised with mt-radar.
const WINDOW_DAYS = [0, 1, 7, 30, 60];
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
      if (pasv[k] === undefined) continue;
      const n = Number(pasv[k]);
      if (!Number.isFinite(n)) return res.status(400).json({ error: `invalid pasv.${k}` });
      current[k] = clamp(n, RADAR_LIMITS.pasv[k]);
    }
    setConfig('pasv_config', current);
  }
  if (Object.keys(actv).length) {
    const current = getConfig('actv_config', {});
    const allowed = ['dwell_sec', 'retry_sec'];
    for (const k of allowed) {
      if (actv[k] === undefined) continue;
      const n = Number(actv[k]);
      if (!Number.isFinite(n)) return res.status(400).json({ error: `invalid actv.${k}` });
      current[k] = clamp(n, RADAR_LIMITS.actv[k]);
    }
    setConfig('actv_config', current);
  }
  if (Object.keys(scan).length) {
    const current = getConfig('scan_config', {});
    const allowed = ['step_deg', 'dwell_sec'];
    for (const k of allowed) {
      if (scan[k] === undefined) continue;
      const n = Number(scan[k]);
      if (!Number.isFinite(n)) return res.status(400).json({ error: `invalid scan.${k}` });
      current[k] = clamp(n, RADAR_LIMITS.scan[k]);
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
// ── CALLOUT ───────────────────────────────────────────────────────────────────
// Peter, 2026-08-03: "i dont see anything in the dashboard configs for the token
// based ping messages?" There was nothing — the engine shipped with its
// templates only in code, which makes "define custom ping text" untrue.
//
// GET returns the EFFECTIVE config, already clamped by calloutConfig(), so the
// page shows what will actually happen rather than what was asked for. A user
// who types 9999 sends/day must see 12 come back.
router.get('/callout', (req, res) => {
  const c = calloutConfig();
  res.json({
    ...c,
    // Rendered with sample values so the page can show what a template becomes
    // without the user having to imagine token substitution.
    preview: c.templates.map(t => renderTemplate(t.text, {
      short_name: 'JRSY', long_name: 'Jersey', km: 219, az: 159, hops: 4,
    })),
  });
});

router.put('/callout', (req, res) => {
  const body = req.body?.values ?? req.body ?? {};
  const cur  = { ...getConfig('callout', {}) };

  if (body.enabled !== undefined) cur.enabled = !!body.enabled;
  if (body.quiet_hours !== undefined) cur.quiet_hours = !!body.quiet_hours;

  for (const [k, range] of Object.entries(CALLOUT_LIMITS)) {
    if (body[k] === undefined) continue;
    const n = clamp(body[k], range);
    if (!Number.isFinite(n)) return res.status(400).json({ error: `invalid ${k}` });
    cur[k] = n;
  }

  if (body.templates !== undefined) {
    if (!Array.isArray(body.templates) || !body.templates.length) {
      return res.status(400).json({ error: 'templates must be a non-empty array' });
    }
    const clean = [];
    for (const t of body.templates) {
      const text = String(t?.text ?? '').trim();
      if (!text) return res.status(400).json({ error: 'a template cannot be empty' });
      // A BROADCAST IS PUBLIC AND PERMANENT. Length is capped here rather than
      // trusted from the browser: an over-long message is a bigger imposition on
      // a shared band, and nothing downstream truncates it.
      if (text.length > 200) return res.status(400).json({ error: 'a template must be 200 characters or fewer' });
      clean.push({ text, ttl_days: clamp(t?.ttl_days ?? 14, [1, 365]) });
    }
    cur.templates = clean;
  }

  setConfig('callout', cur);
  const eff = calloutConfig();
  logEvent({ kind: 'config', summary: `callout config updated — ${eff.enabled ? 'ENABLED' : 'disabled'}, `
    + `${eff.templates.length} templates, max ${eff.max_per_day}/day`, detail: eff });
  broadcastSettings();
  res.json(eff);
});

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
  if (key === 'observatory.window_days' && !WINDOW_DAYS.includes(Number(value))) {
    return res.status(400).json({ error: `window_days must be one of ${WINDOW_DAYS.join(', ')}` });
  }
  // WHAT CHANGED, WHEN. Without this every "did that help?" is answered from
  // memory — which is how 2026-08-03 went, and it cost hours. The window
  // selector is excluded: it changes the VIEW, not the system, and is written
  // constantly. Task `event-log`.
  const before = getConfig(key, DEFAULTS[key]);
  setConfig(key, value);
  if (key !== 'observatory.window_days') {
    logEvent({
      kind: 'config', source: 'config-api',
      severity: key === 'traceroute.enabled' && value === false ? 'notice' : 'info',
      summary: `${key}: ${JSON.stringify(before)} → ${JSON.stringify(value)}`,
      detail: { key, from: before, to: value },
    });
  }
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
  if ('observatory.window_days' in updates &&
      !WINDOW_DAYS.includes(Number(updates['observatory.window_days']))) {
    return res.status(400).json({ error: `window_days must be one of ${WINDOW_DAYS.join(', ')}` });
  }
  for (const [key, value] of Object.entries(updates)) {
    const before = getConfig(key, DEFAULTS[key]);
    setConfig(key, value);
    if (key !== 'observatory.window_days') {
      logEvent({
        kind: 'config', source: 'config-api',
        summary: `${key}: ${JSON.stringify(before)} → ${JSON.stringify(value)}`,
        detail: { key, from: before, to: value },
      });
    }
  }
  if (Object.keys(updates).some(k => NODE_FILTER_KEYS.has(k))) nodeList.refilter();
  res.json(updates);
  broadcastSettings();
});

export default router;
