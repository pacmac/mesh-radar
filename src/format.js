// Display formatting — single source of truth.
//
// NODE_STATUS_SPEC iron rule 1: every conversion, rounding and formatting
// happens server-side, so any consumer (page, export, script) reads identical
// strings. The browser binds `text` verbatim and computes nothing.
//
// NODE_STATUS_SPEC iron rule 2: VALUES, NOT VERDICTS. Nothing here grades,
// judges or editorialises. No "healthy", no "battery low", no quality bands.
// (utils.js signalQuality() returns a judgement — deliberately not used by the
// node-status path.)
//
// Null in → null out, always. An absent value is absent: never the string
// "null", never "n/a", never a zero standing in for missing data. Callers omit
// the field rather than rendering a placeholder.

const n = v => (typeof v === 'number' && Number.isFinite(v));

export function fmtVoltage(v)   { return n(v) ? `${v.toFixed(2)} V`   : null; }
export function fmtPercent(p)   { return n(p) ? `${Math.round(p)}%`   : null; }
export function fmtUtil(p)      { return n(p) ? `${p.toFixed(1)}%`    : null; }
export function fmtTemp(c)      { return n(c) ? `${c.toFixed(1)} °C`  : null; }
export function fmtHumidity(h)  { return n(h) ? `${Math.round(h)} %RH`: null; }
export function fmtPressure(hp) { return n(hp) ? `${Math.round(hp)} hPa` : null; }
export function fmtGas(m)       { return n(m) ? `${m.toFixed(1)} MΩ`  : null; }
export function fmtRssi(d)      { return n(d) ? `${Math.round(d)} dBm`: null; }
export function fmtSnr(d)       { return n(d) ? `${d.toFixed(1)} dB`  : null; }
export function fmtCount(c)     { return n(c) ? `${Math.round(c)}`    : null; }

// Duration as the device reports it. Largest two units only — "2d 4h" reads
// better than "2d 4h 13m 7s" and the raw value is always alongside.
export function fmtUptime(sec) {
  if (!n(sec) || sec < 0) return null;
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// Absolute timestamp, local time, seconds precision.
export function fmtTimestamp(ts) {
  if (!n(ts) || ts <= 0) return null;
  const d = new Date(ts * 1000);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Compact absolute stamp. "2026-07-19 07:08:22" is 19 characters of which the
// reader usually needs four: the year is nearly always this year, and the date
// is nearly always today. Drop what is implied by context, keep what is not.
//
//   today          -> "07:08"
//   this year      -> "19 Jul 07:08"
//   older          -> "19 Jul 25 07:08"
//
// `withSeconds` is for logs, where events seconds apart must stay
// distinguishable (four MOTION events inside 31s would otherwise collapse to
// the same label).
export function fmtStamp(ts, { withSeconds = false, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!n(ts) || ts <= 0) return null;
  const d = new Date(ts * 1000);
  const t = new Date(now * 1000);
  const p = x => String(x).padStart(2, '0');
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}` + (withSeconds ? `:${p(d.getSeconds())}` : '');
  const sameDay = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() && d.getDate() === t.getDate();
  if (sameDay) return clock;
  const datePart = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === t.getFullYear()
    ? `${datePart} ${clock}`
    : `${datePart} ${String(d.getFullYear()).slice(2)} ${clock}`;
}

// Chart x-axis tick label. The format follows the span being rendered — clock
// time within a day, date + clock beyond it — so a 1 HR window is not cluttered
// with repeated dates and a 72 HR window is not ambiguous.
//
// This lives server-side for the same reason every other string does (iron rule
// 1): choosing a format is a presentation decision, and the browser makes none.
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function fmtAxisTick(ts, spanSec = 0) {
  if (!n(ts) || ts <= 0) return null;
  const d = new Date(ts * 1000);
  const p = x => String(x).padStart(2, '0');
  const clock = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return spanSec > 86400 ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock}` : clock;
}

// Relative age. Computed server-side and therefore correct only at emission —
// the browser re-requests on node_status_update rather than ticking this
// locally, because recomputing it in the browser would be the browser deciding.
export function fmtAgo(ts, nowSec = Math.floor(Date.now() / 1000)) {
  if (!n(ts) || ts <= 0) return null;
  const s = Math.max(0, nowSec - ts);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
