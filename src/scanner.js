import { EventEmitter } from 'events';
import { point } from './aim-client.js';
import { isListenerForMode } from './dash-mode.js';
import { getConfig, setConfig } from './db.js';

// move_giveup_ms — how long to wait for a step's point() to resolve before
// moving on regardless. mesh-gw's aim plugin answers synchronously (arrived,
// busy, or its own timeout) per call — 2026-09-03, task
// rotator-command-via-meshgw-aim — so there is no separate poll cadence to
// tune any more; poll_idle_ms/poll_busy_ms are gone with the poll loop they
// timed. move_giveup_ms is now point()'s own timeoutMs.
//
// Declared and overridable — Peter, 2026-08-04: "all timings need to be vars.
// some if not all will be selected to be configurables / knobs."
const TIMING_DEFAULTS = { move_giveup_ms: 25_000 };
const timing = () => ({ ...TIMING_DEFAULTS, ...(getConfig('scanner_timing', {}) || {}) });


class Scanner extends EventEmitter {
  constructor() {
    super();
    this._active   = false;
    this._az       = 0;
    this._step     = 5;
    this._dwell    = 60;
    this._preMode  = 0;
    this._dwellAz  = null;
    this._timer    = null;
    this._aborted  = false;
    this._contacts = {};
  }

  get active()   { return this._active; }
  get az()       { return this._az; }
  get dwellAz()  { return this._dwellAz; }
  get contacts() { return this._contacts; }

  start() {
    if (this._active) return;
    const savedScan = getConfig('scan_config', {});
    this._step    = savedScan.step_deg  ?? 5;
    this._dwell   = savedScan.dwell_sec ?? 60;
    this._preMode = getConfig('rotator.dash_mode', 0);
    this._active  = true;
    this._az      = 0;
    this._aborted = false;
    this._contacts = {};
    this._dwellAz  = null;
    setConfig('scan_state', { active: true, az: 0, step: this._step, dwell: this._dwell, contacts: {}, preMode: this._preMode });
    this.emit('start', { step: this._step, dwell: this._dwell });
    this._doStep();
  }

  // Resume after server restart — restores contacts and continues from saved az
  resume(state) {
    if (this._active) return;
    this._step     = state.step  ?? 5;
    this._dwell    = state.dwell ?? 60;
    this._preMode  = state.preMode ?? 0;
    this._active   = true;
    this._az       = state.az ?? 0;
    this._aborted  = false;
    this._contacts = state.contacts ?? {};
    this._dwellAz  = null;
    this.emit('start', { step: this._step, dwell: this._dwell, resumed: true, az: this._az, contacts: this._contacts });
    this._doStep();
  }

  abort() {
    if (!this._active) return;
    this._aborted = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._end();
  }

  handlePacket(ev) {
    if (!this._active || this._dwellAz == null) return;
    // Only accept receptions on a radio that is a listener for SCAN (default: the rotator/YAGI).
    if (!isListenerForMode('scan', ev.addr)) return;
    const pkt = ev.data?.packet;
    if (!pkt?.from) return;
    // Direct receptions ONLY. A relayed packet is the RELAY's RF arriving at
    // the antenna — attributing it to the originator's bearing poisons the
    // polar pattern (2026-07-04 sweep: a relay blast at -28 dBm registered
    // as a "peak" 151° off the originator's true bearing). hop_start ===
    // hop_limit is the only proof the transmitter was the originator;
    // packets missing either field are dropped — unprovable ≠ direct.
    if (pkt.hop_start == null || pkt.hop_limit == null || pkt.hop_start !== pkt.hop_limit) return;
    const snr  = pkt.rx_snr  ?? null;
    const rssi = pkt.rx_rssi ?? null;
    if (snr == null && rssi == null) return;
    const az = this._dwellAz;
    const existing = this._contacts[az];
    if (!existing || snr > (existing.snr ?? -Infinity)) {
      const contact = { az, from: pkt.from, snr, rssi, ts: Math.floor(Date.now() / 1000) };
      this._contacts[az] = contact;
      setConfig('scan_state', { active: true, az: this._az, step: this._step, dwell: this._dwell, contacts: this._contacts, preMode: this._preMode });
      this.emit('contact', contact);
    }
  }

  async _doStep() {
    if (this._aborted || this._az >= 360) { this._end(); return; }
    this._dwellAz = null;
    setConfig('scan_state', { active: true, az: this._az, step: this._step, dwell: this._dwell, contacts: this._contacts, preMode: this._preMode });
    this.emit('progress', { az: this._az, dwell_az: null });
    // Fail fast, never queue behind a hold — a sweep step that waited out the
    // garage alarm's hold would stall the whole scan; move on to the next
    // bearing instead. mesh-gw's aim plugin resolves this call itself (arrived
    // or busy) or gives up at its own timeoutMs — no separate poll needed.
    await point(this._az, { by: 'scanner', patienceMs: 0, timeoutMs: timing().move_giveup_ms });
    if (this._aborted) return;
    this._dwellAz = this._az;
    this.emit('progress', { az: this._az, dwell_az: this._az });
    this._timer = setTimeout(() => {
      this._dwellAz = null;
      this._az += this._step;
      this._doStep();
    }, this._dwell * 1000);
  }

  _end() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._active  = false;
    this._dwellAz = null;
    setConfig('scan_state', { active: false });
    this.emit('end', { aborted: this._aborted });
  }
}

export const scanner = new Scanner();
