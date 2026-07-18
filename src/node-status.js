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
  fmtRssi, fmtSnr, fmtCount, fmtUptime, fmtTimestamp, fmtAgo,
} from './format.js';
import { numToNodeId } from './utils.js';

const WINDOW_SEC   = 7 * 24 * 3600;
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
function buildSeriesSection(id, title, rows, specs) {
  if (!rows.length) return null;
  const series = compact(specs.map(({ key, label, unit }) => {
    const points = seriesFrom(rows, key);
    return points ? { key, label, unit, points: downsample(points) } : null;
  }));
  if (!series.length) return null;
  let tMin = Infinity, tMax = -Infinity;
  for (const s of series) for (const p of s.points) {
    if (p.t < tMin) tMin = p.t;
    if (p.t > tMax) tMax = p.t;
  }
  return {
    id, kind: 'series', title, series,
    t_min: tMin, t_max: tMax,
    t_min_text: fmtTimestamp(tMin), t_max_text: fmtTimestamp(tMax),
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

export function buildNodeStatus(num) {
  const node = stmts.getNodeByNum.get(num) ?? null;
  const info = stmts.getNodeinfoByNum.get(num) ?? null;
  if (!node && !info) return { num, found: false, header: null, sections: [] };

  const now   = Math.floor(Date.now() / 1000);
  const since = now - WINDOW_SEC;
  const src   = info ?? {};
  const lastHeard = node?.last_heard ?? info?.last_heard ?? null;

  const header = {
    num,
    node_id:    src.node_id ?? node?.node_id ?? numToNodeId(num),
    long_name:  src.long_name  ?? node?.long_name  ?? null,
    short_name: src.short_name ?? node?.short_name ?? null,
    hw_model:   src.hw_model   ?? node?.hw_model   ?? null,
    last_heard: lastHeard == null ? null : {
      raw: lastHeard, text: fmtTimestamp(lastHeard), ago: fmtAgo(lastHeard, now),
    },
    // At-a-glance vitals. Values, never verdicts — no health pill lives here.
    fields: compact([
      field('Battery', node?.battery,        fmtPercent(node?.battery),        lastHeard),
      field('Voltage', node?.voltage,        fmtVoltage(node?.voltage),        lastHeard),
      field('Uptime',  node?.uptime_seconds, fmtUptime(node?.uptime_seconds),  lastHeard),
      field('RSSI',    node?.rssi,           fmtRssi(node?.rssi),              lastHeard),
      field('SNR',     node?.snr,            fmtSnr(node?.snr),                lastHeard),
    ]),
  };

  const dmRows  = stmts.queryDeviceMetricsHistory.all(num, since);
  const envRows = stmts.queryEnvHistory.all(num, since);
  const detRows = stmts.queryDetectionEvents.all(num, since, MAX_EVENTS);
  const appRows = stmts.queryNodeAppState.all(num);
  const appOf   = t => appRows.find(r => r.portnum === PAC_ALARM_APP && r.type === t) ?? null;

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
    buildSeriesSection('environment', 'Environment', envRows, [
      { key: 'temperature',         label: 'Temperature', unit: '°C'  },
      { key: 'relative_humidity',   label: 'Humidity',    unit: '%RH' },
      { key: 'barometric_pressure', label: 'Pressure',    unit: 'hPa' },
    ]),
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

  return { num, found: true, header, sections };
}
