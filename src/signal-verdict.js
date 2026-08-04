// signal-verdict — how good is a link, in words. BACKEND ONLY.
//
// The browser held this: app-nodes.js turned an RSSI/SNR percentage into
// "Excellent / Good / Fair / Poor" plus the CSS classes to show it in.
// CLAUDE.md Domain 2 — the browser "makes zero decisions", and
// BROWSER_CONTRACT is blunter still: "if a display differs based on a condition,
// that condition is evaluated in Node.js".
//
// A BUG THIS EXPOSED: the labels used >=76/51/26 while the colour ramp beside
// them (sigQualColor) used >=75/50/25. A node at 75% therefore read "Good" while
// being painted the excellent colour. Two threshold sets, one screen, both live.
// One set now, here.

// Bands, strongest first. `tone` is a semantic name; the browser maps it to
// whatever CSS it likes, which IS its job.
const BANDS = [
  { min: 76, label: 'Excellent', tone: 'success' },
  { min: 51, label: 'Good',      tone: 'success' },
  { min: 26, label: 'Fair',      tone: 'warning' },
  { min: 0,  label: 'Poor',      tone: 'error'   },
];

/** Verdict for a link quality percentage.
 *
 *  `none: true` means we have no reading at all — which is NOT the same as a
 *  reading of zero, and must not render as "Poor".
 */
export function signalVerdict(pct, { hasReading = true } = {}) {
  if (!hasReading || pct == null) {
    return { pct: null, label: 'No signal', tone: 'muted', none: true };
  }
  const band = BANDS.find(b => pct >= b.min) ?? BANDS[BANDS.length - 1];
  return { pct, label: band.label, tone: band.tone, none: false };
}

export { BANDS as SIGNAL_BANDS };

// ─── Link-budget headroom ────────────────────────────────────────────────────
//
// THE SAME DEFECT, ONE LAYER UP. perf-maths-to-backend moved the RF maths here
// (src/link-budget.js) and ws-relay now serves `margin_tx_db` — but the browser
// went on deciding what that number MEANT, with app-perf.js:308-315 owning the
// labels and :333-344 owning the bars.
//
// AND IT HAD THE BUG THIS FILE EXISTS TO KILL, already: perfHealthBars() chose
// the bar COUNT from 20/10/3/0 and the COLOUR from 10/0. Two band tables inside
// one widget. One table now — and it is behaviour-preserving, because each
// band's tone equals what the old colour rule produced at every boundary
// (25→success, 15→success, 5→warning, 1→warning, -1→error).
const MARGIN_BANDS = [
  { min: 20,       label: 'Excellent', desc: 'Plenty of signal headroom',        tone: 'success', bars: 4 },
  { min: 10,       label: 'Good',      desc: 'Comfortable margin',               tone: 'success', bars: 3 },
  { min: 3,        label: 'Usable',    desc: 'Works, but not much spare margin', tone: 'warning', bars: 2 },
  { min: 0,        label: 'Fragile',   desc: 'Close to the decode limit',        tone: 'warning', bars: 1 },
  { min: -Infinity, label: 'Failing',  desc: 'Below the reliable decode limit',  tone: 'error',   bars: 0 },
];

/** Verdict for link-budget headroom in dB.
 *
 *  `bars` is a COUNT (0-4), never markup — the browser draws them. A null
 *  margin is "No data", which is not the same as a failing link and must not
 *  render as one.
 */
export function marginHealth(marginDb) {
  if (marginDb == null || !Number.isFinite(marginDb)) {
    return { label: 'No data', desc: 'Need valid traceroute samples', tone: 'muted', bars: 0, none: true };
  }
  const b = MARGIN_BANDS.find(x => marginDb >= x.min) ?? MARGIN_BANDS[MARGIN_BANDS.length - 1];
  return { label: b.label, desc: b.desc, tone: b.tone, bars: b.bars, none: false };
}

// Ordered, strongest first — same shape as MARGIN_BANDS so one lookup rule
// serves both. Exported because the browser's perf SUMMARY is a client-side
// median with no row to carry a verdict; see docs/modules/verdict-bands.md.
const CONFIDENCE_BANDS = [
  { min: 40, level: 'high'   },
  { min: 12, level: 'medium' },
  { min: 1,  level: 'low'    },
  { min: 0,  level: 'none'   },
];

