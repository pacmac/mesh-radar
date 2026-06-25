// WebSocket connection and event dispatch mixin.
import { b64ToUtf8, summarizeEvent, FEED_FILTER_OPTIONS } from './app-helpers.js';
import { persistSet } from './app-persist.js';
import { FF } from './feature-flags.js';
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

  _applyStateEvent(ev) {
    const device = ev.device;
    if (!device) return;
    const t = ev.type;
    const existing = this.deviceBleStates[device] || {};
    const SKIP = new Set(['type', 'device', 'ts', 'my_info', 'metadata', 'config', 'module_config']);
    const patch = { ...existing };
    for (const [k, v] of Object.entries(ev)) {
      if (!SKIP.has(k) && v !== undefined) patch[k] = v;
    }

    if (t === 'ready') {
      this.serverReachable = true;
      if (ev.mqtt_proxy != null) this.mqttProxy = !!ev.mqtt_proxy;
      if (ev.my_info)   this.info = { ...this.info, my_info: ev.my_info };
      if (ev.metadata)  this.info = { ...this.info, metadata: ev.metadata };
      if (ev.module_config?.mqtt) this.mqttCfg = ev.module_config.mqtt;
      if (ev.config?.lora)        this.loraCfg = ev.config.lora;
      const isPrimary = device === (this.primaryDeviceId || this.activeNodeId);
      if (isPrimary) this.bootstrapDevice();
    } else if (t === 'snapshot') {
      this.serverReachable = true;
      if (ev.mqtt_proxy != null) this.mqttProxy = !!ev.mqtt_proxy;
    } else if (t === 'mqtt_proxy_up') {
      this.mqttProxy = true;
    } else if (t === 'mqtt_proxy_down') {
      this.mqttProxy = false;
    } else {
      // connecting | syncing | reconnecting | idle | sync_progress | error
      this.serverReachable = true;
    }

    this.deviceBleStates = { ...this.deviceBleStates, [device]: patch };
  },

  handleEvent(ev) {
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
      const devices = (ev.devices || []).filter(d => !String(d.node_id).startsWith('ble:'));
      const knownIds = new Set(this.availableDevices.map(d => d.node_id));
      for (const dev of devices) {
        if (!knownIds.has(dev.node_id)) this.loadAutoPurge(dev.node_id);
      }
      this.availableDevices = devices;
      const existing = {};
      for (const dev of devices) {
        const cur = this.deviceBleStates[dev.node_id];
        existing[dev.node_id] = cur
          ? { ...cur, long_name: dev.long_name, short_name: dev.short_name, hw_model: dev.hw_model }
          : { ...dev };
      }
      this.deviceBleStates = { ...this.deviceBleStates, ...existing };
      if (!this.activeNodeId && devices.length > 0) {
        this.activeNodeId = devices[0].node_id;
        persistSet('activeNodeId', this.activeNodeId);
      }
      if (!this.msgFrom || !devices.find(d => d.node_id === this.msgFrom)) {
        this.msgFrom = this.activeNodeId;
        persistSet('msgFrom', this.msgFrom);
      }
      if (!this.cfgRadioId || !devices.find(d => d.node_id === this.cfgRadioId)) {
        this.cfgRadioId = this.activeNodeId;
      }
      return;
    }

    if (ev.type === 'ota_start') {
      this._otaSeq++;
      this.otaActive = true;
      this.otaDone = false;
      this.otaPct = 0;
      this.otaBleAddr = ev.ble_addr || ev.device || null;
      this.otaProtocol = ev.protocol || null;
      this.otaError = null;
      if (ev.device) this.deviceOtaState[ev.device] = { state: 'flashing', pct: 0 };
    }
    if (ev.type === 'ota_progress') {
      if (!this.otaActive) { this.otaActive = true; this.otaDone = false; this.otaBleAddr = ev.ble_addr || ev.device || null; }
      this.otaPct = ev.data?.pct ?? this.otaPct;
      if (ev.device) this.deviceOtaState[ev.device] = { state: 'flashing', pct: this.otaPct };
      return;
    }
    if (ev.type === 'ota_complete') {
      this.otaDone = true;
      this.otaError = null;
      if (ev.device) this.deviceOtaState[ev.device] = { state: 'done', pct: 100 };
      const seq = ++this._otaSeq;
      setTimeout(() => { if (this._otaSeq === seq) { this.otaActive = false; this.otaDone = false; } }, 2500);
    }
    if (ev.type === 'ota_error') {
      this.otaError = ev.data?.error || 'OTA failed';
      if (ev.device) this.deviceOtaState[ev.device] = { state: 'error', pct: this.otaPct };
    }

    if (ev.type === 'ota_download_start') {
      if (ev.device) this.otaDownloadState[ev.device] = { state: 'downloading', pct: 0 };
      return;
    }
    if (ev.type === 'ota_download_progress') {
      if (ev.device) this.otaDownloadState[ev.device] = { state: 'downloading', pct: ev.data?.pct ?? 0 };
      return;
    }
    if (ev.type === 'ota_download_complete') {
      if (ev.device) {
        this.otaDownloadState[ev.device] = { state: 'done', pct: 100 };
        this.$nextTick(() => this.loadOtaFiles(ev.device));
      }
      return;
    }
    if (ev.type === 'ota_download_error') {
      if (ev.device) this.otaDownloadState[ev.device] = { state: 'error', pct: 0, error: ev.data?.error };
      return;
    }

    if (['snapshot', 'ready', 'connecting', 'syncing', 'sync_progress',
         'reconnecting', 'error', 'idle', 'mqtt_proxy_up', 'mqtt_proxy_down'].includes(ev.type)) {
      this._applyStateEvent(ev);
      return;
    }

    if (ev.type === 'tilt_update' && ev.from_num != null) {
      const idx = this.nodes.findIndex(n => n.num === ev.from_num);
      if (idx >= 0) this.nodes[idx] = { ...this.nodes[idx], tilt: ev.data };
      if (this.nodeSelf?.num === ev.from_num) {
        this.nodeSelf = { ...this.nodeSelf, tilt: ev.data };
        if (ev.data?.pitch != null && ev.device === this.activeNodeId) {
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
        const hist = this.envHistory[nid];
        if (hist && (em.temperature != null || em.relative_humidity != null)) {
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
    this.events.unshift({ type: ev.type, portnum, time, summary, device: ev.device || null });
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
          if (pktId && this._seenPacketIds.has(pktId)) {
            if (ev.device) {
              const existing = this.messages.find(m => m.pktId === pktId);
              if (existing && !existing.src.includes(ev.device)) existing.src = [...existing.src, ev.device];
            }
          } else {
            if (pktId) {
              this._seenPacketIds.add(pktId);
              if (this._seenPacketIds.size > 200) this._seenPacketIds.delete(this._seenPacketIds.values().next().value);
            }
            const text = b64ToUtf8(pkt.decoded.payload);
            const localTx = this.messages.find(m => m._localTx && m.fromNum === (pkt.from ?? 0) && m.text === text);
            if (localTx) {
              localTx.pktId = pktId;
              // BLE echo = radio confirmed TX queued. For broadcasts this is the final state.
              // For DMs we wait for routing_ack; start a 30s timeout for no-ack.
              localTx.ackStatus = localTx.broadcast ? 'confirmed' : 'sent';
              if (!localTx.broadcast) this._startAckTimeout(pktId);
              const _txKey = localTx._txKey;
              delete localTx._localTx;
              try {
                const _pt = JSON.parse(sessionStorage.getItem('pendingTx') || '[]');
                sessionStorage.setItem('pendingTx', JSON.stringify(_pt.filter(x => x._txKey !== _txKey)));
              } catch (_) {}
            } else {
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
              this.messages.unshift({
                pktId, fromNum, to: toNum,
                fromShortName: fromName,
                fromLongName:  longName,
                hops, rssi: pkt.rx_rssi ?? null, snr: pkt.rx_snr ?? null,
                broadcast: toNum === 0xFFFFFFFF || pkt.to == null,
                channel: pkt.channel ?? 0,
                replyId: pkt.decoded.reply_id || null,
                text, ts: pkt.rx_time || Math.floor(Date.now() / 1000), time, direction: 'rx', ackStatus: null,
                src: ev.device ? [ev.device] : [],
              });
              if (this.messages.length > 50) this.messages.pop();
              try { localStorage.setItem('msgHistory', JSON.stringify(this.messages.slice(0, 20))); } catch (_) {}
              if (this.tab !== 'messages') { this.unreadMessages++; this.playMsgSound(); }
            }
          }
        } catch (_) {}
      }
      if (pkt?.from != null) {
        this.lastHeardNum = pkt.from;
        if (this.tab === 'radar') this.drawRadar();
      }
      if (this.tab === 'nodes' && portnum === 'TELEMETRY_APP') this.sortNodes(this.nodeSort.key, true);
    }

    if (ev.type === 'routing_ack') {
      const m = this.messages.find(m => m.pktId === ev.packet_id);
      if (m) {
        if (ev.error_reason === 0) {
          m.ackStatus = 'acked';
          m.ackFrom   = ev.from_num ?? null;
        } else {
          m.ackStatus   = 'no_ack';
          m.ackError    = ev.error_name || 'NO_ROUTE';
          m.ackFrom     = ev.from_num ?? null;
        }
        this._clearAckTimeout(ev.packet_id);
      }
    }

    if (ev.type === 'range_test_entry' && ev.data) {
      this._rangeStats = null; this._rangeChartCache = null;
      const entry = {
        ...ev.data,
        rx_device: ev.device  ?? null,
        from_name: ev.from_name ?? null,
        rx_name:   ev.rx_name  ?? null,
        _uid: 'live_' + (this._rangeUid++),
      };
      this.rangeLog = [entry, ...this.rangeLog].slice(0, 500);
      this._rangeTick++;
    }
    if (ev.type === 'auto_purge_complete') {
      if (this.autoPurge[ev.device]) this.autoPurge[ev.device].last_run_ts = ev.ts;
      this.nodes = [];
      this.showToast(`Auto-purge complete on ${ev.device}`, 'success');
    }
    if (ev.type === 'auto_purge_error') {
      this.showToast(`Auto-purge failed on ${ev.device}: ${ev.error}`, 'error');
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

  _startAckTimeout(pktId) {
    if (!pktId) return;
    this._ackTimers[pktId] = setTimeout(() => {
      delete this._ackTimers[pktId];
      const m = this.messages.find(m => m.pktId === pktId);
      if (m && m.ackStatus === 'sent') {
        m.ackStatus = 'no_ack';
        m.ackError  = 'TIMEOUT';
      }
    }, 30000);
  },

  _clearAckTimeout(pktId) {
    if (this._ackTimers[pktId]) {
      clearTimeout(this._ackTimers[pktId]);
      delete this._ackTimers[pktId];
    }
  },
};
