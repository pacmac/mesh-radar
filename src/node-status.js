// node_status payload builder.
//
// Produces an ORDERED LIST OF DISPLAY-READY SECTIONS. The browser knows a small
// fixed vocabulary of section kinds and nothing else — not which port a datum
// came from, not what portnum 260 is, not what a detection is. It renders what
// it is handed, in the order handed.
//
// Two decisions live here BECAUSE they are decisions, and iron rule 1 puts
// every decision server-side:
//   1. Which sections exist for this node (presence follows real data).
//   2. What order they appear in.
// A browser-side `x-if="data.length"` would be the browser deciding — forbidden.
//
// Adding a port, a type or a field later is a change to this file alone. The
// browser is never touched again.

import { stmts } from './db.js';
import {
  fmtVoltage, fmtPercent, fmtUtil, fmtTemp, fmtHumidity, fmtPressure,
  fmtRssi, fmtSnr, fmtCount, fmtUptime, fmtTimestamp, fmtAgo, fmtAxisTick,
} from './format.js';
import { numToNodeId, signalQuality } from './utils.js';

// Window is chosen by the user (1/4/24/72 HR) and travels with the request.
// The SERVER slices to it and computes the axis labels for it — the browser
// never re-filters cached points.
const WINDOW_HOURS_ALLOWED = [1, 4, 24, 72];
const WINDOW_HOURS_DEFAULT = 24;
const AXIS_TICKS = 6;
const MAX_POINTS   = 200;
const MAX_EVENTS   = 200;
const PAC_ALARM_APP = 260;

// Every displayed field carries raw + text + ts. A field whose value is absent
// returns null and is dropped by the caller — an absent value is absent, not a
// placeholder.
function field(label, raw, text, ts = null) {
  if (raw == null || text == null || text === '') return null;
  return { label, raw, text, ts };
}

const compact = arr => arr.filter(Boolean);

// Evenly thin a series to MAX_POINTS. Keeps first and last so the visible time
// axis still spans the true window.
function downsample(rows, max = MAX_POINTS) {
  if (rows.length <= max) return rows;
  const step = (rows.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.round(i * step)]);
  return out;
}

function seriesFrom(rows, key) {
  const points = compact(rows.map(r =>
    (typeof r[key] === 'number' && Number.isFinite(r[key])) ? { t: r.ts, v: r[key] } : null));
  return points.length ? points : null;
}

// A `series` section, built only from the metrics that actually have points.
// A node reporting voltage but no humidity gets a voltage line and no humidity
// line — not an empty humidity axis.
// Evenly spaced axis labels across the rendered span. Emitted as {t,label} so
// the browser positions at `t` and prints `label` verbatim — a lookup, never
// date formatting (iron rule 1).
function axisTicks(tMin, tMax) {
  const span = Math.max(0, tMax - tMin);
  if (!span) return [{ t: tMin, label: fmtAxisTick(tMin, 0) }];
  const out = [];
  for (let i = 0; i < AXIS_TICKS; i++) {
    const t = Math.round(tMin + (span * i) / (AXIS_TICKS - 1));
    out.push({ t, label: fmtAxisTick(t, span) });
  }
  return out;
}

// Which Y axis a series belongs on is a DECISION, so the server makes it
// (iron rule 1). Pressure (~1017 hPa) on the same scale as temperature (~26 °C)
// flattens temperature to the baseline; voltage (~4.3 V) beside battery (~100%)
// flattens voltage the same way from the other direction.
//
// Deterministic and unit-agnostic, so a new metric needs no code change:
// split where consecutive maxima differ by >=10x, and give the LEFT axis to the
// group with more series (the outlier goes right).
const AXIS_SPLIT_RATIO = 10;

