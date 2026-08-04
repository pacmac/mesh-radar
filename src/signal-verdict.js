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

/** How much a sample count is worth. Was app-perf.js:357-363. */
export function sampleConfidence(n) {
  const c = Number(n) || 0;
  const level = c >= 40 ? 'high' : c >= 12 ? 'medium' : c > 0 ? 'low' : 'none';
  return { level, n: c };
}

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
  if (Math.abs(deltaDb) < 1) {
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

export { MARGIN_BANDS };
