// WebSocket connection and event dispatch mixin.
import { b64ToUtf8, summarizeEvent, FEED_FILTER_OPTIONS } from './app-helpers.js';
import { persistSet, persistGet } from './app-persist.js';
import { FF } from './feature-flags.js';
import { handleConfigOp } from './op-client.js';
window.feedFilterOptions = FEED_FILTER_OPTIONS;

// Cap per-node history arrays so a long-lived tab doesn't leak: live tilt
// updates append forever, and tilt/env history replays re-accumulate on every
// WS reconnect. Charts only ever show a recent window.
const MAX_HISTORY_ROWS = 2000;

export const wsMixin = {
  connectWS() {
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/events');
    this._ws = ws;
    ws.onopen = () => {
      const wasDisconnected = !this.wsConnected;
      this.wsConnected = true;
      if (wasDisconnected) this.bootstrapDevice();
      // A deep-linked /node/!hexid may have requested before the socket was
      // open, and a reconnect must re-sync the focused node.
      if (this.tab === 'node' && this.nodeStatusNum) this.requestNodeStatus();
    };
    ws.onclose = () => {
      this.wsConnected = false;
      if (ws === this._ws) setTimeout(() => this.connectWS(), 3000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (msg) => {
      try { this.handleEvent(JSON.parse(msg.data)); } catch (_) {}
    };
  },

  // Client→server WS send. All page data travels over /events —
  // BROWSER_CONTRACT §Transport makes GET form-only.
  wsSend(payload) {
    if (!this._ws || this._ws.readyState !== 1) return false;
    this._ws.send(JSON.stringify(payload));
    return true;
  },

  // Client→server WS RPC: geocode lookup (GET is form-submission-only).
  wsGeocode(num) {
    if (!num || !this._ws || this._ws.readyState !== 1) return Promise.resolve(null);
    this._geocodePending = this._geocodePending || {};
    return new Promise((resolve) => {
      this._geocodePending[num] = resolve;
      this._ws.send(JSON.stringify({ type: 'geocode', num }));
      setTimeout(() => {
        if (this._geocodePending[num]) { this._geocodePending[num] = null; delete this._geocodePending[num]; resolve(null); }
      }, 30000);
    });
  },

  reconnectWS() {
    if (this._ws) { this._ws.onclose = null; this._ws.close(); this._ws = null; }
    this.wsConnected = false;
    this.connectWS();
  },

  handleEvent(ev) {
    if (ev.type === 'config_op')           { handleConfigOp(ev); return; }
    if (ev.type === 'bridge_connected')    { this.bridgeConnected = true;  return; }
    if (ev.type === 'bridge_disconnected') { this.bridgeConnected = false; return; }
    if (ev.type === 'pac_host_status')     {
      this.pacHostStatus = ev;
      // Default to the first known commandable unit so the Control page has
      // something to show the moment units become known — never overrides an
      // actual (even auto) choice already made, only fires while still null.
      if (this.controlTarget == null) {
        const first = this.controlDevices()[0];
        if (first) this.controlTarget = first.num;
      }
      return;
    }
    if (ev.type === 'pac_host_queues')     { this.pacHostQueues = ev.queues || {}; return; }
    if (ev.type === 'pac_host_align')      {
      this.alignModel = ev.model;
      // Adopt the session's own target once it has one (mirrors the archived
      // app-align.js's adoptModel — "Adopt target from it"). Same never-override
      // guard as controlTarget above: only fires while still null.
      if (this.alignTarget == null && ev.model?.target != null) this.alignTarget = ev.model.target;
      if (typeof ev.model?.replyWindowSec === 'number') this.alignReplyWinInput = ev.model.replyWindowSec;
      return;
    }

    if (ev.type === 'settings') {
      // Page state arrives over WS only (settings-via-ws) — replayed on
      // connect and re-broadcast after every config write, so filter/radar
      // changes are live in every tab. Replaces the deleted loadConfig GET.
      const cfg = ev.config || {};
      this.nodeFilters = {
        maxHops:   cfg['node_filters.max_hops']   ?? 99,
        maxAge:    cfg['node_filters.max_age']    ?? 0,
        namedOnly: cfg['node_filters.named_only'] ?? false,
        hasPos:    cfg['node_filters.has_pos']    ?? false,
        hideMqtt:  cfg['node_filters.hide_mqtt']  ?? false,
        hasSignal: cfg['node_filters.has_signal'] ?? false,
        hasTelem:  cfg['node_filters.has_telem']  ?? false,
        msgOnly:   cfg['node_filters.msg_only']   ?? false,
        nodeRoles: cfg['node_filters.roles']      ?? [],
      };
      this.nodeSource     = cfg['node_filters.node_source'] ?? 'both';
      this.radarRange     = String(cfg['radar.max_range_km'] ?? 50);
      this.radarLogScale  = cfg['radar.log_scale']  ?? false;
      this.radarCrosshair = cfg['radar.crosshair']  ?? true;
      this.packetSources  = cfg['packet_sources']   ?? [];
      if (cfg['perf.failure_epoch'] != null) this.perfFailureEpoch = cfg['perf.failure_epoch'];
      if (cfg['range_test.duration']) this.rangeDuration = cfg['range_test.duration'];
      if (this.tab === 'radar' && this.homePos) this.refreshRadar();
      return;
    }


    // Node focus page. The reply carries display-ready sections; the hint
    // carries only a num, so we re-request rather than trust a pushed value.
    if (ev.type === 'node_status')        { this.applyNodeStatus(ev); return; }
    if (ev.type === 'node_status_update') { this.onNodeStatusUpdate(ev.num); return; }
    if (ev.type === 'node_status_age')    { this.applyNodeStatusAge(ev); return; }

    if (ev.type === 'geocode_result') {
      const pending = this._geocodePending?.[ev.num];
      if (pending) { pending(ev.address ?? null); delete this._geocodePending[ev.num]; }
      return;
    }

    if (ev.type === 'tilt_cal') {
      this.tiltZero       = ev.zero        ?? null;
      this.tiltNorthAngle = ev.north_angle ?? null;
      this._tiltRecomputePeak();
      return;
    }

    if (ev.type === 'rotator') {
      this._onRotatorEvent(ev.data || {}); return;
    }

    if (ev.type === 'device_list') {
      const devices = ev.devices || [];
      this.availableDevices = devices;
      // Purge settings ride the device_list (settings-via-ws)
      for (const dev of devices) {
        if (dev.auto_purge && dev.node_id) {
          this.autoPurge = { ...this.autoPurge, [dev.node_id]: dev.auto_purge };
        }
      }
      // Device settings + radio lora config arrive ON the device_list (C2:
      // page data is WS-only) — no GET /device-config, no /config/lora.
      const byMac = {};
      for (const dev of devices) {
        if (dev.addr && dev.cfg) byMac[dev.addr.toUpperCase()] = dev.cfg;
      }
      if (Object.keys(byMac).length) this._deviceConfigsByMac = byMac;
      this._rebuildDeviceConfigs?.();
      // One-time shim: a legacy persisted !hex selection converts to the
      // MAC key once the device list can map it (C3a).
      if (!persistGet('activeDevice', '')) {
        const legacy = persistGet('activeNodeId', '');
        const mapped = legacy && devices.find(d => d.node_id === legacy)?.addr;
        if (mapped) persistSet('activeDevice', mapped);
      }
      // Seed primary as active only when the user has no saved choice —
      // an explicit Set Active always wins (moved from loadDeviceConfigs).
      if (!this.activeDevice && !persistGet('activeDevice', '')) {
        const primary = devices.find(d => d.cfg?.is_primary && d.addr);
        if (primary) {
          this.activeDevice = primary.addr;
          if (!this.msgFrom) this.msgFrom = primary.node_id;
        }
      }
      // Theory constants for the perf page's selected radio
      const perfSel = devices.find(d => d.addr === this.perfDev());
      if (perfSel?.lora) this.loraCfg = perfSel.lora;
      const existing = {};
      for (const dev of devices) {
        const key = dev.node_id ?? dev.addr;
        if (!key) continue;
        const cur = this.deviceBleStates[key];
        // Gateway device_list is authoritative — always take ble_state and identity fields from it
        existing[key] = cur ? { ...cur, ...dev } : { ...dev };
      }
      this.deviceBleStates = { ...this.deviceBleStates, ...existing };

      // NEED_PAIR overlay — driven from device_list (always reflects current state).
      // device_state replay on page load can be stale; device_list is authoritative.
      const needPairDev = devices.find(d => d.ble_state === 'need_pair' && d.has_pin === false);
      if (needPairDev && !this.needPairBusy) {
        if (this.needPairAddr !== needPairDev.addr) {
          this.needPairAddr  = needPairDev.addr;
          this.needPairError = '';
          this.needPairPin   = this.deviceConfigs[needPairDev.node_id]?.ble_pin || '';
        }
      } else if (!needPairDev && this.needPairAddr) {
        const prevDev = devices.find(d => d.addr === this.needPairAddr);
        const s = prevDev?.ble_state;
        if (s === 'discovering' || s === 'syncing' || s === 'ready') {
          // Pairing succeeded — dismiss even while busy. Nothing else clears
          // needPairBusy on success (only wrong-PIN/OFFLINE do), so gating
          // this on !needPairBusy left the modal up forever (pair-modal-dismiss).
          this.showToast('Device paired successfully', 'success');
          this.needPairAddr = null;
          this.needPairBusy = false;
          this.needPairPin  = '';
        } else if (!this.needPairBusy) {
          // Device vanished while the modal was idle — dismiss without toast.
          this.needPairAddr = null;
        }
      }

      // Active-device adoption (see docs/modules/app-ws.md):
      // the persisted preference is written ONLY by explicit user actions.
      // Re-adopt it when its device reappears; outage fallback is display-only.
      // Keyed by MAC (C3a) — a device keeps its selection across firmware
      // resets that change its node_id.
      if (devices.length > 0) {
        const preferred = persistGet('activeDevice', '');
        if (preferred && devices.find(d => d.addr === preferred)) {
          if (this.activeDevice !== preferred) this.activeDevice = preferred;
        } else if (!this.activeDevice || !devices.find(d => d.addr === this.activeDevice)) {
          this.activeDevice = devices[0].addr;
        }
      }
      {
        const preferredFrom = persistGet('msgFrom', '');
        if (preferredFrom && devices.find(d => d.node_id === preferredFrom)) {
          if (this.msgFrom !== preferredFrom) this.msgFrom = preferredFrom;
        } else if (!this.msgFrom || !devices.find(d => d.node_id === this.msgFrom)) {
          this.msgFrom = this.activeNodeId;
        }
      }
      // Perf page cold-load: perfDev() resolves once the device list exists —
      // re-slice the WS-replayed history and fetch theory constants.
      if (this.tab === 'perf' && !this.perfHistory.length && devices.length) {
        this.perfHistory = this.perfHistorySlice();
        this.adoptPerfLoraCfg();
      }
      if (!this.cfgRadioId || !devices.find(d => d.node_id === this.cfgRadioId)) {
        this.cfgRadioId = this.activeNodeId;
      }
      return;
    }

    // NEED_PAIR — BLE device requires a PIN to complete pairing.
    // device_state events flow directly from node-dash WS relay.
    // NEED_PAIR wrong-PIN feedback — device_list handles show/dismiss;
    // device_state handles the wrong-PIN case when we actively submitted.
    if (ev.type === 'device_state' && ev.addr && this.needPairAddr === ev.addr) {
      if (ev.state === 'NEED_PAIR' && this.needPairBusy) {
        this.needPairError = 'Incorrect PIN — check the device display and try again';
        this.needPairBusy  = false;
      } else if (ev.state === 'OFFLINE' && this.needPairBusy) {
        this.needPairError = 'Pairing failed — wrong PIN?';
        this.needPairBusy  = false;
      }
    }

    // OTA flash — WS drives the ops key for the duration of the flash.
    // ws-relay.js translates device_state OTA_* → ota_start/progress/complete/error with ev.node_id.
    if (ev.type === 'ota_start' && (ev.node_id || ev.device)) {
      this.asyncOpStart('otaFlash_' + (ev.node_id || ev.device));
      return;
    }
    if (ev.type === 'ota_progress' && (ev.node_id || ev.device)) {
      this.asyncOpProgress('otaFlash_' + (ev.node_id || ev.device), ev.data?.pct ?? 0);
      const newDeadline = ev.data?.deadline ?? null;
      if (newDeadline !== this.otaNvsDeadline) {
        this.otaNvsDeadline = newDeadline;
        if (this._nvsCountdownTimer) { clearInterval(this._nvsCountdownTimer); this._nvsCountdownTimer = null; }
        if (newDeadline) {
          this.otaNvsCountdownSecs = Math.max(0, Math.round((newDeadline - Date.now()) / 1000));
          this._nvsCountdownTimer = setInterval(() => {
            this.otaNvsCountdownSecs = Math.max(0, Math.round((this.otaNvsDeadline - Date.now()) / 1000));
            if (this.otaNvsCountdownSecs <= 0) { clearInterval(this._nvsCountdownTimer); this._nvsCountdownTimer = null; }
          }, 1000);
        } else {
          this.otaNvsCountdownSecs = null;
        }
      }
      // Show prominent toast for status events requiring user action (once per status change)
      const st = ev.data?.status;
      if (st && st !== this._lastOtaStatus) {
        this._lastOtaStatus = st;
        if (st === 'nvs_erase_required' || st === 'nvs_erase_waiting') {
          const msg = ev.data?.message || 'Hold BOOT and press RESET on the device';
          this.showToast(msg, 'warning', 0);  // 0 = persistent until dismissed
        } else if (st === 'nvs_erasing') {
          this.showToast('NVS erasing — do not power off', 'info', 5000);
        } else if (st === 'nvs_erased') {
          this.showToast('NVS cleared — reconnecting…', 'success', 4000);
        }
      }
      return;
    }
    if (ev.type === 'ota_complete' && (ev.node_id || ev.device)) {
      if (this._nvsCountdownTimer) { clearInterval(this._nvsCountdownTimer); this._nvsCountdownTimer = null; }
      this.otaNvsDeadline = null; this.otaNvsCountdownSecs = null;
      this.asyncOpEnd('otaFlash_' + (ev.node_id || ev.device), true);
      return;
    }
    if (ev.type === 'ota_error' && (ev.node_id || ev.device)) {
      if (this._nvsCountdownTimer) { clearInterval(this._nvsCountdownTimer); this._nvsCountdownTimer = null; }
      this.otaNvsDeadline = null; this.otaNvsCountdownSecs = null;
      this.asyncOpEnd('otaFlash_' + (ev.node_id || ev.device), false, ev.data?.error || 'OTA failed');
      return;
    }

    // OTA download — WS drives the ops key; HTTP trigger just starts the task
    if (ev.type === 'ota_download_start' && (ev.node_id || ev.device)) {
      this.asyncOpStart('otaDownload_' + (ev.node_id || ev.device));
      return;
    }
    if (ev.type === 'ota_download_progress' && (ev.node_id || ev.device)) {
      this.asyncOpProgress('otaDownload_' + (ev.node_id || ev.device), ev.data?.pct ?? 0);
      return;
    }
    if (ev.type === 'ota_download_complete' && (ev.node_id || ev.device)) {
      const _ota_dev = ev.node_id || ev.device;
      this.asyncOpEnd('otaDownload_' + _ota_dev, true);
      this.loadOtaFiles(_ota_dev).then(() => {
        const fname = ev.filename || ev.extracted;
        if (fname && !this.otaSelectedFile[_ota_dev])
          this.otaSelectedFile = { ...this.otaSelectedFile, [_ota_dev]: fname };
      });
      return;
    }
    if (ev.type === 'ota_download_error' && (ev.node_id || ev.device)) {
      this.asyncOpEnd('otaDownload_' + (ev.node_id || ev.device), false, ev.data?.error || 'Download failed');
      return;
    }

    if (ev.type === 'text_message') return; // handled via TEXT_MESSAGE_APP packet path

    if (ev.type === 'tilt_update' && ev.from_num != null) {
      const idx = this.nodes.findIndex(n => n.num === ev.from_num);
      if (idx >= 0) this.nodes[idx] = { ...this.nodes[idx], tilt: ev.data };
      if (this.nodeSelf?.num === ev.from_num) {
        this.nodeSelf = { ...this.nodeSelf, tilt: ev.data };
        if (ev.data?.pitch != null && (ev.addr || ev.device) === this.activeNodeId) {
          const entry = { ts: Math.floor(Date.now() / 1000), pitch: ev.data.pitch, roll: ev.data.roll };
          this.tiltHistory = [...this.tiltHistory, entry].slice(-MAX_HISTORY_ROWS);
          const z = this.tiltApplyZero(entry.pitch, entry.roll);
          const t = Math.sqrt(z.pitch ** 2 + z.roll ** 2);
          if (t > this.tiltPeak) this.tiltPeak = t;
        }
      }
      return;
    }

    if (ev.type === 'telemetry_update' && ev.from_num != null) {
      const nid = '!' + (ev.from_num >>> 0).toString(16).padStart(8, '0');
      const existing = this.deviceNodes[nid] ?? {};
      const updated = { ...existing, [ev.variant]: ev.data };
      this.deviceNodes = { ...this.deviceNodes, [nid]: updated };
      if (this.nodeSelf?.num === ev.from_num) {
        this.nodeSelf = { ...this.nodeSelf, [ev.variant]: ev.data };
      }
      if (ev.variant === 'environment_metrics') {
        const em = ev.data;
        const hist = this.envHistory[nid] ?? [];
        if (em.temperature != null || em.relative_humidity != null) {
          const last = hist[hist.length - 1];
          const nowTs = Math.floor(Date.now() / 1000);
          if (!last || nowTs - last.ts > 30) {
            this.envHistory = { ...this.envHistory, [nid]: [...hist, {
              ts:                  nowTs,
              temperature:         em.temperature         ?? null,
              relative_humidity:   em.relative_humidity   ?? null,
              barometric_pressure: em.barometric_pressure ?? null,
            }]};
          }
        }
      }
      return;
    }

    if (ev.type === 'node_list') {
      // Server-computed nav entries — the browser never scans for favourites.
      this.favourites = ev.favourites ?? [];
      // Default the align target to the first favourite, same never-override
      // guard as controlTarget/alignTarget-from-model above — only fires
      // while nothing (neither a user pick nor a running session) has set it.
      if (this.alignTarget == null && this.favourites.length) this.alignTarget = this.favourites[0].num;
      this.nodes = ev.nodes ?? [];
      this.nodeCount = this.nodes.length;
      this.nodeTotal = ev.total ?? this.nodes.length;
      this.homePos = ev.homePos ?? null;
      if (ev.device_nodes?.length) {
        const upd = { ...this.deviceNodes };
        for (const n of ev.device_nodes) {
          upd['!' + n.num.toString(16).padStart(8, '0')] = n;
        }
        this.deviceNodes = upd;
      }
      const myNum = this.deviceBleStates[this.activeNodeId]?.my_node_num;
      if (myNum) {
        const found = this.nodes.find(n => n.num === myNum)
          ?? Object.values(this.deviceNodes).find(n => n.num === myNum);
        if (found) {
          this.nodeSelf = {
            ...found,
            tilt:                found.tilt                ?? this.nodeSelf?.tilt,
            environment_metrics: found.environment_metrics ?? this.nodeSelf?.environment_metrics,
          };
        } else if (this.nodeSelf?.num !== myNum) {
          // Self node can be excluded by node filters — keep num seeded so
          // tilt_update/telemetry_update from_num matching still works.
          this.nodeSelf = { ...this.nodeSelf, num: myNum };
        }
      }
      this.sortNodes(this.nodeSort.key, true);
      if (this.tab === 'radar') {
        if (this.homePos) this.refreshRadar();
        else this.drawRadar();
      }
      return;
    }

    if (ev.type === 'known_nodes') {
      this._knownNodes = ev.nodes ?? [];
      return;
    }

    if (ev.type === 'message_history') {
      this._applyMessageRows(ev.messages || []);
      return;
    }

    if (ev.type === 'tilt_history') {
      // Store all-node tilt rows; expose only the active node's slice
      this._tiltHistoryAll = this._tiltHistoryAll || {};
      for (const r of (ev.rows || [])) {
        if (!r.node_id) continue;
        if (!this._tiltHistoryAll[r.node_id]) this._tiltHistoryAll[r.node_id] = [];
        this._tiltHistoryAll[r.node_id].push(r);
      }
      for (const k in this._tiltHistoryAll) {
        const a = this._tiltHistoryAll[k];
        if (a.length > MAX_HISTORY_ROWS) this._tiltHistoryAll[k] = a.slice(-MAX_HISTORY_ROWS);
      }
      if (this.activeNodeId) {
        this.tiltHistory = this._tiltHistoryAll[this.activeNodeId] ?? [];
        this._tiltRecomputePeak?.();
      }
      return;
    }

    if (ev.type === 'env_history') {
      const updated = { ...this.envHistory };
      for (const r of (ev.rows || [])) {
        const nid = '!' + (r.num >>> 0).toString(16).padStart(8, '0');
        if (!updated[nid]) updated[nid] = [];
        updated[nid].push(r);
      }
      for (const k in updated) {
        if (updated[k].length > MAX_HISTORY_ROWS) updated[k] = updated[k].slice(-MAX_HISTORY_ROWS);
      }
      this.envHistory = updated;
      // Seed nodeSelf.environment_metrics from most recent own-device row if not yet set
      if (this.activeNodeId && !this.nodeSelf?.environment_metrics) {
        const rows = updated[this.activeNodeId];
        if (rows?.length) {
          const latest = rows[rows.length - 1];
          this.nodeSelf = { ...this.nodeSelf, environment_metrics: {
            temperature:         latest.temperature         ?? null,
            relative_humidity:   latest.relative_humidity   ?? null,
            barometric_pressure: latest.barometric_pressure ?? null,
          }};
        }
      }
      return;
    }

    if (ev.type === 'range_test_log') {
      this._rangeStats = null; this._rangeChartCache = null;
      this.rangeLog = (ev.log || []).map(r => ({ ...r, _uid: 'db_' + (r.id ?? (this._rangeUid++)) }));
      return;
    }

    if (ev.type === 'range_test_timer') {
      this.rangeTimer = ev;
      this._startRangeCountdown?.();
      return;
    }

    if (ev.type === 'traceroute_history') {
      // Sole transport for perf-page history (C1: page data is WS-only).
      // All-device rows are stored; the page shows the perfDev() slice —
      // presentation scoping, same pattern as tilt/env history.
      this._trHistAll = ev.rows || [];
      if (ev.failure_epoch != null) this.perfFailureEpoch = ev.failure_epoch;
      this.perfHistory = this.perfHistorySlice();
      return;
    }

    if (ev.type === 'traceroute_failed' && ev.row) {
      this._trHistAll = [ev.row, ...(this._trHistAll || [])].slice(0, 500);
      if (ev.row.tx_device === this.perfDev()) {
        this.perfHistory = [ev.row, ...(this.perfHistory || [])].slice(0, 200);
      }
      return;
    }

    if (ev.type === 'signal_update') {
      const d = ev.data;
      if (d?.signal_num != null) {
        this.yagiSignal = { num: d.signal_num, rssi: d.rssi ?? null, snr: d.snr ?? null, ts: d.ts ?? Date.now() };
        this._sigTick = 0;
        this._pingSignal();
        if (this.tab === 'radar') this.refreshRadar();
      }
      return;
    }

    // ── [V1] LEGACY — remove when SSOT_TRACEROUTE verified ─────────────────────
    // Raw packet patch: updates last_traceroute directly from the WS packet feed.
    // In V2 this is replaced by the route_discovered handler below (fired by traceroute.js).
    if (!FF.SSOT_TRACEROUTE) {
      if (ev.type === 'packet') {
        const pkt = ev.data?.packet;
        if (pkt?.decoded?.portnum === 'TRACEROUTE_APP' && pkt?.decoded?.route_discovery) {
          const rd = pkt.decoded.route_discovery;
          this.traceroutePending = false;
          this.tracerouteResult = {
            num:         pkt.from,
            route:       rd.route       ?? [],
            route_back:  rd.route_back  ?? [],
            snr_towards: rd.snr_towards ?? [],
            snr_back:    rd.snr_back    ?? [],
            ts: Date.now(),
          };
          const ni = this.nodes.findIndex(n => n.num === pkt.from);
          if (ni >= 0) {
            this.nodes[ni] = { ...this.nodes[ni], last_traceroute: this.tracerouteResult };
            if (this.tab === 'radar') this.refreshRadar();
          }
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────────

    const time = new Date().toLocaleTimeString();
    const summary = summarizeEvent(ev);
    const portnum = ev.type === 'packet' ? (ev.data?.packet?.decoded?.portnum || null) : null;
    this.events.unshift({ type: ev.type, portnum, time, summary, device: ev.addr || ev.device || null });
    if (this.events.length > 80) this.events.pop();

    if (ev.type === 'scan_start') {
      this.scanMode      = true;
      this.scanProgress  = ev.data.az ?? 0;
      this.scanCurrentAz = ev.data.dwell_az ?? null;
      if (!ev.data.resumed) { this.scanData = {}; this.nodes = []; }
      else { this.scanData = ev.data.contacts ?? {}; }
      if (this.tab === 'radar') this.drawRadar();
      return;
    }
    if (ev.type === 'scan_progress') {
      this.scanProgress  = ev.data.az;
      this.scanCurrentAz = ev.data.dwell_az ?? null;
      this.rotatorStatus = { ...this.rotatorStatus, target: ev.data.az };
      if (this.tab === 'radar') this.drawRadar();
      return;
    }
    if (ev.type === 'scan_contact') {
      const d = ev.data;
      const existing = this.scanData[d.az];
      if (!existing || d.snr > (existing.snr ?? -Infinity)) {
        this.scanData[d.az] = { from: d.from, snr: d.snr, rssi: d.rssi, ts: d.ts };
      }
      return;
    }
    if (ev.type === 'scan_end') {
      this.scanMode      = false;
      this.scanProgress  = null;
      this.scanCurrentAz = null;
      if (this.tab === 'radar') this.drawRadar();
      return;
    }
    if (ev.type === 'passive_trace_start') {
      this.passiveTraceNum = ev.from;
      if (this._passiveTraceTimer) clearTimeout(this._passiveTraceTimer);
      if (this.tab === 'radar') this.refreshRadar();
      return;
    }
    if (ev.type === 'route_discovered') {
      const ni = this.nodes.findIndex(n => n.num === ev.from);
      if (ni >= 0) {
        this.nodes[ni] = { ...this.nodes[ni], last_traceroute: {
          route:           ev.route           ?? [],
          route_back:      ev.route_back      ?? [],
          snr_towards:     ev.snr_towards     ?? [],
          snr_back:        ev.snr_back        ?? [],
          relay_positions: ev.relay_positions ?? {},
          ts:              ev.ts              ?? Date.now(),
        }};
      }
      // Prepend to perfHistory so the perf tab stays live without polling —
      // only when the result belongs to the page's selected device (scope
      // match on the subscribed device, not business filtering).
      if (ev.from != null && ev.tx_device) {
        const entry = {
          id: ev.id ?? null,
          from_num: ev.from, to_num: ev.to ?? null,
          route: ev.route ?? [], route_back: ev.route_back ?? [],
          snr_towards: ev.snr_towards ?? [], snr_back: ev.snr_back ?? [],
          relay_positions: ev.relay_positions ?? {},
          ts: ev.ts != null && ev.ts > 1e12 ? Math.floor(ev.ts / 1000) : (ev.ts ?? Math.floor(Date.now() / 1000)),
          rx_device: ev.rx_device ?? null,
          tx_device: ev.tx_device, rotator_az: ev.rotator_az ?? null,
          status: 'ok',
        };
        this._trHistAll = [entry, ...(this._trHistAll || [])].slice(0, 500);
        if (ev.tx_device === this.perfDev()) {
          this.perfHistory = [entry, ...(this.perfHistory || [])].slice(0, 200);
        }
      }
      this.passiveTraceNum = ev.from;
      if (this._passiveTraceTimer) clearTimeout(this._passiveTraceTimer);
      this._passiveTraceTimer = setTimeout(() => {
        this.passiveTraceNum = null;
        if (this.tab === 'radar') this.refreshRadar();
      }, 30000);
      if (this.tab === 'radar') this.refreshRadar();
      return;
    }

    // ── [V2] SSOT_ROUTE_RENDER — backend owns radar display state ────────────
    if (FF.SSOT_ROUTE_RENDER && ev.type === 'radar_context') {
      this.radarCtx = ev;
      if (this.tab === 'radar') this.refreshRadar();
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (ev.type === 'packet') {
      const pkt = ev.data?.packet;
      const portnum = pkt?.decoded?.portnum;
      if (portnum === 'TEXT_MESSAGE_APP' && pkt?.decoded?.payload) {
        // The browser NO LONGER builds messages. The feed is written solely by
        // the server's message_history broadcast (MESSAGE_PIPELINE_REWRITE_SPEC),
        // which already threads, dedupes across radios and orders the list.
        // This branch now only drives incidental UI: the unread badge and sound.
        //
        // No try/catch swallow here — a failure must surface, not vanish.
        const fromNum = pkt.from ?? 0;
        const injectedUser = pkt.decoded.user;
        const fromNode = !injectedUser ? this.nodes.find(n => n.num === fromNum) : null;
        const fromName = ev.from_name || injectedUser?.short_name || fromNode?.display_name || fromNode?.user?.short_name || null;
        const longName = injectedUser?.long_name || fromNode?.user?.long_name || null;
        if (fromName || longName) {
          this.msgNodeCache[fromNum] = { num: fromNum, display_name: fromName, user: { short_name: fromName, long_name: longName } };
        }
        if (this.tab !== 'messages') { this.unreadMessages++; this.playMsgSound(); }
      }
      if (pkt?.from != null) {
        this.lastHeardNum = pkt.from;
        if (this.tab === 'radar') this.drawRadar();
      }
      if (this.tab === 'nodes' && portnum === 'TELEMETRY_APP') this.sortNodes(this.nodeSort.key, true);
    }

    if (ev.type === 'message_status' && ev.packet_id != null) {
      const m = this.messages.find(m => m.pktId === ev.packet_id);
      if (m) {
        m.ackStatus = ev.status;
        if (ev.from_num) m.ackFrom = ev.from_num;
        if (ev.error_name && ev.error_name !== 'NONE') m.ackError = ev.error_name;
      }
    }

    if (ev.type === 'range_test_entry' && ev.data) {
      this._rangeStats = null; this._rangeChartCache = null;
      const entry = {
        ...ev.data,
        rx_device: ev.addr || ev.device || null,
        from_name: ev.from_name ?? null,
        rx_name:   ev.rx_name  ?? null,
        _uid: 'live_' + (this._rangeUid++),
      };
      this.rangeLog = [entry, ...this.rangeLog].slice(0, 500);
      this._rangeTick++;
    }
    if (ev.type === 'auto_purge_complete') {
      const _ap_dev = ev.addr || ev.device;
      if (_ap_dev && this.autoPurge[_ap_dev]) this.autoPurge[_ap_dev].last_run_ts = ev.ts;
      this.nodes = [];
      this.showToast(`Auto-purge complete on ${_ap_dev}`, 'success');
    }
    if (ev.type === 'auto_purge_error') {
      this.showToast(`Auto-purge failed on ${ev.addr || ev.device}: ${ev.error}`, 'error');
    }
    if (ev.type === 'mqtt_node' && ev.data && !this.scanMode) {
      const upd = ev.data;
      const idx = this.nodes.findIndex(n => n.num === upd.num);
      if (idx >= 0) {
        this.nodes[idx] = { ...this.nodes[idx], ...upd };
        if (this.tab === 'radar' && this.homePos && upd.position?.latitude_i) this.refreshRadar();
      }
    }
  },

};
