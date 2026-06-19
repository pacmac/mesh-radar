import { EventEmitter } from 'events';
import { getConfig, setConfig } from './db.js';

class DashMode extends EventEmitter {
  get value() {
    return getConfig('rotator.dash_mode', 0);
  }

  set(mode) {
    setConfig('rotator.dash_mode', mode);
    this.emit('change', { _mode: mode });
  }
}

export const dashMode = new DashMode();
