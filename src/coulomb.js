// The coulomb-counter display model. Domain 1: every derivation, every verdict
// and every formatted string is decided HERE, because docs/BROWSER_CONTRACT.md
// gives the browser none of those.
//
// Peter, 2026-08-08: "device is now pushing the coulomb count, looks like we are
// tracking this, but it is invisible to me in node-dash."
//
// THE MEASUREMENT IS (n1 - n0) / hours. Everything else in this file exists
// either to support that or to stop it being reported when it would be a lie.
//
// Spec: docs/modules/coulomb.md. Contract: xsession node-dash--services #87/#88.

import { getObs } from './pac-host.js';
import { fmtAgo, fmtStamp } from './format.js';

// `n` is the RAW accumulated count and the only field to subtract across.
// `cons` is the same charge as whole mAh — DERIVED, LOSSY, and scaled by a
// constant nobody has confirmed. It is served for cross-checking and is NEVER
// the headline. `grst` marks the gauge coming back zeroed.
const FIELD_N    = 'n';
const FIELD_CONS = 'cons';
const FIELD_GRST = 'grst';

// How much history to pull. The upstream `limit` takes the NEWEST n, so this is
// "the most recent 500 samples", not "the first 500".
const DEFAULT_LIMIT = 500;

/** Milliseconds in, seconds out — converted ONCE, here.
 *
 *  pac-host stamps `at` in milliseconds. This repo's convention is epoch seconds
 *  (see observations.js) and fmtAgo(ts, nowSec) takes seconds. Getting this
 *  wrong yields an age ~56000x too large, which is obvious, or a silently wrong
 *  rate, which is not. */
const msToSec = ms => Math.floor(Number(ms) / 1000);

/** ASSERTED, NOT ASSUMED.
 *
 *  Services state rows arrive oldest-first and that was verified ascending
 *  across 1000 rows on 2026-08-08. It is checked anyway on every call, because
 *  the operation downstream is a SUBTRACTION: a descending list flips its sign
 *  and a discharging cell reads as CHARGING. A silent re-order upstream would
 *  otherwise be invisible on a page that renders perfectly. One comparison. */
function assertAscending(rows) {
  for (let i = 1; i < rows.length; i++) {
    if (Number(rows[i].at) < Number(rows[i - 1].at)) {
      throw new Error(
        `pac-host /mesh/obs returned rows out of order at index ${i} ` +
        `(${rows[i - 1].at} then ${rows[i].at}). Refusing to subtract across them.`);
    }
  }
  return rows;
}

/** The display model for one unit's coulomb series — FETCHES.
 *
 *  `unit` is pac-host's `!hex` id — short names do not resolve upstream.
 *  Never throws for an absent gauge or an empty series; those are STATES, not
 *  errors, and each one says which it is. */
export async function buildCoulomb(unit, { spanHours = null, limit = DEFAULT_LIMIT } = {}) {
  return coulombModel(unit, await getObs(unit, { limit }) || [], { spanHours });
}

/** The same model from rows ALREADY IN HAND. Pure: no fetch, no clock beyond
 *  fmtAgo, no I/O.
 *
 *  THIS SPLIT IS LOAD-BEARING, not tidiness. The node page contributes its
 *  section through `registerNodeSection`, and `buildNodeStatus` is SYNCHRONOUS
 *  (node-status.js) — a provider cannot await. Without this entry point the
 *  node-page section would need its own copy of the subtraction, the grst
 *  refusal and the state rules, and two copies of a measurement drift apart
 *  silently. One implementation, two callers:
 *
 *    ws-relay `coulomb` RPC   -> buildCoulomb()  (fetches, for the Stats pane)
 *    alarm-sections provider  -> coulombModel()  (cached rows, for the node page)
 */