function assignAxes(series) {
  if (series.length < 2) return { axes: { y: axisLabel(series), y1: null } };
  const maxOf = s => Math.max(...s.points.map(p => Math.abs(p.v)), 0);

  // UNIT FIRST. dBm and % differ by only ~3x in magnitude but must never share
  // a scale — a percentage on a dBm axis is meaningless. Magnitude is only the
  // tie-breaker when there are too many units to give each its own axis.
  const units = [...new Set(series.map(s => s.unit || ''))];

  if (units.length === 1) {
    for (const s of series) s.axis = 'y';
    return { axes: { y: axisLabel(series), y1: null } };
  }

  if (units.length === 2) {
    const a = series.filter(s => (s.unit || '') === units[0]);
    const b = series.filter(s => (s.unit || '') === units[1]);
    const left  = a.length >= b.length ? a : b;
    const right = left === a ? b : a;
    for (const s of left)  s.axis = 'y';
    for (const s of right) s.axis = 'y1';
    return { axes: { y: axisLabel(left), y1: axisLabel(right) } };
  }

  // Three or more units: fall back to magnitude. Compare each series to the
  // CHART's largest value, not to its neighbour — voltage sits only 6.5x below
  // air-util but 23x below battery, and it is the chart maximum that flattens it.
  const globalMax = Math.max(...series.map(maxOf), 0) || Number.EPSILON;
  const dominant = series.filter(s => globalMax / (maxOf(s) || Number.EPSILON) < AXIS_SPLIT_RATIO);
  const dwarfed  = series.filter(s => !dominant.includes(s));

  if (!dwarfed.length) {
    for (const s of series) s.axis = 'y';
    return { axes: { y: axisLabel(series), y1: null } };
  }
  const left  = dwarfed.length > dominant.length ? dwarfed : dominant;
  const right = left === dwarfed ? dominant : dwarfed;
  for (const s of left)  s.axis = 'y';
  for (const s of right) s.axis = 'y1';
  return { axes: { y: axisLabel(left), y1: axisLabel(right) } };
}

// Axis caption = the distinct units it carries, so the reader can tell the
// scales apart ("°C · %RH" vs "hPa").
function axisLabel(group) {
  const units = [...new Set(group.map(s => s.unit).filter(Boolean))];
  return { label: units.join(' · ') || null };
}

function buildSeriesSection(id, title, rows, specs) {
  if (!rows.length) return null;
  const series = compact(specs.map(({ key, label, unit }) => {
    const points = seriesFrom(rows, key);
    return points ? { key, label, unit, axis: 'y', points: downsample(points) } : null;
  }));
  if (!series.length) return null;
  const { axes } = assignAxes(series);
  let tMin = Infinity, tMax = -Infinity;
  for (const s of series) for (const p of s.points) {
    if (p.t < tMin) tMin = p.t;
    if (p.t > tMax) tMax = p.t;
  }
  return {
    id, kind: 'series', title, series, axes,
    t_min: tMin, t_max: tMax,
    t_min_text: fmtTimestamp(tMin), t_max_text: fmtTimestamp(tMax),
    ticks: axisTicks(tMin, tMax),
  };
}

// 260 payloads are cached verbatim. Flattened to labelled rows here — the
// device's own key names are kept, because inventing friendlier names would be
// node-dash editorialising device data (iron rule 2).
function flattenPayload(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'type') continue;
    const label = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      // Arrays (e.g. the device's future `pts` per-trigger timestamps) render as
      // JSON, not String([]) — which yields "" and would show as a blank row.
      out.push({ label, raw: v, text: v.length ? JSON.stringify(v) : null });
    } else if (v && typeof v === 'object') {
      out.push(...flattenPayload(v, label));
    } else {
      out.push({ label, raw: v, text: v == null ? null : String(v) });
    }
  }
  return out;
}

function buildAppStateSection(id, title, row) {
  if (!row) return null;
  let payload;
  try { payload = JSON.parse(row.payload); } catch { return null; }
  const fields = compact(flattenPayload(payload).map(f => field(f.label, f.raw, f.text, row.ts)));
  if (!fields.length) return null;
  return {
    id, kind: 'value_grid', title, fields,
    observed_ts: row.ts, observed_text: fmtTimestamp(row.ts), observed_ago: fmtAgo(row.ts),
  };
}

// Detection events. `raw` is always present; our JSON envelope yields a typed
// label, a stock Meshtastic detection module's plain text yields the text
// itself. Both render in the same log.
function buildDetectionsSection(rows) {
  if (!rows.length) return null;
  const events = rows.map(r => {
    let text;
    if (r.type === 'alarm' || r.type === 'cleared') {
      const parts = compact([r.kind, r.val != null ? String(r.val) : null, r.msg]);
      text = parts.join(' · ') || r.raw;
    } else if (r.type === 'count') {
      text = fmtCount(r.count_num) ?? r.raw;
    } else if (r.type === 'motion') {
      text = r.msg || r.raw;
    } else {
      text = r.msg || r.raw;      // unknown type, or plain text from a stock node
    }
    return {
      ts: r.ts, ts_text: fmtTimestamp(r.ts), ts_ago: fmtAgo(r.ts),
      label: r.type ?? null, text,
    };
  });
  return { id: 'detections', kind: 'event_log', title: 'Detections', events };
}

