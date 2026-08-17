// Performance mixin: radio selection, antenna/chain config, and the SERVED link
// budget for the selected radio.
//
// WHAT THIS FILE USED TO BE, and why it is a fifth of its former size —
// 2026-08-17, spec docs/modules/traceroute-removal-browser.md. Peter: "I want
// all traces of it removed, browser and backend. it will be re-designed with no
// fragments remaining."
//
// Everything this page MEASURED came from traceroute_history rows: the success
// rate, the history table, the margin/SNR medians, the trend buckets, the
// scatter and its reference curve, the aggregate RF score, and the auto-trace
// scheduler that produced the rows in the first place. With nothing dispatching
// a traceroute, every one of those was an empty widget with a confident title.
//
// The 37,425 stored rows are UNTOUCHED in traceroute_history — Peter kept the
// data and dropped the reads. Whatever replaces the dispatcher can read them
// again, and the deleted arithmetic is in git, not lost.
//
// WHAT SURVIVES is the half that never needed a traceroute: which radio the page
// is scoped to, that radio's antenna/chain configuration, and the link budget
// the backend computes from them. That is theory — what this radio COULD do —
// and it is still true with no measurements to compare it against.
import { persistSet } from './app-persist.js';

export const perfMixin = {
  // ── Link budget ──────────────────────────────────────────────────────────
  //
  // THE PHYSICS IS GONE FROM HERE. Friis sensitivity, free-space path loss, the
  // thermal noise floor, EIRP, max range and the reference curve all moved to
  // src/link-budget.js and arrive computed. Peter, 2026-08-04: "the first thing
  // I want to do is to bring us back into compliance with the UI rules."
  //
  // Nothing in public/ may compute a link budget again.

  /** The served budget for the page's selected radio, or an empty object. */
  perfBudget() {
    const dev = this.perfDev();
    const d = (this.availableDevices || []).find(x => x.addr === dev);
    return d?.link_budget || {};
  },

  // Radio lora config rides the WS device_list (dev.lora, fetched by the
  // backend on READY) — no GET (C2). This adopts the selected radio's copy.
  adoptPerfLoraCfg() {
    const dev = (this.availableDevices || []).find(d => d.addr === this.perfDev());
    if (dev?.lora) this.loraCfg = dev.lora;
  },

  // Effective perf device: explicit selection, else the primary radio.
  // Perf scope key is the radio's BLE MAC (identity Phase B).
  perfDev() {
    let sel = this.perfDevice;
    // One-time shim: a persisted legacy !hex selection converts via the
    // device list, then re-persists as MAC.
    if (sel && !sel.includes(':')) {
      const mac = this.availableDevices.find(d => d.node_id === sel)?.addr;
      if (mac) { this.perfDevice = mac; persistSet('perfDevice', mac); sel = mac; }
    }
    const devs = this.availableDevices || [];
    if (sel && devs.some(d => d.addr === sel)) return sel;
    // No explicit pick. This used to rank radios by how many traceroute rows
    // each had produced, so the page followed dispatch to the rotator. With no
    // rows to count, the fallback is the plain one: primary, else first.
    const primary = devs.find(d => d.node_id === this.primaryDeviceId)?.addr;
    return primary || devs[0]?.addr || '';
  },

  // Antenna/chain config for the scoped device — read from the backend's
  // canonical MAC-keyed store, not the node_id re-keyed deviceConfigs map.
  perfDevCfg() {
    const mac = this.perfDev();
    return this._deviceConfigsByMac?.[mac?.toUpperCase()] ?? this.deviceConfigs?.[mac] ?? {};
  },

  async perfSetDevice(addr) {
    this.perfDevice = addr;
    persistSet('perfDevice', addr);
    this.loraCfg = {};              // force per-device reload of theory constants
    this.adoptPerfLoraCfg();
  },

  /** Formatter, kept because the link budget is still quoted in dB. */
  perfSignedDb(v, digits = 1, compact = false) {
    if (v == null || !Number.isFinite(v)) return '–';
    const sign = v > 0 ? '+' : '';
    return `${sign}${v.toFixed(digits)}${compact ? '' : ' '}dB`;
  },
};
