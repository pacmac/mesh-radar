// node_status payload builder.
//
// Produces an ORDERED LIST OF DISPLAY-READY SECTIONS. The browser knows a small
// fixed vocabulary of section kinds and nothing else. It renders what it is
// handed, in the order handed.
//
// Two decisions live here BECAUSE they are decisions, and iron rule 1 puts
// every decision server-side:
//   1. Which sections exist for this node (presence follows real data).
//   2. What order they appear in.
// A browser-side `x-if="data.length"` would be the browser deciding — forbidden.
//
// Adding a port, a type or a field later is a change to this file alone. The
// browser is never touched again.

import { stmts, getConfig } from './db.js';
import {
  fmtVoltage, fmtPercent, fmtUtil, fmtTemp, fmtHumidity, fmtPressure,
  fmtRssi, fmtSnr, fmtUptime, fmtTimestamp, fmtStamp, fmtAgo, fmtUntil,
  fmtAxisTick, fmtCount,
} from './format.js';
import { numToNodeId, signalQuality, bearing } from './utils.js';
import { unitForNum } from './pac-host.js';
import { resolveDeviceLabel } from './node-label.js';

// Window is chosen by the user (1/4/24/72 HR) and travels with the request.
// The SERVER slices to it and computes the axis labels for it — the browser
// never re-filters cached points.
const WINDOW_HOURS_ALLOWED = [1, 4, 24, 72];
const WINDOW_HOURS_DEFAULT = 24;
const AXIS_TICKS = 6;
const MAX_POINTS   = 200;
const MAX_EVENTS   = 200;
// Events are not bound to the chart window. Charts are a time series; a log is
// a list of the most recent events.
const EVENT_WINDOW_DAYS = 30;

// Every displayed field carries raw + text + ts. A field whose value is absent
// returns null and is dropped by the caller — an absent value is absent, not a
// placeholder.
function field(label, raw, text, ts = null, desc = null) {
  if (raw == null || text == null || text === '') return null;
  return { label, raw, text, ts, ...(desc ? { desc } : {}) };
}

// Hops has TWO meanings in this codebase and they disagree.
//
//   REPORTED — derived live from hop_start - hop_limit. Sparse and unreliable:
//              hop_start is often absent, and the value describes the packet
//              that happened to arrive, not the node's usual path.
//   VERIFIED — the route from an actual traceroute. Authoritative.
//
// DEV1 currently reports 1 while its traceroute shows route:[] — direct. So the
// card must say WHICH it is quoting rather than printing a bare number that is
// right half the time. Verified wins when present.
// Typicality window for the hops split. Fixed, NOT the chart selector's window:
// the header must not change meaning when someone clicks 1HR.
const HOPS_WINDOW_DAYS = 7;

// LEAST HOPS — the shortest path actually observed, and how typical it is.
//
// Sourced from `messages`, not signal_history: the latter is 100% hops=0 by
// construction (direct receptions only, per RSSI_ATTRIBUTION_SPEC), so a
// least-hops derived from it would always be 0 and mean nothing. `messages` is
// the only store holding relayed receptions with the radio that heard them.
//
// The proportion is what stops a best-case number being a lie. "433 of 463
// direct" says direct is typical; "2 of 463" says the opposite while the
// headline stays 0 — which is how a 2.5 km link once rendered as
// "-36 dBm / hops 0".
function leastHopsField(num, now) {
  const rows = stmts.hopsByRadio.all(num, now - HOPS_WINDOW_DAYS * 86400);
  if (!rows.length) return null;
  const best = rows.reduce((a, b) => (b.min_hops < a.min_hops ? b : a));
  return field('Least hops', best.min_hops, fmtCount(best.min_hops), best.last_ts,
               `${resolveDeviceLabel(best.rx_device)} · ${best.direct_n} of ${best.total_n} direct`);
}