// Signal, rendered with the app's existing .sig-bars component. The QUALITY is
// computed here, not in the browser: signalQuality() is exported from utils.js
// so the server runs the same function the rest of the UI does — one algorithm,
// no second copy to drift. Tiers mirror app-nodes.js:219-226 exactly so this
// looks identical to every other signal indicator.
function buildSignal(rssi, snr) {
  if (rssi == null && snr == null) return null;
  const pct = signalQuality(rssi, snr);
  const label = pct >= 76 ? 'Excellent' : pct >= 51 ? 'Good' : pct >= 26 ? 'Fair' : 'Poor';
  const cls   = pct >= 51 ? 'text-success' : pct >= 26 ? 'text-warning' : 'text-error';
  const parts = compact([fmtRssi(rssi), fmtSnr(snr)]);
  return {
    rssi, snr, pct, label, cls,
    text: parts.join(' / '),
    // Which of the four bars are lit — a decision, so the server makes it.
    bars: [0, 1, 2, 3].map(i => pct > i * 25),
  };
}

// RSSI / noise floor / quality. Noise is DERIVED: SNR is signal-above-noise,
// so noise = rssi - snr. API.md publishes no noise figure, so it is labelled
// plainly rather than passed off as a measurement. Quality reuses
// signalQuality() from utils.js — the same function the nodes and messages
// pages use, so the page agrees with the rest of the UI.
function buildSignalSection(rows) {
  if (!rows.length) return null;
  const withNoise = rows.map(r => ({
    ts: r.ts,
    rssi: r.rssi,
    noise: (r.rssi != null && r.snr != null) ? +(r.rssi - r.snr).toFixed(1) : null,
    quality: (r.rssi != null || r.snr != null) ? signalQuality(r.rssi, r.snr) : null,
  }));
  return buildSeriesSection('signal', 'Signal', withNoise, [
    { key: 'rssi',    label: 'RSSI',        unit: 'dBm' },
    { key: 'noise',   label: 'Noise floor', unit: 'dBm' },
    { key: 'quality', label: 'Quality',     unit: '%'   },
  ]);
}

// Air quality from the BME680.
//
// Raw gas resistance in MΩ means nothing to a reader, but there is NO fixed
// resistance->quality conversion: Bosch's BSEC learns a per-sensor baseline over
// days, resistance varies between sensor units, and it rises in clean air.
// A hardcoded band (e.g. "50 kΩ = 100%") would be an invented number wearing a
// unit, which is worse than the raw figure.
//
// So the percentage is RELATIVE to the node's own recent maximum — its cleanest
// observed air — and is labelled as such. It needs days of history to mean much;
// with a short baseline everything reads near 100%, which is honest rather than
// falsely precise. The raw MΩ rides the second axis so nothing is hidden.
const GAS_BASELINE_DAYS   = 7;
const GAS_MIN_SAMPLES     = 12;   // below this the baseline is not worth quoting

function buildAirQualitySection(num, envRows, since) {
  const gasRows = envRows.filter(r => typeof r.gas_resistance === 'number' && Number.isFinite(r.gas_resistance));
  if (!gasRows.length) return null;

  const base = stmts.queryGasBaseline.get(num, Math.floor(Date.now() / 1000) - GAS_BASELINE_DAYS * 86400);
  const baseline = (base?.samples >= GAS_MIN_SAMPLES && base.baseline > 0) ? base.baseline : null;

  const rows = gasRows.map(r => ({
    ts: r.ts,
    gas_resistance: r.gas_resistance,
    air_quality: baseline ? Math.max(0, Math.min(100, +(100 * r.gas_resistance / baseline).toFixed(1))) : null,
  }));

  const specs = [];
  if (baseline) specs.push({ key: 'air_quality', label: 'Air quality (rel.)', unit: '%' });
  specs.push({ key: 'gas_resistance', label: 'Gas resistance', unit: 'MΩ' });

  const section = buildSeriesSection('air_quality', 'Air quality', rows, specs);
  if (section) {
    section.note = baseline
      ? `Relative to this node's cleanest reading in the last ${GAS_BASELINE_DAYS} days (${baseline.toFixed(3)} MΩ).`
      : `Learning baseline — ${base?.samples ?? 0} of ${GAS_MIN_SAMPLES} samples needed before a percentage is meaningful.`;
  }
  return section;
}

