// Device selection and BLE status display. All device-MANAGEMENT (BLE pairing,
// radio config editing, OTA flashing, removal) is gone — mesh-gw owns it
// (2026-09-03, task devices-management-removed-meshgw-owns-it). What remains
// is what the rest of the app needs to know WHICH device is active and
// whether it is reachable.
import { fetchJSON } from './app-helpers.js';
import { persistSet } from './app-persist.js';

export const devicesMixin = {
  get primaryDeviceId() {
    const e = Object.entries(this.deviceConfigs).find(([, c]) => c?.is_primary);
    if (!e) return this.availableDevices[0]?.node_id || '';
    const key = e[0]; // live node_id, or MAC fallback for non-live devices
    if (this.availableDevices.some(d => d.node_id === key)) return key;
    const live = this.availableDevices.find(d => d.addr?.toUpperCase() === key.toUpperCase());
    return live?.node_id || this.availableDevices[0]?.node_id || '';
  },

  get primaryDevBleState() {
    return this.deviceBleStates[this.primaryDeviceId] || {};
  },

  devBleState(nodeId) {
    return this.deviceBleStates[nodeId]?.ble_state || 'offline';
  },

  devIsSaving(nodeId) {
    return Object.keys(this.ops).some(k => k.endsWith('_' + nodeId) && this.ops[k]?.loading);
  },

  devBleLabel(nodeId) {
    const s = this.deviceBleStates[nodeId] || {};
    if (this.devIsSaving(nodeId)) return 'Saving config…';
    return s.label || '';
  },

  _clearDeviceState() {
    this.nodes = [];
    this.nodeSelf = {};
    this.nodeTotal = 0;
    this.nodeCount = 0;
    this.loraCfg = {};
  },

  // Accepts the device MAC (canonical) or a node_id during transition.
  // Persisting happens ONLY here and in set-primary — explicit user actions;
  // adoption/fallback writes never persist (set-active invariant).
  async selectDevice(key) {
    const dev = (this.availableDevices || []).find(d => d.addr === key || d.node_id === key);
    this.activeDevice = dev?.addr ?? key;
    persistSet('activeDevice', this.activeDevice);
    this._clearDeviceState();
    this.reconnectWS();
    await this.bootstrapDevice();
    if (this.tab === 'radar') this.initRadar();
  },

  async bootstrapDevice() {
    // node_list arrives via WS on connect — no HTTP calls needed
  },

  deviceLabel(nodeId) {
    if (!nodeId) return '';
    const upper = nodeId.toUpperCase();
    const d = this.availableDevices.find(d => d.node_id === nodeId || d.addr?.toUpperCase() === upper);
    return d?.display_name || '';
  },

  rotatorDeviceId() {
    const entry = Object.entries(this.deviceConfigs).find(([, c]) => c?.is_rotator);
    if (!entry) return null;
    const key = entry[0]; // live node_id, or MAC fallback for non-live devices
    if (this.availableDevices.some(d => d.node_id === key)) return key;
    const live = this.availableDevices.find(d => d.addr?.toUpperCase() === key.toUpperCase());
    return live?.node_id || null;
  },

  // Device settings arrive on the WS device_list (dev.cfg, MAC-keyed) —
  // the GET /device-config page-data fetch is gone (C2, WS-only transport).
  // Primary-as-active seeding lives in the device_list handler now.

  _rebuildDeviceConfigs() {
    const byMac = this._deviceConfigsByMac;
    if (!byMac) return;
    const configs = {};
    for (const [mac, cfg] of Object.entries(byMac)) {
      const liveDevice = (this.availableDevices || []).find(
        d => d.addr?.toUpperCase() === mac.toUpperCase()
      );
      configs[liveDevice?.node_id || mac] = cfg;
    }
    this.deviceConfigs = configs;
  },

  // Not device management — this is the Config tab's home-position field,
  // which happens to live in this mixin (2026-09-03: left in place rather
  // than moved, to avoid an unrelated diff mid-removal).
  async saveHomePosCfg() {
    this.homePosSaved = false;
    this.homePosError = '';
    try {
      const updated = await fetchJSON('/home_pos', 'PUT', {
        lat: this.homeLat != null && this.homeLat !== '' ? Number(this.homeLat) : null,
        lon: this.homeLon != null && this.homeLon !== '' ? Number(this.homeLon) : null,
      });
      this.homeLat = updated.lat ?? null;
      this.homeLon = updated.lon ?? null;
      this.homePosSaved = true;
      setTimeout(() => { this.homePosSaved = false; }, 2000);
    } catch (e) {
      this.homePosError = String(e);
    }
  },
};