// VERIFIED HOPS — a traceroute's route length. Authoritative about the path,
// and potentially very old.
//
// A verified value can be CORRECT and ANCIENT at once. GARG's is `route: []`
// (genuinely direct) from 14 Jul, followed by 880 consecutive timeouts — so the
// number is right and it will never update. Presenting it as current is the
// defect, not the number. `N failed since` is the honest qualifier and it is a
// measured count, not an adjective.
function verifiedHopsField(info, num) {
  if (!info?.last_traceroute) return null;
  let verified = null, verifiedTs = null;
  try {
    const tr = JSON.parse(info.last_traceroute);
    if (Array.isArray(tr?.route)) {
      verified   = tr.route.length;
      verifiedTs = tr.ts ? Math.floor(tr.ts / 1000) : null;
    }
  } catch { return null; }
  if (verified == null) return null;
  const health = stmts.tracerouteHealth.get({ num }) ?? {};
  const failed = health.failed_since ?? 0;
  const bits = [verifiedTs ? `traceroute ${fmtStamp(verifiedTs)}` : 'by traceroute'];
  if (failed > 0) bits.push(`${failed} failed since`);
  return field('Verified hops', verified, fmtCount(verified), verifiedTs, bits.join(' · '));
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
    (typeof r[key] === 'number' && Number.isFinite(r[key]))
      ? { t: r.ts, v: r[key], min: r[`${key}_min`], max: r[`${key}_max`] }
      : null));
  return points.length ? points : null;
}

// Reduce noisy high-frequency samples into bounded time buckets. The mean is
// the displayed line; min/max remain attached for callers that want an
// uncertainty envelope without inventing readings.
function bucketRows(rows, max = MAX_POINTS) {
  if (rows.length <= 3) return rows;
  // Always combine a small run of adjacent samples. A normal 24-hour node
  // history often has only 20–40 readings and must not bypass smoothing merely
  // because it is below the transport payload limit.
  const size = Math.max(3, Math.ceil(rows.length / max));
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    const group = rows.slice(i, i + size);
    const row = { ts: group[Math.floor(group.length / 2)].ts };
    const keys = new Set(group.flatMap(r => Object.keys(r)));
    for (const key of keys) {
      if (key === 'ts') continue;
      const values = group.map(r => r[key]).filter(v => typeof v === 'number' && Number.isFinite(v));
      if (!values.length) continue;
      row[key] = values.reduce((sum, v) => sum + v, 0) / values.length;
      row[`${key}_min`] = Math.min(...values);
      row[`${key}_max`] = Math.max(...values);
    }
    out.push(row);
  }
  return out;
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
  rows = bucketRows(rows);
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
    t_min_text: fmtStamp(tMin), t_max_text: fmtStamp(tMax),
    ticks: axisTicks(tMin, tMax),
  };
}

// Standard Meshtastic detection text is displayed verbatim.
function buildDetectionsSection(rows) {
  if (!rows.length) return null;
  const events = rows.map(r => ({
      ts: r.ts, ts_text: fmtStamp(r.ts, { withSeconds: true }), ts_ago: fmtAgo(r.ts),
      label: null, text: r.raw,
    }));
  return { id: 'detections', kind: 'event_log', title: 'Detections', events };
}