/** How much a sample count is worth. Was app-perf.js:357-363. */
export function sampleConfidence(n) {
  const c = Number(n) || 0;
  const band = CONFIDENCE_BANDS.find(b => c >= b.min) ?? CONFIDENCE_BANDS[CONFIDENCE_BANDS.length - 1];
  return { level: band.level, n: c };
}

// A change smaller than this is noise, not a trend. The browser's rule,
// preserved and now owned here.
const TREND_DEAD_BAND_DB = 1;

// Traceroute success rate. Was in a TEMPLATE — tab-perf.html:42-43 — which is
// how it survived the first sweep of app-*.js.
const SUCCESS_RATE_BANDS = [
  { min: 90, tone: 'success' },
  { min: 60, tone: 'warning' },
  { min: 0,  tone: 'error'   },
];

/** Verdict for a traceroute success-rate percentage. */
export function successRateTone(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) return 'muted';
  const b = SUCCESS_RATE_BANDS.find(x => Number(pct) >= x.min) ?? SUCCESS_RATE_BANDS[SUCCESS_RATE_BANDS.length - 1];
  return b.tone;
}

// How recent a live yagi reading must be to count as current. tab-radar.html
// and app-radar.js each hardcoded 30 — three copies of one rule.
const LIVE_SIGNAL_FRESH_SEC = 30;

// Measured-vs-theory penalty in dB. Lower is better, so these read the other
// way round from every band above — which is exactly why they belong here and
// not in a :class attribute. Was tab-perf.html:243 (SNR gap) and
// tab-range.html:64,157 (excess path loss).
const GAP_BANDS = [
  { max: 15,   tone: 'success' },
  { max: 35,   tone: 'warning' },
  { max: null, tone: 'error'   },
];
const EXCESS_LOSS_BANDS = [
  { max: 0,    tone: 'success' },   // at or better than free-space theory
  { max: 10,   tone: 'warning' },
  { max: null, tone: 'error'   },
];
const lowerIsBetter = (bands) => (v) => {
  if (v == null || !Number.isFinite(Number(v))) return 'muted';
  const n = Number(v);
  return (bands.find(b => b.max == null || n < b.max) ?? bands[bands.length - 1]).tone;
};

/** SNR gap: how far below theory a link measured. Lower is better. */
export const gapTone = lowerIsBetter(GAP_BANDS);

/** Excess path loss vs FSPL. `<= 0` is better than theory, hence the shifted
 *  boundary: the old template used `<= 0` for success and `< 10` for warning. */
export function excessLossTone(db) {
  if (db == null || !Number.isFinite(Number(db))) return 'muted';
  const n = Number(db);
  return n <= 0 ? 'success' : n < 10 ? 'warning' : 'error';
}

// A target that answers less than this fraction of the time is worth flagging.
// Was `(f.hits / f.attempts) < 0.1` in tab-observatory.html:426 — the browser
// doing the division AND setting the bar.
const POOR_HIT_RATE = 0.1;

/** Hit rate verdict. Serves the RATE too: the browser was dividing. */
export function hitRateVerdict(hits, attempts) {
  const a = Number(attempts) || 0;
  if (!a) return { rate: null, tone: 'muted' };
  const rate = (Number(hits) || 0) / a;
  return { rate: +(rate * 100).toFixed(1), tone: rate < POOR_HIT_RATE ? 'warning' : 'muted' };
}

// How long since we heard a node, in the three steps the node list paints.
// Was tab-nodes.html:163-164, which also did its own Date.now() arithmetic.
const HEARD_BANDS = [
  { max: 1800,  tone: 'muted'   },   // under 30 min — unremarkable
  { max: 3600,  tone: 'warning' },   // under an hour
  { max: null,  tone: 'error'   },
];
export const heardTone = lowerIsBetter(HEARD_BANDS);

/** Direction of travel for median margin, with the 1 dB dead-band preserved
 *  from app-perf.js:373-386 — a change under 1 dB is noise, not a trend.
 *
 *  Note ±1.0 exactly is better/worse, not flat: the test is `< 1`, as it was. */