export function buildNodeStatus(num, windowHours) {
  const node = stmts.getNodeByNum.get(num) ?? null;
  const info = stmts.getNodeinfoByNum.get(num) ?? null;
  if (!node && !info) return { num, found: false, window_h: null, header: null, sections: [] };

  const now   = Math.floor(Date.now() / 1000);
  const hours = WINDOW_HOURS_ALLOWED.includes(Number(windowHours))
    ? Number(windowHours) : WINDOW_HOURS_DEFAULT;
  const since = now - hours * 3600;
  const src   = info ?? {};
  const lastHeard = node?.last_heard ?? info?.last_heard ?? null;

  const appRows = stmts.queryNodeAppState.all(num);
  const appOf   = t => appRows.find(r => r.portnum === PAC_ALARM_APP && r.type === t) ?? null;

  // Boot count lives in the 260 debug payload; absent for any node that does
  // not speak 260 (every stock Meshtastic node), and then simply not shown.
  let bootCount = null, bootTs = null;
  const dbgRow = appOf('debug');
  if (dbgRow) {
    try {
      const dbg = JSON.parse(dbgRow.payload);
      if (Number.isFinite(dbg?.boot)) { bootCount = dbg.boot; bootTs = dbgRow.ts; }
    } catch { /* unparseable debug payload — leave boots absent */ }
  }

  const header = {
    num,
    node_id:    src.node_id ?? node?.node_id ?? numToNodeId(num),
    long_name:  src.long_name  ?? node?.long_name  ?? null,
    short_name: src.short_name ?? node?.short_name ?? null,
    hw_model:   src.hw_model   ?? node?.hw_model   ?? null,
    last_heard: lastHeard == null ? null : {
      raw: lastHeard, text: fmtTimestamp(lastHeard), ago: fmtAgo(lastHeard, now),
    },
    // Every vital we hold — nothing withheld. An absent value omits its field:
    // API.md is explicit that channel_utilization is present only when the
    // device is awake and ABSENCE IS NOT ZERO, so a missing value must never
    // render as 0%.
    fields: compact([
      field('Battery',     node?.battery,        fmtPercent(node?.battery),      lastHeard),
      field('Voltage',     node?.voltage,        fmtVoltage(node?.voltage),      lastHeard),
      field('Uptime',      node?.uptime_seconds, fmtUptime(node?.uptime_seconds), lastHeard),
      // Boot count comes from the 260 debug cache — it is what makes uptime
      // interpretable ("up 5m" reads very differently at 37 boots).
      field('Boots',       bootCount,            fmtCount(bootCount),            bootTs),
      field('Chan util',   node?.channel_util,   fmtUtil(node?.channel_util),    lastHeard),
      field('Air util TX', node?.air_util_tx,    fmtUtil(node?.air_util_tx),     lastHeard),
    ]),
    signal: buildSignal(node?.rssi ?? null, node?.snr ?? null),
  };

  const dmRows  = stmts.queryDeviceMetricsHistory.all(num, since);
  const envRows = stmts.queryEnvHistory.all(num, since);
  const detRows = stmts.queryDetectionEvents.all(num, since, MAX_EVENTS);
  const sigRows = stmts.querySignalHistory.all(num, since);
  const lat = info?.lat ?? node?.lat ?? null;
  const lon = info?.lon ?? node?.lon ?? null;

  // Fixed order, each section present ONLY if it has data.
  const sections = compact([
    buildSeriesSection('device_vitals', 'Device vitals', dmRows, [
      { key: 'voltage',             label: 'Voltage',            unit: 'V' },
      { key: 'battery_level',       label: 'Battery',            unit: '%' },
      { key: 'channel_utilization', label: 'Channel utilisation', unit: '%' },
      { key: 'air_util_tx',         label: 'Air util TX',        unit: '%' },
    ]),
    buildSignalSection(sigRows),
    buildSeriesSection('environment', 'Environment', envRows, [
      { key: 'temperature',         label: 'Temperature', unit: '°C'  },
      { key: 'relative_humidity',   label: 'Humidity',    unit: '%RH' },
      { key: 'barometric_pressure', label: 'Pressure',    unit: 'hPa' },
    ]),
    buildAirQualitySection(num, envRows, since),
    buildDetectionsSection(detRows),
    buildAppStateSection('alarm_config', 'Alarm config', appOf('config')),
    buildAppStateSection('diagnostics',  'Diagnostics',  appOf('debug')),
    buildAppStateSection('power',        'Power',        appOf('calc')),
    (lat != null && lon != null) ? {
      id: 'position', kind: 'value_grid', title: 'Position',
      fields: compact([
        field('Latitude',  lat, lat.toFixed(5)),
        field('Longitude', lon, lon.toFixed(5)),
      ]),
    } : null,
  ]);

  return { num, found: true, window_h: hours, header, sections };
}
