import { EventEmitter } from 'events';
import { rotator } from './rotator.js';
import { getRotatorDeviceId } from './device-config.js';
import { getConfig } from './db.js';

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
    this._pollStart = 0;
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
    this._preMode = rotator.mode;
    this._active  = true;
    this._az      = 0;
    this._aborted = false;
    this._contacts = {};
    this._dwellAz  = null;
    rotator.setMode(0); // PASV during scan (transient, not persisted)
    this.emit('start', { step: this._step, dwell: this._dwell });
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
    const rotatorId = getRotatorDeviceId();
    if (rotatorId && ev.device !== rotatorId) return;
    const pkt = ev.data?.packet;
    if (!pkt?.from) return;
    const snr  = pkt.rx_snr  ?? null;
    const rssi = pkt.rx_rssi ?? null;
    if (snr == null && rssi == null) return;
    const az = this._dwellAz;
    const existing = this._contacts[az];
    if (!existing || snr > (existing.snr ?? -Infinity)) {
      const contact = { az, from: pkt.from, snr, rssi, ts: Math.floor(Date.now() / 1000) };
      this._contacts[az] = contact;
      this.emit('contact', contact);
    }
  }

  _doStep() {
    if (this._aborted || this._az >= 360) { this._end(); return; }
    this._dwellAz = null;
    this.emit('progress', { az: this._az, dwell_az: null });
    rotator.move(this._az);
    this._pollStart = Date.now();
    this._timer = setTimeout(() => this._pollIdle(), 600);
  }

  _pollIdle() {
    if (this._aborted) { this._end(); return; }
    const timedOut = Date.now() - this._pollStart > 25000;
    if (!rotator.status.busy || timedOut) {
      this._dwellAz = this._az;
      this.emit('progress', { az: this._az, dwell_az: this._az });
      this._timer = setTimeout(() => {
        this._dwellAz = null;
        this._az += this._step;
        this._doStep();
      }, this._dwell * 1000);
    } else {
      this._timer = setTimeout(() => this._pollIdle(), 200);
    }
  }

  _end() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._active  = false;
    this._dwellAz = null;
    rotator.setMode(this._preMode);
    this.emit('end', { aborted: this._aborted });
  }
}

export const scanner = new Scanner();
