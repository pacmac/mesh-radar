// link-budget — LoRa RF physics. BACKEND ONLY.
//
// Peter, 2026-08-04: "the first thing I want to do is to bring us back into
// compliance with the UI rules."
//
// This lived in public/app-perf.js: the Friis equation, free-space path loss,
// thermal noise floor, receiver noise figure, EIRP and an inverted link budget —
// radio physics computed in the presentation layer. CLAUDE.md Domain 2: the
// browser "owns rendering and user interaction only" and "makes zero decisions".
// A path-loss exponent is not a rendering decision.
//
// Its own module, not folded into core, for the same reason src/snr.js is:
// src/utils.js is SERVED to the browser verbatim as GET /utils.js, so anything
// placed there is shipped straight back into the layer this is leaving.

// Regional centre frequencies. The radio reports its region; we map it once.
const REGION_FREQ_MHZ = {
  EU_868: 868.0, US: 915.0, EU_433: 433.0, CN: 470.0, JP: 923.0,
  ANZ: 915.0, KR: 921.0, TW: 923.0, RU: 868.0, IN: 866.0, NZ_865: 865.0,
  TH: 923.0, UA_433: 433.0, UA_868: 868.0, MY_433: 433.0, MY_919: 919.0, SG_923: 923.0,
};

// Minimum decodable SNR per spreading factor — the demodulator's floor.
const SF_SNR_LIMIT = { 6: -5, 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

// Receiver noise figure. A property of the SX126x, not of any one install.
const RX_NOISE_FIGURE_DB = 6;

// Boosted RX gain improves the noise figure by roughly this much.
const BOOST_GAIN_DB = 1.5;

// kT at 290 K, in dBm/Hz. The thermal floor everything else is measured against.
const KT_DBM_HZ = -174;

const freqMhz = (lora) => REGION_FREQ_MHZ[lora?.region ?? 'EU_868'] ?? 868.0;
const sfLimit = (lora) => SF_SNR_LIMIT[lora?.spread_factor ?? 11] ?? -17.5;
const bwHz    = (lora) => (lora?.bandwidth ?? 250) * 1000;

/** Thermal noise floor: kTB + NF. The reference the chip's own SNR is measured
 *  against, so a theoretical SNR built on it is directly comparable to a
 *  reported one. */
export function noiseFloorDbm(lora) {
  return KT_DBM_HZ + 10 * Math.log10(bwHz(lora)) + RX_NOISE_FIGURE_DB;
}

/** Friis: sensitivity = kTB + NF + SNR_min. */
export function rxSensitivityDbm(lora) {
  const s = noiseFloorDbm(lora) + sfLimit(lora);
  return lora?.sx126x_rx_boosted_gain ? s + BOOST_GAIN_DB : s;
}

/** Radiated power: what leaves the antenna, not what leaves the chip. */
export function eirpDbm(lora, devCfg) {
  return (lora?.tx_power ?? 0) + (devCfg?.gain_dbi ?? 0) - (devCfg?.cable_loss_db ?? 0);
}

/** Free-space path loss in dB. */
export function fsplDb(distKm, mhz) {
  if (!(distKm > 0)) return 0;
  return 20 * Math.log10(distKm) + 20 * Math.log10(mhz) + 32.45;
}

/** Theoretical chip-reported SNR in free space at distKm. */
export function theoreticalSnrDb(distKm, lora, devCfg) {
  if (!(distKm > 0)) return null;
  return eirpDbm(lora, devCfg) - fsplDb(distKm, freqMhz(lora)) - noiseFloorDbm(lora);
}

/** Max range under a log-distance model. n=2 free space, 3 rural, 4 urban. */
export function maxRangeKm(lora, devCfg, n = 3) {
  const lb = eirpDbm(lora, devCfg) - rxSensitivityDbm(lora);
  const fspl1km = 20 * Math.log10(freqMhz(lora)) + 32.45;
  return Math.pow(10, (lb - fspl1km) / (10 * n));
}

/** How far above the demodulation floor a reading sits. Positive = headroom. */
export function marginDb(snrDb, lora) {
  return snrDb == null ? null : snrDb - sfLimit(lora);
}

/** Excess path loss over free space. Positive = the real world costs more,
 *  which it always does. */
export function snrGapDb(snrDb, distKm, lora, devCfg) {
  if (snrDb == null || !(distKm > 0)) return null;
  const theo = theoreticalSnrDb(distKm, lora, devCfg);
  return theo == null ? null : theo - snrDb;
}

/** Expected RSSI at the receiver, and how much worse reality was.
 *
 *  The range-test page derived this itself: FSPL, both ends' EIRP, and the
 *  excess over free space. It also carried a THIRD copy of the region table,
 *  which had drifted — JP 920 vs 923, KR 920 vs 921, IN 865 vs 866 — and used
 *  32.4 for the FSPL constant where this module uses 32.45. Same formula, two
 *  answers, both live (B80).
 *
 *  txCfg / rxCfg are the per-device antenna configs; region comes from whichever
 *  radio received, as the page did it.
 */
export function expectedRssiDbm(distKm, region, txCfg, rxCfg) {
  if (!(distKm > 0)) return null;
  const mhz    = REGION_FREQ_MHZ[region] ?? 868.0;
  const txEirp = (txCfg?.tx_power_dbm ?? 22) + (txCfg?.gain_dbi ?? 2) - (txCfg?.cable_loss_db ?? 0);
  const rxGain = (rxCfg?.gain_dbi ?? 2) - (rxCfg?.cable_loss_db ?? 0);
  return Math.round(txEirp + rxGain - fsplDb(distKm, mhz));
}

/** Positive = the real world cost more than free space, which it always does. */
export function excessLossDb(rssi, expectedRssi) {
  if (rssi == null || expectedRssi == null) return null;
  return +(expectedRssi - rssi).toFixed(1);
}

/** The theoretical SNR-above-floor curve, as points.
 *
 *  The perf page draws "ideal (free space)" and "rural" reference lines against
 *  its scatter. The SHAPE is physics and belongs here; only the x-range the page
 *  chooses to show is display, so the curve is served over a generous fixed
 *  domain and the browser clips it to whatever axis it is drawing.
 *
 *  rural applies the usual log-distance excess over free space.
 */
export function referenceCurve(lora, devCfg, { maxKm = 250, points = 80 } = {}) {
  const out = [];
  for (let i = 1; i <= points; i++) {
    const km = (i / points) * maxKm;
    const theo = theoreticalSnrDb(km, lora, devCfg);
    if (theo == null) continue;
    const ideal = theo - sfLimit(lora);
    out.push({
      km:       +km.toFixed(2),
      ideal_db: +ideal.toFixed(2),
      rural_db: +(ideal - 10 * Math.log10(km)).toFixed(2),
    });
  }
  return out;
}

/** The whole per-radio budget, for a page that wants to show the theory. */
export function budget(lora, devCfg) {
  return {
    freq_mhz:            freqMhz(lora),
    sf_snr_limit_db:     sfLimit(lora),
    noise_floor_dbm:     +noiseFloorDbm(lora).toFixed(2),
    rx_sensitivity_dbm:  +rxSensitivityDbm(lora).toFixed(2),
    eirp_dbm:            +eirpDbm(lora, devCfg).toFixed(2),
    max_range_km:        +maxRangeKm(lora, devCfg).toFixed(1),
    // The reference lines, so the page never evaluates Friis itself.
    reference_curve:     referenceCurve(lora, devCfg),
  };
}
