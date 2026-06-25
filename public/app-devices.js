// Device and BLE management mixin.
import { fetchJSON } from './app-helpers.js';
import { persistSet } from './app-persist.js';

export const devicesMixin = {
  get primaryDeviceId() {
    const e = Object.entries(this.deviceConfigs).find(([, c]) => c?.is_primary);
    return e?.[0] || this.availableDevices[0]?.node_id || '';
  },

  get primaryDevBleState() {
    return this.deviceBleStates[this.primaryDeviceId] || {};
  },

  devBleState(nodeId) {
    return this.deviceBleStates[nodeId]?.ble_state || 'idle';
  },

  devIsReady(nodeId) { return this.devBleState(nodeId) === 'ready'; },

  devIsSaving(nodeId) {
    return Object.keys(this.ops).some(k => k.endsWith('_' + nodeId) && this.ops[k]?.loading);
  },

  devBleLabel(nodeId) {
    const s = this.deviceBleStates[nodeId] || {};
    if (this.devIsSaving(nodeId)) return 'Saving config…';
    return { connecting: 'Connecting…', syncing: 'Syncing…', reconnecting: 'Reconnecting…', error: 'Error', idle: '' }[s.ble_state] || '';
  },

  _clearDeviceState() {
    this.info = { my_info: {}, metadata: {} };
    this.nodes = [];
    this.nodeSelf = {};
    this.nodeTotal = 0;
    this.nodeCount = 0;
    this.mqttProxy = false;
    this.mqttCfg = {};
    this.loraCfg = {};
    this.allSections = [];
    this.channels = [];
    this.ownerSchema = null;
    this.ownerData = {};
    this.fixedPosition = { lat: null, lon: null, alt: null, loaded: false, saved: false, error: '' };
  },

  async selectDevice(nodeId) {
    this.activeNodeId = nodeId;
    persistSet('activeNodeId', nodeId);
    this._clearDeviceState();
    this.reconnectWS();
    await this.bootstrapDevice();
    if (this.tab === 'radar') this.initRadar();
  },

  async bootstrapDevice() {
    // node_list arrives via WS on connect — no HTTP calls needed
  },

  async wipeNodeDb(nodeId) {
    if (!confirm(`Wipe node database on ${nodeId}?\n\nThis will send nodedb_reset to the radio. The radio will rebuild its node list from scratch.`)) return false;
    await fetchJSON(`/${nodeId}/admin`, 'POST', { message: { nodedb_reset: true }, want_response: false });
  },

  async loadAutoPurge(nodeId) {
    try {
      const r = await fetchJSON(`/auto-purge?device=${encodeURIComponent(nodeId)}`);
      this.autoPurge = { ...this.autoPurge, [nodeId]: r };
    } catch (_) {}
  },

  async saveAutoPurge(nodeId) {
    const s = this.autoPurge[nodeId];
    if (!s) return;
    try {
      await fetchJSON('/auto-purge', 'PUT', { device: nodeId, enabled: s.enabled, purge_time: s.purge_time });
    } catch (e) {
      this.showToast('Failed to save auto-purge settings', 'error');
    }
  },

  autoPurgeSetting(nodeId) {
    return this.autoPurge[nodeId] || { enabled: false, purge_time: '02:00', last_run_ts: null };
  },

  autoPurgeLastStr(nodeId) {
    const ts = this.autoPurge[nodeId]?.last_run_ts;
    if (!ts) return 'never';
    const diffSec = Math.floor(Date.now() / 1000) - ts;
    if (diffSec < 120) return 'just now';
    if (diffSec < 3600) return Math.round(diffSec / 60) + 'm ago';
    return Math.round(diffSec / 3600) + 'h ago';
  },

  async disconnectDevice(nodeId) {
    await fetchJSON('/devices/' + encodeURIComponent(nodeId), 'DELETE');
    if (this.activeNodeId === nodeId) this.activeNodeId = '';
    if (!this.activeNodeId && this.availableDevices.length > 0) {
      await this.selectDevice(this.availableDevices[0].node_id);
    }
  },

  async backupRadioConfig(nodeId) {
    const data = await fetchJSON(`/${nodeId}/radio_backup`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `meshtastic-${nodeId}-${new Date().toISOString().slice(0, 10)}.json`,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  async pushFixedPosition(nodeId) {
    const cfg = this.deviceConfigs[nodeId] || {};
    const lat = cfg.fixed_lat;
    const lon = cfg.fixed_lon;
    if (lat == null || lon == null) throw new Error('No fixed position configured — set it in Config → Radio → Device');
    const body = { latitude_i: Math.round(lat * 1e7), longitude_i: Math.round(lon * 1e7) };
    const res = await fetchJSON(`/${nodeId}/fixed_position`, 'PUT', body);
    if (res?.error) throw new Error(res.error?.message || 'Push failed');
    if (res?.detail) throw new Error(res.detail);
    if (!res?.verified) throw new Error('Position not verified by device');
  },

  async saveBleCfg(bleAddress, field, value) {
    const dev = this.availableDevices.find(d => d.ble_address === bleAddress);
    if (dev) dev[field] = value;
    try {
      await fetchJSON(`/ble_devices/${encodeURIComponent(bleAddress)}`, 'PATCH', { [field]: value });
    } catch (e) {
      console.warn('saveBleCfg failed', e);
      if (dev) dev[field] = !value;
    }
  },

  async saveDeviceCfg(nodeId, field, value) {
    const existing = this.deviceConfigs[nodeId] || {};
    const updated = { ...existing, [field]: value };
    this.deviceConfigs = { ...this.deviceConfigs, [nodeId]: updated };
    if (field === 'is_primary' && value) {
      const next = { ...this.deviceConfigs };
      for (const id of Object.keys(next)) {
        if (id !== nodeId) next[id] = { ...next[id], is_primary: false };
      }
      this.deviceConfigs = next;
      this.activeNodeId = nodeId;
      persistSet('activeNodeId', nodeId);
    }
    try {
      await fetchJSON(`/device-config/${encodeURIComponent(nodeId)}`, 'PUT', { [field]: value });
    } catch (e) {
      console.warn('saveDeviceCfg failed', e);
    }
  },

  async saveAntennaCfg() {
    this.antennaSaved = false;
    this.antennaError = '';
    const nodeId = this.cfgRadioId;
    if (!nodeId) return;
    const cfg = this.deviceConfigs[nodeId] || {};
    const body = {
      antenna_type:  cfg.antenna_type  ?? null,
      beam_deg:      Number(cfg.beam_deg)      || 360,
      gain_dbi:      Number(cfg.gain_dbi)      || 0,
      cable_loss_db: Number(cfg.cable_loss_db) || 0,
    };
    try {
      const updated = await fetchJSON(`/device-config/${encodeURIComponent(nodeId)}`, 'PUT', body);
      this.deviceConfigs = { ...this.deviceConfigs, [nodeId]: { ...cfg, ...updated } };
      this.antennaSaved = true;
      setTimeout(() => { this.antennaSaved = false; }, 2000);
      this.drawRadar();
    } catch (e) {
      this.antennaError = String(e);
    }
  },

  async saveHomePosCfg() {
    this.homePosSaved = false;
    this.homePosError = '';
    const nodeId = this.cfgRadioId;
    if (!nodeId) return;
    const cfg = this.deviceConfigs[nodeId] || {};
    try {
      const updated = await fetchJSON(`/device-config/${encodeURIComponent(nodeId)}`, 'PUT', {
        fixed_lat: cfg.fixed_lat ?? null,
        fixed_lon: cfg.fixed_lon ?? null,
      });
      this.deviceConfigs = { ...this.deviceConfigs, [nodeId]: { ...cfg, ...updated } };
      this.homePosSaved = true;
      setTimeout(() => { this.homePosSaved = false; }, 2000);
    } catch (e) {
      this.homePosError = String(e);
    }
  },

  togglePacketSource(nodeId, checked) {
    let sources = [...this.packetSources];
    if (checked && !sources.includes(nodeId)) sources.push(nodeId);
    else if (!checked) sources = sources.filter(id => id !== nodeId);
    if (sources.length === this.availableDevices.length) sources = [];
    this.packetSources = sources;
    fetchJSON('/config/packet_sources', 'PUT', { value: sources }).catch(() => {});
  },

  deviceLabel(nodeId) {
    if (!nodeId) return '';
    const d = this.availableDevices.find(d => d.node_id === nodeId);
    return d?.display_name || '';
  },

  rotatorDeviceId() {
    const entry = Object.entries(this.deviceConfigs).find(([, c]) => c?.is_rotator);
    return entry ? entry[0] : null;
  },

  async restartMqttProxy() {
    try {
      await fetchJSON('/mqtt_proxy/restart', 'POST', {});
    } catch (e) {
      console.error('Failed to restart MQTT proxy', e);
    }
  },

  async loadDeviceConfigs() {
    try {
      this.deviceConfigs = await fetchJSON('/device-config');
      const primaryEntry = Object.entries(this.deviceConfigs).find(([, c]) => c?.is_primary);
      if (primaryEntry) {
        const [primaryId] = primaryEntry;
        this.activeNodeId = primaryId;
        persistSet('activeNodeId', primaryId);
        if (!this.msgFrom) { this.msgFrom = primaryId; persistSet('msgFrom', primaryId); }
      }
    } catch (e) {
      console.warn('Failed to load device configs', e);
    }
  },

  _drainReadbackQueue(nodeId) {
    const queue = this._readbackQueues[nodeId];
    if (!queue || !queue.length) return;
    this._readbackQueues = { ...this._readbackQueues, [nodeId]: [] };
    for (const fn of queue) fn();
  },

  // -- BLE connect flow -------------------------------------------------------
  async bleScan() {
    this.bleScanning = true;
    this.bleError = '';
    try {
      const data = await fetchJSON('/ble/scan');
      this.bleDevices = data.devices || [];
      if (this.bleDevices.length === 0) this.bleError = 'No Meshtastic devices found.';
    } catch (e) {
      this.bleError = 'Scan failed: ' + (e.message || e);
    } finally {
      this.bleScanning = false;
    }
  },

  async bleRemove(address) {
    try {
      await fetchJSON(`/ble/known/${encodeURIComponent(address)}`, 'DELETE');
      const dev = this.bleDevices.find(d => d.address?.toUpperCase() === address.toUpperCase());
      if (dev) { dev.paired = false; dev.trusted = false; }
    } catch (e) {
      this.bleError = 'Remove failed: ' + (e.message || e);
    }
  },

  async bleConnect(address) {
    const addr = address || this.bleAddress;
    if (!addr) return;
    this.bleAddress = addr;
    this.bleConnecting = true;
    this.bleError = '';
    try {
      await fetchJSON('/devices', 'POST', { address: addr, pin: this.blePin || '' });
      const deadline = Date.now() + 60000;
      const bleKey = 'ble:' + addr.toUpperCase();
      const addrUpper = addr.toUpperCase();
      let connected = false;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
        const pending = this.deviceBleStates[bleKey];
        if (pending?.ble_state === 'error') {
          this.bleError = 'Connect failed: ' + (pending.ble_error || 'device disconnected');
          break;
        }
        const dev = this.availableDevices.find(d => d.ble_address?.toUpperCase() === addrUpper);
        if (dev) {
          const devState = this.deviceBleStates[dev.node_id];
          if (devState?.ble_state === 'error') {
            this.bleError = 'Connect failed: ' + (devState.ble_error || 'device disconnected');
            break;
          }
          if (devState?.ble_state === 'ready') {
            if (!this.activeNodeId) await this.selectDevice(dev.node_id);
            connected = true;
            break;
          }
        }
      }
      if (!connected && !this.bleError) {
        this.bleError = 'Connect timed out — check device and try again';
      }
    } catch (e) {
      this.bleError = 'Connect failed: ' + (e.message || e);
    } finally {
      this.bleConnecting = false;
    }
  },

  // -- OTA firmware management ------------------------------------------------

  async loadOtaFiles(nodeId) {
    this.otaFilesLoading = { ...this.otaFilesLoading, [nodeId]: true };
    try {
      const d = await fetchJSON(`/ota/firmware?node_id=${encodeURIComponent(nodeId)}`);
      this.otaFiles = { ...this.otaFiles, [nodeId]: d };
      if (!this.otaSelectedFile[nodeId] && d.files?.length) {
        this.otaSelectedFile = { ...this.otaSelectedFile, [nodeId]: d.files[0].name };
      }
    } catch (e) {
      this.otaFiles = { ...this.otaFiles, [nodeId]: { files: [], error: e.message } };
    } finally {
      this.otaFilesLoading = { ...this.otaFilesLoading, [nodeId]: false };
    }
  },

  async loadOtaReleases() {
    this.otaReleasesLoading = true;
    this.otaReleasesError = '';
    try {
      const d = await fetchJSON('/ota/releases');
      this.otaReleases = d.releases || [];
      if (!this.otaSelectedRelease && this.otaReleases.length) {
        this.otaSelectedRelease = this.otaReleases[0].tag;
      }
    } catch (e) {
      this.otaReleasesError = e.message || 'Failed to fetch releases';
    } finally {
      this.otaReleasesLoading = false;
    }
  },

  otaAssetsForDevice(nodeId) {
    const hwRaw = (this.otaFiles[nodeId]?.hw_model || this.nodeById(nodeId)?.user?.hw_model || '').toUpperCase();
    if (!hwRaw || !this.otaSelectedRelease) return [];
    const rel = (this.otaReleases || []).find(r => r.tag === this.otaSelectedRelease);
    if (!rel) return [];

    // Map hw_model → Meshtastic release platform bundle name.
    // Releases use SoC-family bundles, not per-device files.
    const NRF52 = new Set(['RAK4631','NRF52840','NRF52_DK','TECHO','TECHO_V0','TECHO_V1','TECHO_V2','PPR1']);
    const ESP32S3 = ['HELTEC_V3','HELTEC_W36','HELTEC_HT62','HELTEC_MESH_NODE_T114','SEEED_XIAO_S3','TBEAM_S3_CORE','NANO_G2_ULTRA','TRACKER_T1000_E','T_WATCH_S3'];
    const ESP32C3 = ['SEEED_XIAO_C3','TLORA_T3S3_V1'];
    const ESP32C6 = ['T_ECHO_V3','STATION_G2'];
    const RP2040 = ['RP2040_LORA'];

    let platform = 'esp32';
    if (NRF52.has(hwRaw)) platform = 'nrf52840';
    else if (ESP32S3.some(m => hwRaw.includes(m))) platform = 'esp32s3';
    else if (ESP32C3.some(m => hwRaw.includes(m))) platform = 'esp32c3';
    else if (ESP32C6.some(m => hwRaw.includes(m))) platform = 'esp32c6';
    else if (RP2040.some(m => hwRaw.includes(m))) platform = 'rp2040';

    return rel.assets.filter(a =>
      a.name.startsWith('firmware-') &&
      a.name.toLowerCase().includes(platform)
    );
  },

  async downloadOtaAsset(nodeId, url, filename) {
    this.otaDownloadState = { ...this.otaDownloadState, [nodeId]: { state: 'downloading', pct: 0 } };
    try {
      await fetchJSON('/ota/firmware/download', 'POST', { node_id: nodeId, url, filename });
    } catch (e) {
      this.otaDownloadState = { ...this.otaDownloadState, [nodeId]: { state: 'error', pct: 0, error: e.message } };
    }
  },

  async flashOta(nodeId, bleAddr, filename) {
    if (!filename) return;
    this.deviceOtaState = { ...this.deviceOtaState, [nodeId]: { state: 'flashing', pct: 0 } };
    try {
      const d = await fetchJSON('/ota', 'POST', { node_id: nodeId, ble_addr: bleAddr, firmware: filename });
      if (!d.started) this.deviceOtaState = { ...this.deviceOtaState, [nodeId]: { state: 'error', pct: 0 } };
    } catch (e) {
      this.deviceOtaState = { ...this.deviceOtaState, [nodeId]: { state: 'error', pct: 0 } };
    }
  },
};