export function trendVerdict(deltaDb) {
  if (deltaDb == null || !Number.isFinite(deltaDb)) {
    return { direction: 'baseline', label: 'No baseline yet', tone: 'muted', delta: null };
  }
  const sign = deltaDb > 0 ? '+' : '';
  const db   = `${sign}${deltaDb.toFixed(1)} dB`;
  if (Math.abs(deltaDb) < TREND_DEAD_BAND_DB) {
    return { direction: 'flat', label: `${db} · little change`, tone: 'warning', delta: deltaDb };
  }
  const better = deltaDb > 0;
  return {
    direction: better ? 'better' : 'worse',
    label:     `${db} · ${better ? 'better' : 'worse'}`,
    tone:      better ? 'success' : 'error',
    delta:     deltaDb,
  };
}

/** Tone for a hop count. Was app-components.js:43-45.
 *
 *  Only the 0/1/2 THRESHOLD moves. The badge's text — "Direct" vs "n hops",
 *  and the verified/reported suffix — is display composition and stays in the
 *  browser. */
export function hopsTone(hops) {
  if (hops == null) return 'muted';
  const h = Number(hops);
  if (!Number.isFinite(h)) return 'muted';
  return h === 0 ? 'success' : h === 1 ? 'info' : h === 2 ? 'warning' : 'error';
}

/** BLE link percentage from the gateway — NOT a LoRa RF measurement, and it
 *  deliberately does not share signalVerdict's 76/51/26 bands. Two bands, as
 *  app-components.js:80 had them. */
export function blePctTone(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) return 'muted';
  const p = Number(pct);
  return p >= 50 ? 'success' : p >= 25 ? 'warning' : 'error';
}

export { MARGIN_BANDS, CONFIDENCE_BANDS, TREND_DEAD_BAND_DB, SUCCESS_RATE_BANDS, LIVE_SIGNAL_FRESH_SEC };

/** The band tables, wire-safe, for the browser to look up against.
 *
 *  THE SAME CONSTANTS the functions above use — there is no second copy, which
 *  is the whole point: a served table that could drift from marginHealth()
 *  would re-create the 76/51/26-vs-75/50/25 defect this module exists to kill.
 *
 *  -Infinity does not survive JSON.stringify (it serialises as null), so the
 *  catch-all band's `min` is emitted as an explicit null and the browser's
 *  lookup treats null as "always matches". */
export function verdictBands() {
  return {
    // THE OTHER HALF OF THE ORIGINAL BUG. This module's header records that the
    // labels used 76/51/26 while "the colour ramp beside them (sigQualColor)
    // used 75/50/25". Serving `signal {pct,label,tone}` per node fixed the
    // LABELS. The ramp was never fixed — app-nodes.js:273-279 still holds
    // 75/50/25, and tab-radar.html:354 still calls it.
    //
    // It cannot just read node.signal.tone: the radar card's percentage comes
    // from a LIVE yagi reading that may not be the node's stored value, so no
    // per-node verdict describes it. Serving the table lets the browser look
    // that live percentage up against the SAME numbers the server uses.
    signal: BANDS.map(b => ({ min: b.min, label: b.label, tone: b.tone })),
    signal_none: signalVerdict(null, { hasReading: false }),
    margin: MARGIN_BANDS.map(b => ({
      min: Number.isFinite(b.min) ? b.min : null,
      label: b.label, desc: b.desc, tone: b.tone, bars: b.bars,
    })),
    margin_none: marginHealth(null),
    confidence: CONFIDENCE_BANDS.map(b => ({ min: b.min, level: b.level })),
    trend_dead_band_db: TREND_DEAD_BAND_DB,
    // Both of these lived in TEMPLATES, which is why the first sweep of
    // app-*.js missed them: tab-perf.html:42-43 and tab-radar.html:278.
    success_rate: SUCCESS_RATE_BANDS.map(b => ({ min: b.min, tone: b.tone })),
    live_signal_fresh_sec: LIVE_SIGNAL_FRESH_SEC,
    // LOWER IS BETTER, so these carry `max` rather than `min` and the browser
    // must not reuse the ascending lookup on them. app-range's median is
    // client-side (same reason as the perf medians), so it needs the table.
    excess_loss: EXCESS_LOSS_BANDS.map(b => ({ max: b.max, tone: b.tone })),
  };
}