export function coulombModel(unit, rawRows, { spanHours = null } = {}) {
  const rows = assertAscending(rawRows || []);

  const nRows    = rows.filter(r => r.field === FIELD_N);
  const consRows = rows.filter(r => r.field === FIELD_CONS);
  const breaks   = rows.filter(r => r.field === FIELD_GRST).map(r => msToSec(r.at));

  // THE THREE STATES ARE FOUR TODAY, AND THE FOURTH IS THE HONEST ONE.
  //
  // Services' contract distinguishes NOT FITTED (the `ltc` verb answers
  // {ok:false, why:"not fitted"} and never zeros) from NO SAMPLES YET (fitted,
  // empty array). Telling them apart needs a field on /mesh/devices that DOES
  // NOT EXIST YET — verified 2026-08-08, no key on either unit matching
  // ltc/coul/gauge/fitted, while GARG's series is [].
  //
  // So an empty array cannot currently be attributed, and claiming either
  // reading would invent a fact. `unknown_gauge` says exactly what is known.
  // Services offered the field and node-dash accepted (#89); when it lands this
  // collapses to their three states and nothing else changes.
  if (!nRows.length) {
    return {
      unit,
      state: 'unknown_gauge',
      empty_reason: 'No coulomb data. pac-host has not reported whether a gauge is fitted to this unit, '
                  + 'so "no gauge" and "fitted but nothing recorded yet" cannot be told apart.',
      latest: null, current: null, series: [], breaks,
      cons_latest: null,
      caveat: CAVEAT,
    };
  }

  const last  = nRows[nRows.length - 1];
  const lastS = msToSec(last.at);

  return {
    unit,
    state: 'has_samples',
    empty_reason: null,
    latest: {
      n: Number(last.value),
      at: lastS,
      at_text: fmtStamp(lastS, { withSeconds: true }),
      // Pushed onward by ws-relay while the page is open — a browser timer
      // recomputing this is forbidden (BROWSER_CONTRACT transport rule).
      ago: fmtAgo(lastS),
    },
    current: derivedCurrent(nRows, breaks, spanHours),
    series: nRows.map(r => ({ at: msToSec(r.at), n: Number(r.value) })),
    breaks,
    // Cross-check only. Whole-mAh, derived, and it discards ~25x of the
    // resolution the hardware has — never the headline.
    cons_latest: consRows.length ? Number(consRows[consRows.length - 1].value) : null,
    caveat: CAVEAT,
  };
}

/** (n1 - n0) / hours over the widest span available, or a named span.
 *
 *  RETURNS A REFUSAL, NOT A NUMBER, WHEN THE SPAN CROSSES A `grst`. The gauge
 *  came back zeroed at that point, so the two endpoints have unrelated origins
 *  and subtracting them manufactures a current. It would render perfectly and be
 *  believed, which is the whole reason this is a refusal and not a caveat. */
function derivedCurrent(nRows, breaks, spanHours) {
  if (nRows.length < 2) {
    return { value_text: null, span_text: null, refused: true,
             refused_reason: 'Only one sample. A rate needs two.' };
  }

  const newest = nRows[nRows.length - 1];
  const newestS = msToSec(newest.at);
  const fromS = spanHours != null ? newestS - Math.round(spanHours * 3600) : msToSec(nRows[0].at);

  // First sample at or after the window start. Widest span when spanHours is null.
  const startIdx = nRows.findIndex(r => msToSec(r.at) >= fromS);
  const start = startIdx === -1 ? nRows[0] : nRows[startIdx];
  const startS = msToSec(start.at);

  if (startS === newestS) {
    return { value_text: null, span_text: null, refused: true,
             refused_reason: 'Only one sample in this span. A rate needs two.' };
  }

  const crossed = breaks.filter(b => b > startS && b <= newestS);
  if (crossed.length) {
    return {
      value_text: null,
      span_text: spanText(startS, newestS),
      refused: true,
      refused_reason: `The gauge was reset ${crossed.length === 1 ? 'once' : `${crossed.length} times`} `
                    + 'inside this span. The count restarted, so subtracting across it would report a '
                    + 'current that was never measured. Pick a span that does not cross a reset.',
    };
  }

  const hours = (newestS - startS) / 3600;
  const rate  = (Number(newest.value) - Number(start.value)) / hours;

  return {
    value_text: `${rate.toFixed(1)} counts/h`,
    span_text: spanText(startS, newestS),
    refused: false,
    refused_reason: null,
  };
}

function spanText(fromS, toS) {
  const h = (toS - fromS) / 3600;
  return h < 1 ? `over ${Math.round(h * 60)} min` : `over ${h.toFixed(1)} h`;
}

// Served with the model so the page states its own limits rather than relying on
// whoever reads it having read the spec.
const CAVEAT =
  'n is the raw accumulated count, unscaled. It is deliberately NOT converted to mAh or to a '
+ 'percentage: the scaling factor (qLsb) is unconfirmed, and a number multiplied by a wrong '
+ 'constant cannot be corrected later, whereas a raw count can. cons is whole-mAh and lossy — '
+ 'shown for cross-checking only.';
