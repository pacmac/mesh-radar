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
