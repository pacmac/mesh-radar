// WebSocket connection and event dispatch mixin.
import { b64ToUtf8, summarizeEvent, FEED_FILTER_OPTIONS } from './app-helpers.js';
import { persistSet, persistGet } from './app-persist.js';
import { FF } from './feature-flags.js';
import { handleConfigOp } from './op-client.js';
window.feedFilterOptions = FEED_FILTER_OPTIONS;

export const wsMixin = {
  connectWS() {
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/events');
    this._ws = ws;
    ws.onopen = () => {
      const wasDisconnected = !this.wsConnected;
      this.wsConnected = true;
      if (wasDisconnected) this.bootstrapDevice();
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

  reconnectWS() {
    if (this._ws) { this._ws.onclose = null; this._ws.close(); this._ws = null; }
    this.wsConnected = false;
    this.connectWS();
  },

  handleEvent(ev) {
    if (ev.type === 'config_op')           { handleConfigOp(ev); return; }
    if (ev.type === 'bridge_connected')    { this.bridgeConnected = true;  return; }
    if (ev.type === 'bridge_disconnected') { this.bridgeConnected = false; return; }

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
      const knownIds = new Set(this.availableDevices.map(d => d.node_id));
      for (const dev of devices) {
        if (!knownIds.has(dev.node_id)) this.loadAutoPurge(dev.node_id);
      }
      this.availableDevices = devices;
      this._rebuildDeviceConfigs?.();
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
      } else if (!needPairDev && this.needPairAddr && !this.needPairBusy) {
        const prevDev = devices.find(d => d.addr === this.needPairAddr);
        const s = prevDev?.ble_state;
        if (s === 'discovering' || s === 'syncing' || s === 'ready') {
          this.showToast('Device paired successfully', 'success');
        }
        this.needPairAddr = null;
      }

      // Active-device adoption (see docs/modules/app-ws.md):
      // the persisted preference is written ONLY by explicit user actions.
      // Re-adopt it when its device reappears; outage fallback is display-only.
      if (devices.length > 0) {
        const preferred = persistGet('activeNodeId', '');
        if (preferred && devices.find(d => d.node_id === preferred)) {
          if (this.activeNodeId !== preferred) this.activeNodeId = preferred;
        } else if (!this.activeNodeId || !devices.find(d => d.node_id === this.activeNodeId)) {
          this.activeNodeId = devices[0].node_id;
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
      // Perf page cold-load race: loadPerfHistory no-ops until the device
      // list exists — retry once devices arrive.
      if (this.tab === 'perf' && !this.perfHistory.length && devices.length) {
        this.loadPerfHistory();
        this.loadPerfLoraCfg();
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
          this.tiltHistory = [...this.tiltHistory, entry];
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
      // Perf page loads device-scoped history via REST (per-device contract,
      // docs/modules/app-perf.md); the global WS replay is ignored.
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
      if (ev.from != null && ev.tx_device && ev.tx_device === this.perfDev()) {
        const entry = {
          from_num: ev.from, to_num: ev.to ?? null,
          route: ev.route ?? [], route_back: ev.route_back ?? [],
          snr_towards: ev.snr_towards ?? [], snr_back: ev.snr_back ?? [],
          relay_positions: ev.relay_positions ?? {},
          ts: ev.ts ?? Math.floor(Date.now() / 1000),
          rx_device: ev.rx_device ?? null,
          tx_device: ev.tx_device, rotator_az: ev.rotator_az ?? null,
        };
        this.perfHistory = [entry, ...(this.perfHistory || [])].slice(0, 200);
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
        try {
          const pktId = pkt.id;
          const text = b64ToUtf8(pkt.decoded.payload);
          const toNum = pkt.to >>> 0;
          const fromNum = pkt.from ?? 0;
          const injectedUser = pkt.decoded.user;
          const fromNode = !injectedUser ? this.nodes.find(n => n.num === fromNum) : null;
          const fromName  = ev.from_name || injectedUser?.short_name || fromNode?.display_name || fromNode?.user?.short_name || null;
          const longName  = injectedUser?.long_name  || fromNode?.user?.long_name  || null;
          const hops = (pkt.hop_start != null && pkt.hop_limit != null)
            ? Math.max(0, pkt.hop_start - pkt.hop_limit) : null;
          if (fromName || longName) {
            this.msgNodeCache[fromNum] = { num: fromNum, display_name: fromName, user: { short_name: fromName, long_name: longName } };
          }
          // Dedupe: with multiple radios the same mesh packet arrives once per
          // radio. Merge the later copy's source/signal into the existing entry —
          // a second entry would duplicate the x-for key and freeze the feed.
          const dupe = this.messages.find(m => m.pktId === pktId);
          if (dupe) {
            const srcId = ev.node_id || ev.addr || ev.device;
            if (srcId && !dupe.src.includes(srcId)) dupe.src = [...dupe.src, srcId];
            if (dupe.rssi == null && pkt.rx_rssi != null) dupe.rssi = pkt.rx_rssi;
            if (dupe.snr  == null && pkt.rx_snr  != null) dupe.snr  = pkt.rx_snr;
          } else {
          // Thread structure for live events: treat as root; corrected on next message_history replay.
          this.messages.unshift({
            pktId, fromNum, to: toNum,
            fromShortName: fromName,
            fromLongName:  longName,
            hops, rssi: pkt.rx_rssi ?? null, snr: pkt.rx_snr ?? null,
            broadcast: toNum === 0xFFFFFFFF || pkt.to == null,
            channel: pkt.channel ?? 0,
            replyId: pkt.decoded.reply_id || null,
            threadRootPktId: pktId, replyDepth: 0, isOrphan: false, isReply: false,
            text, ts: pkt.rx_time || Math.floor(Date.now() / 1000), time, direction: 'rx', ackStatus: null,
            src: (ev.node_id || ev.addr || ev.device) ? [ev.node_id || ev.addr || ev.device] : [],
          });
          if (this.messages.length > 50) this.messages.pop();
          if (this.tab !== 'messages') { this.unreadMessages++; this.playMsgSound(); }
          }
        } catch (_) {}
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