// Signal, rendered with the app's existing .sig-bars component. The QUALITY is
// computed here, not in the browser: signalQuality() is exported from utils.js
// so the server runs the same function the rest of the UI does — one algorithm,
// no second copy to drift. Tiers mirror app-nodes.js:219-226 exactly so this
// looks identical to every other signal indicator.
// `rssi`/`snr` on `nodes` are written ONLY from genuinely-direct reception
// (persist.js isDirect/COALESCE) but carry no timestamp of their own — once a
// node goes relay-only they freeze at their last direct value forever and
// nothing on the card said so, reading as a healthy current link indefinitely
// (task node-signal-freeze, 2026-07-25 — mt-transport chat report, real link
// was 2.5km/relayed while the card showed a bench-proximity reading). `sigTs`
// is the most recent `signal_history` row for this node — the same
// direct-only-gated table, so its age IS the age of the displayed rssi/snr.
function buildSignal(rssi, snr, sigTs, radioLabel = null, radioCount = 0) {
  if (rssi == null && snr == null) return null;
  const pct = signalQuality(rssi, snr);
  const label = pct >= 76 ? 'Excellent' : pct >= 51 ? 'Good' : pct >= 26 ? 'Fair' : 'Poor';
  const cls   = pct >= 51 ? 'text-success' : pct >= 26 ? 'text-warning' : 'text-error';
  const parts = compact([fmtRssi(rssi), fmtSnr(snr)]);
  return {
    rssi, snr, pct, label, cls,
    text: parts.join(' / '),
    // Split too: the combined string overflows a stat card, and RSSI is the
    // headline figure with SNR as its context.
    rssi_text: fmtRssi(rssi),
    snr_text: fmtSnr(snr),
    // Which of the four bars are lit — a decision, so the server makes it.
    bars: [0, 1, 2, 3].map(i => pct > i * 25),
    // Provenance in full: WHICH radio, and how old. The value is the BEST of
    // each radio's latest direct reading, so the tile names the radio that
    // produced it — a headline "-112 dBm" is meaningless when the two radios
    // sit 15 dB apart. `best of N` is stated only when there is more than one
    // radio to be best of, otherwise it implies a comparison that never
    // happened. Every part of this string is a row the Reachability section
    // also lists (docs/SIGNAL_SSOT_SPEC.md §2).
    desc: compact([
      radioCount > 1 ? `best of ${radioCount}` : null,
      radioLabel,
      sigTs != null ? `direct ${fmtAgo(sigTs)}` : null,
    ]).join(' · ') || null,
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
const GAS_BASELINE_DAYS = 7;
const GAS_MIN_SAMPLES   = 12;    // below this, no percentage is quoted at all
const GAS_MAD_K         = 6;     // reject beyond 6x MAD from the median (~4 sigma)

// Robust reference range: median-absolute-deviation outlier rejection, then the
// extremes of what survives.
//
// NOT percentiles — verified insufficient: with 8 samples, nearest-rank p95
// lands on the last element, so a single spurious reading (esp3 at 1115 MΩ)
// still defines the ceiling and flattens every real value to 0%. MAD stays
// robust at small n, which is exactly the regime this runs in.
function robustRange(values) {
  if (values.length < 3) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const devs = sorted.map(v => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = devs[Math.floor(devs.length / 2)];
  const keep = mad > 0 ? sorted.filter(v => Math.abs(v - med) <= GAS_MAD_K * mad) : sorted;
  if (keep.length < 2) return null;
  return { floor: keep[0], ceiling: keep[keep.length - 1], kept: keep.length, dropped: values.length - keep.length };
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
const GAS_LO_PCT        = 0.05;  // floor   — dirtiest air seen, outliers excluded
const GAS_HI_PCT        = 0.95;  // ceiling — cleanest air seen, outliers excluded

// Air quality from the BME680.
//
// There is NO fixed resistance->quality conversion: Bosch's BSEC learns a
// per-sensor baseline over days, resistance rises in clean air, and absolute
// values differ wildly between units — esp3 reports 1115 MΩ where DEV1 reports
// 0.055. So the percentage is normalised across THIS node's own observed range.
//
// Percentiles, not MIN()/MAX(): one spurious reading would otherwise define the
// scale and flatten every real value to 0%.
//
// Burn-in is deliberately NOT filtered. DEV1's readings climb monotonically
// while its heater stabilises, and that drift is part of the observed range.
// Detecting burn-in needs device-side state we do not have, and silently
// discarding early readings would be editorialising device data (iron rule 2).
// Printing the reference range makes the effect visible instead.
function buildAirQualitySection(num, envRows, since) {
  const gasRows = envRows.filter(r => typeof r.gas_resistance === 'number' && Number.isFinite(r.gas_resistance));
  if (!gasRows.length) return null;

  const all = stmts.queryGasValues
    .all(num, Math.floor(Date.now() / 1000) - GAS_BASELINE_DAYS * 86400)
    .map(r => r.v)
    .filter(v => typeof v === 'number' && Number.isFinite(v));

  const range   = robustRange(all);
  const floor   = range?.floor ?? null;
  const ceiling = range?.ceiling ?? null;
  const usable  = all.length >= GAS_MIN_SAMPLES && range != null && ceiling > floor;

  const rows = gasRows.map(r => ({
    ts: r.ts,
    gas_resistance: r.gas_resistance,
    air_quality: usable
      ? Math.max(0, Math.min(100, +(100 * (r.gas_resistance - floor) / (ceiling - floor)).toFixed(1)))
      : null,
  }));

  const specs = [];
  if (usable) specs.push({ key: 'air_quality', label: 'Air quality (rel.)', unit: '%' });
  specs.push({ key: 'gas_resistance', label: 'Gas resistance', unit: 'MΩ' });

  const section = buildSeriesSection('air_quality', 'Air quality', rows, specs);
  if (section) {
    // Always name the reference range. A narrow range is then self-evident
    // rather than hidden behind a confident-looking percentage.
    section.note = usable
      ? `0% = ${floor.toFixed(3)} MΩ · 100% = ${ceiling.toFixed(3)} MΩ `
        + `(this node, last ${GAS_BASELINE_DAYS} days, ${all.length} samples`
        + `${range.dropped ? `, ${range.dropped} outlier${range.dropped > 1 ? 's' : ''} excluded` : ''})`
      : `Learning range — ${all.length} of ${GAS_MIN_SAMPLES} samples needed before a percentage is meaningful.`;
  }
  return section;
}

// ─── Reachability ────────────────────────────────────────────────────────────
//
// The ONE section not sourced from our own SQLite. pac-host owns every fact
// here; we render them and add nothing (docs/REACHABILITY_SPEC.md). Present
// only when pac-host holds a unit for this num — absent for every other node,
// per the existing rule that a section appears only if it has data.
//
// JOINED HERE, NOT IN THE BROWSER. pac-host's roster reaches the browser on a
// different WS message (pac_host_status); merging the two client-side to decide
// what a tile says would be the browser deciding, and would create a second code
// path for one displayed value — exactly what the node_status RPC exists to
// prevent.
//
// EVERY FIELD STATES ITS KIND AND ITS AGE, OR STATES THAT IT HAS NEITHER. The
// counter-example is on this same page: the Hops tile renders a value verified
// on 14 Jul at live-data weight. Several fields below carry NO age because
// pac-host does not record when they were established — under the mechanical
// <field>At convention an absent sibling is detectable, so they render undated
// rather than borrowing another field's instant or being stamped with now().

// pac-host instants are epoch MILLISECONDS; fmtAgo/fmtUntil/fmtStamp take epoch
// SECONDS. The divide happens once, here, at the boundary. Missing it is silent
// and produces a plausible wrong answer — it has cost this repo a day before.
const msToSec = ms =>
  (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) ? Math.floor(ms / 1000) : null;

const WAKE_SOURCE_TEXT = {
  'always-listening': 'never sleeps — a command goes now',
  'device':           'schedule reported by the device',
  'measured':         'schedule derived from observed wakes',
  'unknown':          'never measured, never reported',
};

// The four states are NOT equally strong, and the page must not flatten them.
// A config claim is not evidence that anything reached the unit — the argument
// that got services to split this field (their commit 35b274a).
const AWAKE_SOURCE_TEXT = {
  'heard':         'heard inside its window',
  'device-stated': 'device says sleep is off — not proof we reached it',
  'inferred':      'inferred from silence',
  'unknown':       'never heard',
};

// pac-host names radios by !hex or BLE MAC; every other surface in this app
// says OMNI / YAGI. resolveDeviceLabel is that SSOT — user alias first, then
// short_name, then an honest fallback — and it takes either form, so the same
// radio cannot be called two different things on two parts of one page.

// acks is a SINGLE object summarising the most recent request of ANY verb —
// which is what "can we reach it" asks. NULL means NEVER COMMANDED, and renders
// as unknown, never as failure: Peter must be able to tell "not yet asked" from
// "asked and got nothing" at a glance.
function deliveryField(acks) {
  if (!acks) {
    return field('Delivery', 'never', 'not yet asked', null,
                 'no command has been sent to this unit');
  }
  const { verb, sends = 0, transmitted = 0, notSent = 0, unknownSent = 0,
          delivered = 0, settledAt } = acks;

  // FIVE numbers, never one boolean. `sends` counts POSTs mesh-gw ACCEPTED, not
  // transmissions: 15 of GARG's 131 sends in one day never left the radio and
  // every one was counted as a send (services, 2026-07-29). A single success
  // flag would have shown a green tick through the whole of 2026-07-28, while
  // every send was being refused.
  let text;
  if (delivered   > 0) text = 'delivered';
  else if (transmitted > 0) text = 'sent, no ack';
  else if (notSent     > 0) text = 'refused';
  else if (unknownSent > 0) text = 'sent, status unknown';
  else                      text = 'queued';

  const bits = [];
  if (verb) bits.push(verb);
  // Only stated when it disagrees — "1/1 left the radio" is noise, and the gap
  // is the whole point.
  if (sends > 0 && transmitted < sends) bits.push(`${transmitted}/${sends} left the radio`);
  const ago = fmtAgo(msToSec(settledAt));
  if (ago) bits.push(ago);

  return field('Delivery', text, text, null, bits.join(' · ') || null);
}

// nextWake:null has TWO meanings and wakeSource is what tells them apart.
// "always-listening" means send NOW; "unknown" means we have no idea. Treating
// them the same is a real bug — it is why the field exists.
function nextWindowField(u) {
  if (u.wakeSource === 'always-listening') {
    return field('Next window', 'always', 'always listening', null,
                 WAKE_SOURCE_TEXT['always-listening']);
  }
  const until = fmtUntil(msToSec(u.nextWake));
  if (until) {
    return field('Next window', u.nextWake, until, null, WAKE_SOURCE_TEXT[u.wakeSource] ?? null);
  }
  return field('Next window', 'unknown', 'unknown', null,
               WAKE_SOURCE_TEXT[u.wakeSource] ?? 'no schedule measured or reported');
}

// null and 0 mean DIFFERENT things and must not print the same string.
//   null — a category statement: an always-listening unit does not wake, so
//          there is no denominator and no percentage exists to compute. The old
//          110% came from counting telemetry transmissions against expected
//          wakes, comparing two different things. Render nothing at all.
//   0    — a real denominator that happens to be zero: nothing expected yet.
// Dividing by either is a defect, so neither path computes a percentage.
function wakeReliabilityField(u) {
  const exp  = u.wakesExpected;
  if (exp == null) return null;
  const seen  = u.wakesSeen ?? 0;
  const since = fmtAgo(msToSec(u.wakesSince));
  if (exp === 0) {
    return field('Wake reliability', seen, `${seen} seen`, null,
                 since ? `none expected yet · since ${since}` : 'none expected in this window yet');
  }
  return field('Wake reliability', seen, `${seen} of ${exp}`, null,
               since ? `since ${since}` : null);
}

// perRadio is passed in rather than re-queried: the header's Signal tile is
// computed from the SAME array, which is what makes header and section agree by
// construction instead of by convention.
function buildReachabilitySection(num, perRadio) {
  const u = unitForNum(num);
  if (!u) return null;

  const fields = compact([
    deliveryField(u.acks),
    nextWindowField(u),
    // No age: pac-host does not record when beat was established. Priority-one
    // on our ask to them, because nextWake is computed FROM beat — a stale beat
    // yields a confidently wrong countdown, which is worse than no answer.
    field('Beat', u.beat, fmtUptime(msToSec(u.beat)), null,
          u.beatSource ? `${u.beatSource}-reported` : null),
    field('Window', u.windowMs, fmtUptime(msToSec(u.windowMs)), null,
          // Published rather than omitted even when merely assumed: a blank is
          // indistinguishable from "we never asked", so an assumed value that
          // SAYS it is assumed is strictly more information than nothing.
          u.windowMsSource ?? u.windowSource ?? null),
    wakeReliabilityField(u),
    field('Awake', u.awake == null ? 'unknown' : u.awake,
          u.awake == null ? 'unknown' : (u.awake ? 'yes' : 'no'), null,
          AWAKE_SOURCE_TEXT[u.awakeSource] ?? null),
    field('TX radio', u.txRadio?.id ?? null,
          resolveDeviceLabel(u.txRadio?.addr || u.txRadio?.id) || null, null,
          u.txRadio?.state ? String(u.txRadio.state).toLowerCase() : null),
    // OUR signal_history, not pac-host's radios{}. services conceded per-radio
    // rssi/snr to us (xsession [data-ownership-3categories]): "we retain a
    // per-radio model internally because it drives RADIO SELECTION — that is a
    // mesh decision, not a display one. It is not published for rendering and it
    // is not a competing answer to yours." Rendering theirs added a third source
    // to a page that already had two too many, and it covers only the alarm
    // units. These are the same rows the header's Signal tile is computed from.
    ...perRadio.map(r => {
      const text = compact([fmtRssi(r.rssi), fmtSnr(r.snr)]).join(' · ');
      return field(`Heard by ${resolveDeviceLabel(r.rx_device)}`, text || null, text || null,
                   r.ts, `direct ${fmtAgo(r.ts)}`);
    }),
  ]);

  if (!fields.length) return null;
  return { id: 'reachability', kind: 'value_grid', title: 'Reachability', fields };
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
  // Read ONCE and shared by the header's Signal tile and the Reachability
  // section's "Heard by …" rows — the mechanism by which the two agree.
  const perRadio = stmts.latestDirectPerRadio.all(num);
  const lat = info?.lat ?? node?.lat ?? null;
  const lon = info?.lon ?? node?.lon ?? null;
  const homeLat = getConfig('home.lat', null);
  const homeLon = getConfig('home.lon', null);
  const nodeBearing = lat != null && lon != null && homeLat != null && homeLon != null
    ? bearing(homeLat, homeLon, lat, lon) : null;

  const header = {
    num,
    node_id:    src.node_id ?? node?.node_id ?? numToNodeId(num),
    long_name:  src.long_name  ?? node?.long_name  ?? null,
    short_name: src.short_name ?? node?.short_name ?? null,
    hw_model:   src.hw_model   ?? node?.hw_model   ?? null,
    last_heard: lastHeard == null ? null : {
      raw: lastHeard, text: fmtStamp(lastHeard), ago: fmtAgo(lastHeard, now),
    },
    // Every vital we hold — nothing withheld. An absent value omits its field:
    // API.md is explicit that channel_utilization is present only when the
    // device is awake and ABSENCE IS NOT ZERO, so a missing value must never
    // render as 0%.
    fields: compact([
      field('Battery',     node?.battery,        fmtPercent(node?.battery),      lastHeard),
      field('Voltage',     node?.voltage,        fmtVoltage(node?.voltage),      lastHeard),
      field('Uptime',      node?.uptime_seconds, fmtUptime(node?.uptime_seconds), lastHeard),
      leastHopsField(num, now),
      verifiedHopsField(info, num),
      field('Chan util',   node?.channel_util,   fmtUtil(node?.channel_util),    lastHeard),
      field('Air util TX', node?.air_util_tx,    fmtUtil(node?.air_util_tx),     lastHeard),
    ]),
    // BEST of each radio's LATEST direct reading — never nodes.rssi/snr, which
    // was ungated until 2026-07-29 and showed GARG at "-98 dBm / +6.8 dB" while
    // signal_history held nothing of the kind. Computed from the exact rows the
    // Reachability section lists, so header and section cannot disagree
    // (docs/SIGNAL_SSOT_SPEC.md §2).
    signal: (() => {
      if (perRadio.length) {
        const best = perRadio.reduce((a, b) => ((b.rssi ?? -Infinity) > (a.rssi ?? -Infinity) ? b : a));
        return buildSignal(best.rssi, best.snr, best.ts,
                           resolveDeviceLabel(best.rx_device), perRadio.length);
      }
      // No ATTRIBUTED row. Still a direct-gated reading — only the radio is
      // unknown — so it renders without a radio name rather than not at all.
      // Most of the mesh is in this state: 18,681 of 29,897 rows predate
      // rx_device and are deliberately not backfilled.
      const any = stmts.latestDirectAny.get(num);
      return any ? buildSignal(any.rssi, any.snr, any.ts, null, 0) : null;
    })(),
    position: compact([
      field('Latitude', lat, lat?.toFixed(5)),
      field('Longitude', lon, lon?.toFixed(5)),
      nodeBearing == null
        ? { label: 'Bearing', raw: null, text: '—' }
        : field('Bearing', nodeBearing, `${Math.round(nodeBearing)}°`),
    ]),
  };

  const dmRows  = stmts.queryDeviceMetricsHistory.all(num, since);
  const envRows = stmts.queryEnvHistory.all(num, since);
  const detRows = stmts.queryDetectionEvents.all(
    num, now - EVENT_WINDOW_DAYS * 86400, MAX_EVENTS);
  const sigRows = stmts.querySignalHistory.all(num, since);

  // Fixed order, each section present ONLY if it has data.
  // Reachability leads: the other sections answer what a unit IS, this one
  // answers whether we can REACH it — which is the only reason anyone opens
  // this page for an alarm unit.
  const sections = compact([
    buildReachabilitySection(num, perRadio),
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
  ]);

  return { num, found: true, window_h: hours, header, sections };
}
