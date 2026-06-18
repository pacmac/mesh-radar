// mesh-gw dashboard — node-dash edition
// All API calls are relative (no MESH_API prefix).
// Node filters and radar prefs are persisted server-side via /config.
// Rotator is managed by node-dash: /rotator/status|move|mode.

const SENSITIVE_FIELDS = new Set(["psk", "macaddr", "public_key", "private_key", "password"]);

// Map from Alpine nodeFilters keys to /config API keys
const FILTER_CFG_KEY = {
  maxHops:   'node_filters.max_hops',
  maxAge:    'node_filters.max_age',
  namedOnly: 'node_filters.named_only',
  hasPos:    'node_filters.has_pos',
  hideMqtt:  'node_filters.hide_mqtt',
  hasSignal: 'node_filters.has_signal',
  hasTelem:  'node_filters.has_telem',
  nodeRoles: 'node_filters.roles',
};

function dashboard() {
  return {
    tab: localStorage.getItem("activeTab") || "overview",
    cfgTab: localStorage.getItem("activeCfgTab") || "device",
    drawerOpen: false,
    sidebarPinned: localStorage.getItem('sidebarPinned') !== 'false',
    activeNodeId: localStorage.getItem("activeNodeId") || "",
    msgFrom: localStorage.getItem("msgFrom") || "",
    msgIsDirect: false,
    msgDirectTo: "",
    msgReplyId: null,
    msgReplyFrom: null,
    msgInsertNode: null,
    msgInputHistory: JSON.parse(localStorage.getItem('msgInputHistory') || '[]'),
    msgHistoryIdx: -1,
    msgDraft: '',
    mentionOpen: false,
    mentionQuery: '',
    mentionPos: 0,
    mentionIdx: 0,
    unreadMessages: 0,
    _seenPacketIds: new Set(),
    availableDevices: [],
    status: {},
    info: { my_info: {}, metadata: {} },
    nodeSelf: {},
    nodes: [],
    nodeTotal: 0,
    nodeCount: 0,
    nodeSort: { key: "last_heard", dir: -1 },
    nodeFilters: {
      maxHops:   99,
      namedOnly: false,
      hasPos:    false,
      hasSignal: false,
      hasTelem:  false,
      maxAge:    0,
      hideMqtt:  false,
      nodeRoles: [],
    },
    mqttProxy: false,
    mqttCfg: {},
    loraCfg: {},
    ble_ready: false,
    _readbackQueue: [],
    wsConnected: false,
    serverReachable: true,
    yagiAz: null,
    yagiConnected: false,
    yagiPointTarget: null,
    rotatorStatus: {},
    rotatorConnected: false,
    rotatorManualAz: null,
    rotatorMode: 0,
    otaActive: false,
    otaPct: 0,
    otaBleAddr: null,
    otaError: null,
    events: [],
    allSections: [],
    channels: [],
    channelSchema: null,
    ownerSchema: null,
    ownerData: {},
    ownerSaved: false,
    ownerError: "",
    fixedPosition: { lat: null, lon: null, alt: null, loaded: false, saved: false, error: "" },
    msgChannel: "0",
    msgText: "",
    msgSent: false,
    messages: [],

    // BLE setup state
    bleDevices: [],
    bleScanning: false,
    bleConnecting: false,
    bleAddress: "",
    blePin: "",
    bleError: "",

    // Radar tab state — defaults; overwritten from /config on init
    radarRange: "50",
    radarLogScale: false,
    radarNodes: [],
    radarSelected: null,
    homePos: null,
    geocoding: false,
    radarCrosshair: true,
    heatmapMaxAge: 3600,

    // Node Info modal
    nodeInfo: null,

    get targetNode() {
      if (!this.yagiPointTarget) return null;
      return this.radarNodes.find(n => n.num === this.yagiPointTarget)
          || this.filteredNodes().find(n => n.num === this.yagiPointTarget)
          || null;
    },
    lastHeardNum: null,

    // Per-device config (label, is_rotator, is_primary) — persisted via /device-config
    deviceConfigs: {},
    packetSources: [],
    cfgRadioId: "",       // which radio the Config → Radio tab operates on
    radioTab:   "device", // inner sub-tab within the Radio cfg tab

    // Antenna config state (per radio, within Radio cfg tab)
    antennaSaved: false,
    antennaError: "",

    // Bridge Config tab state
    bridgeConfigSchema: null,
    bridgeConfigSaved: false,
    bridgeConfigError: "",

    // Rotator Config tab state
    rotatorCfgSchema: null,
    rotatorCfgSaved: false,
    rotatorCfgError: "",
    rotatorCalSent: false,
    rotatorCalError: "",

    // Range test tab state
    rangeLog: [],
    rangeLoading: false,
    rangeRadioId: "",
    rangeDuration: 10,
    rangeTimer: { active: false, endsAt: null, nodeId: null, remaining: null },
    _rangeCountdown: null,
    _rangeAutoSync: null,

    msgIsModal: false,
    _composeTa: null,

    // -- nav -----------------------------------------------------------------------
    setNav(t, c) {
      this.tab = t;
      localStorage.setItem("activeTab", t);
      if (c) { this.cfgTab = c; localStorage.setItem("activeCfgTab", c); }
      this.drawerOpen = false;
      if (t === "radar") this.$nextTick(() => this.initRadar());
      else if (t === "cfg") this.switchCfgTab(c || this.cfgTab || "radio");
      else if (t === "range") { this.loadRangeTest(); this.loadRangeTimer(); this._startRangeAutoSync(); }
      else if (t === "nodes") this.loadNodes();
      else if (t === "devices") this.loadDevices();
      else if (t === "messages") this.unreadMessages = 0;
    },

    d(path) {
      return this.activeNodeId ? "/" + this.activeNodeId + path : path;
    },

    // cd() — like d() but uses cfgRadioId for Radio Config tab operations
    cd(path) {
      const id = this.cfgRadioId || this.activeNodeId;
      return id ? "/" + id + path : path;
    },

    // rd() — like d() but uses rangeRadioId for Range Test tab operations
    rd(path) {
      const id = this.rangeRadioId || this.activeNodeId;
      return id ? "/" + id + path : path;
    },

    // -- device management -------------------------------------------------------
    async loadDevices() {
      try {
        const data = await fetchJSON("/devices");
        this.availableDevices = (data.devices || []).filter(d => !String(d.node_id).startsWith("ble:"));
        if (!this.activeNodeId && this.availableDevices.length > 0) {
          this.activeNodeId = this.availableDevices[0].node_id;
          localStorage.setItem("activeNodeId", this.activeNodeId);
        }
        if (!this.msgFrom || !this.availableDevices.find(d => d.node_id === this.msgFrom)) {
          this.msgFrom = this.activeNodeId;
          localStorage.setItem("msgFrom", this.msgFrom);
        }
        if (!this.cfgRadioId || !this.availableDevices.find(d => d.node_id === this.cfgRadioId)) {
          this.cfgRadioId = this.activeNodeId;
        }
      } catch (e) {
        console.warn("Failed to load devices", e);
      }
    },

    _clearDeviceState() {
      this.status = {};
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
      this.fixedPosition = { lat: null, lon: null, alt: null, loaded: false, saved: false, error: "" };
    },

    async selectDevice(nodeId) {
      this.activeNodeId = nodeId;
      localStorage.setItem("activeNodeId", nodeId);
      this._clearDeviceState();
      this.reconnectWS();
      await this.bootstrapDevice();
      if (this.tab === "radar") this.initRadar();
    },

    async bootstrapDevice() {
      if (!this.activeNodeId) return;
      await this.refreshStatus();
      await Promise.all([this.loadInfo(), this.loadNodes()]);
      this.updateHomePos();
    },

    async disconnectDevice(nodeId) {
      this.bleError = "";
      try {
        await fetchJSON("/devices/" + encodeURIComponent(nodeId), "DELETE");
        if (this.activeNodeId === nodeId) this.activeNodeId = "";
        await this.loadDevices();
        if (!this.activeNodeId && this.availableDevices.length > 0) {
          await this.selectDevice(this.availableDevices[0].node_id);
        }
      } catch (e) {
        this.bleError = "Disconnect failed: " + e;
      }
    },

    async init() {
      // Seed messages from localStorage as a fast cache while /messages loads
      try {
        const saved = JSON.parse(localStorage.getItem("msgHistory") || "[]");
        if (Array.isArray(saved) && saved.length) {
          this.messages = saved;
          saved.forEach(m => { if (m.pktId) this._seenPacketIds.add(m.pktId); });
        }
      } catch (_) {}

      await this.loadDevices();
      await this.loadConfig();           // node filters, radar prefs, packet_sources
      await this.loadDeviceConfigs();    // per-device labels + roles → may override activeNodeId
      await this.loadBridgeConfig();

      if (this.activeNodeId) {
        await this.bootstrapDevice();
      }

      await this.loadMessages();
      await this.loadRotatorState();

      this.connectWS();
      this.$watch('ble_ready', (ready, wasReady) => {
        if (ready && !wasReady) this._drainReadbackQueue();
      });
      setInterval(() => { this.loadDevices(); }, 60000);

      if (this.tab === "radar") this.$nextTick(() => this.initRadar());
      else if (this.tab === "cfg") this.switchCfgTab(this.cfgTab);
      else if (this.tab === "range") this.loadRangeTest();
    },

    // Load node filter + radar prefs from /config (server-side SQLite)
    async loadConfig() {
      try {
        const cfg = await fetchJSON('/config');
        this.nodeFilters = {
          maxHops:   cfg['node_filters.max_hops']   ?? 99,
          maxAge:    cfg['node_filters.max_age']    ?? 0,
          namedOnly: cfg['node_filters.named_only'] ?? false,
          hasPos:    cfg['node_filters.has_pos']    ?? false,
          hideMqtt:  cfg['node_filters.hide_mqtt']  ?? false,
          hasSignal: cfg['node_filters.has_signal'] ?? false,
          hasTelem:  cfg['node_filters.has_telem']  ?? false,
          nodeRoles: cfg['node_filters.roles']      ?? [],
        };
        this.radarRange     = String(cfg['radar.max_range_km'] ?? 50);
        this.radarLogScale  = cfg['radar.log_scale']  ?? false;
        this.radarCrosshair = cfg['radar.crosshair']  ?? true;
        this.packetSources  = cfg['packet_sources']   ?? [];
      } catch (e) {
        console.warn('Failed to load config', e);
      }
    },

    async loadDeviceConfigs() {
      try {
        this.deviceConfigs = await fetchJSON('/device-config');
        // If a primary device is configured and available, use it for overview
        const primaryEntry = Object.entries(this.deviceConfigs).find(([, c]) => c?.is_primary);
        if (primaryEntry) {
          const [primaryId] = primaryEntry;
          if (this.availableDevices.find(d => d.node_id === primaryId)) {
            this.activeNodeId = primaryId;
            localStorage.setItem('activeNodeId', primaryId);
            if (!this.msgFrom) { this.msgFrom = primaryId; localStorage.setItem('msgFrom', primaryId); }
          }
        }
      } catch (e) {
        console.warn('Failed to load device configs', e);
      }
    },

    async saveBleCfg(bleAddress, field, value) {
      // Update a bridge-side BLE device setting (auto_connect etc.)
      const dev = this.availableDevices.find(d => d.ble_address === bleAddress);
      if (dev) dev[field] = value; // optimistic
      try {
        await fetchJSON(`/ble_devices/${encodeURIComponent(bleAddress)}`, 'PATCH', { [field]: value });
      } catch (e) {
        console.warn('saveBleCfg failed', e);
        if (dev) dev[field] = !value; // revert
      }
    },

    async saveDeviceCfg(nodeId, field, value) {
      const existing = this.deviceConfigs[nodeId] || {};
      const updated = { ...existing, [field]: value };
      // Optimistic update
      this.deviceConfigs = { ...this.deviceConfigs, [nodeId]: updated };
      if (field === 'is_primary' && value) {
        // Clear primary from others locally
        const next = { ...this.deviceConfigs };
        for (const id of Object.keys(next)) {
          if (id !== nodeId) next[id] = { ...next[id], is_primary: false };
        }
        this.deviceConfigs = next;
        this.activeNodeId = nodeId;
        localStorage.setItem('activeNodeId', nodeId);
      }
      try {
        await fetchJSON(`/device-config/${encodeURIComponent(nodeId)}`, 'PUT', { [field]: value });
      } catch (e) {
        console.warn('saveDeviceCfg failed', e);
      }
    },

    async saveAntennaCfg() {
      this.antennaSaved = false;
      this.antennaError = "";
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

    togglePacketSource(nodeId, checked) {
      let sources = [...this.packetSources];
      if (checked && !sources.includes(nodeId)) sources.push(nodeId);
      else if (!checked) sources = sources.filter(id => id !== nodeId);
      // Empty = all devices
      if (sources.length === this.availableDevices.length) sources = [];
      this.packetSources = sources;
      fetchJSON('/config/packet_sources', 'PUT', { value: sources }).catch(() => {});
    },

    // -- bridge-side config (schema-driven via /bridge_config) --------
    async loadBridgeConfig() {
      try {
        const [schema, data] = await Promise.all([
          fetchJSON("/schema/bridge_config"),
          fetchJSON("/bridge_config"),
        ]);
        this.bridgeConfigSchema = schema;
        await nextFrame();
        const el = document.getElementById("bridge_cfg_form");
        if (el && !el.dataset.dirty) {
          el.innerHTML = "";
          el.dataset.formRoot = "1";
          el.appendChild(buildForm(schema.fields, data, []));
        }
      } catch (e) {
        console.warn("Failed to load bridge config", e);
      }
    },

    resetNodeFilters() {
      this.nodeFilters = {
        maxHops: 99, maxAge: 0, namedOnly: false, hasPos: false,
        hideMqtt: false, hasSignal: false, hasTelem: false, nodeRoles: [],
      };
      fetchJSON('/config', 'PUT', {
        'node_filters.max_hops':   99,
        'node_filters.max_age':    0,
        'node_filters.named_only': false,
        'node_filters.has_pos':    false,
        'node_filters.hide_mqtt':  false,
        'node_filters.has_signal': false,
        'node_filters.has_telem':  false,
        'node_filters.roles':      [],
      }).catch(() => {});
      this.loadNodes();
    },

    async saveBridgeConfig() {
      this.bridgeConfigSaved = false;
      this.bridgeConfigError = "";
      try {
        const el = document.getElementById("bridge_cfg_form");
        const payload = collectForm(el, this.bridgeConfigSchema.fields);
        await fetchJSON("/bridge_config", "PUT", payload);
        el.removeAttribute("data-dirty");
        this.bridgeConfigSaved = true;
        setTimeout(() => { this.bridgeConfigSaved = false; }, 2000);
      } catch (e) {
        this.bridgeConfigError = String(e);
      }
    },

    // Save a radar display pref to /config so it persists across sessions/restarts
    saveRadarPref(key, value) {
      const cfgKeyMap = {
        max_range_km: 'radar.max_range_km',
        log_scale:    'radar.log_scale',
        crosshair:    'radar.crosshair',
      };
      const cfgKey = cfgKeyMap[key];
      if (cfgKey) fetchJSON(`/config/${cfgKey}`, 'PUT', { value }).catch(e => console.warn('saveRadarPref', e));
    },

    // -- home position --------------------------------------------------------
    updateHomePos() {
      const selfNum = this.info.my_info?.my_node_num;
      const self = selfNum != null ? this.nodes.find((n) => n.num === selfNum) : null;
      if (self?.position?.latitude_i) {
        this.homePos = {
          lat: self.position.latitude_i / 1e7,
          lon: self.position.longitude_i / 1e7,
        };
      }
    },

    nodeKm(n) {
      if (!this.homePos || !n.position?.latitude_i || !n.position?.longitude_i) return null;
      return haversine(this.homePos.lat, this.homePos.lon, n.position.latitude_i / 1e7, n.position.longitude_i / 1e7);
    },
    nodeAz(n) {
      if (!this.homePos || !n.position?.latitude_i || !n.position?.longitude_i) return null;
      return bearing(this.homePos.lat, this.homePos.lon, n.position.latitude_i / 1e7, n.position.longitude_i / 1e7);
    },
    rssiPercent(rssi) { return rssiPercent(rssi); },

    // -- polling / status -----------------------------------------------------
    async refreshStatus() {
      if (!this.activeNodeId) return;
      try {
        this.status = await fetchJSON(this.d("/status"));
        this.mqttProxy = this.status.mqtt_proxy_connected;
        this.ble_ready = !!this.status.ready;
        this.serverReachable = true;
      } catch (_) {
        this.serverReachable = false;
      }
    },

    async loadInfo() {
      if (!this.activeNodeId) return;
      this.info = await fetchJSON(this.d("/info"));
      const cfg = await fetchJSON(this.d("/config"));
      this.mqttCfg = cfg.module_config?.mqtt || {};
      this.loraCfg = cfg.config?.lora || {};
    },

    async restartMqttProxy() {
      try {
        await fetchJSON('/mqtt_proxy/restart', 'POST', {});
      } catch (e) {
        console.error('Failed to restart MQTT proxy', e);
      }
    },

    // /nodes on node-dash applies stored config filters before proxying to bridge
    async loadNodes() {
      if (!this.availableDevices.length) return;
      try {
        const data = await fetchJSON('/nodes');
        this.nodeTotal = data.total ?? Object.keys(data.nodes || {}).length;
        this.nodeCount = data.count ?? this.nodeTotal;
        this.nodes = Object.values(data.nodes || {});
        this.updateHomePos();
        this.sortNodes(this.nodeSort.key, true);
        if (this.info.my_info?.my_node_num != null) {
          this.nodeSelf = data.nodes?.[String(this.info.my_info.my_node_num)] || {};
        }
      } catch (e) {
        console.warn('loadNodes failed', e);
      }
    },

    async loadMessages() {
      try {
        const rows = await fetchJSON('/messages?limit=50');
        if (Array.isArray(rows) && rows.length) {
          const ownNums = new Set(
            (this.availableDevices || [])
              .map(d => parseInt((d.node_id || '').replace('!', ''), 16))
              .filter(Boolean)
          );
          this.messages = rows.map(r => ({
            pktId:     r.packet_id,
            replyId:   r.reply_id || null,
            fromNum:   r.from_num,
            to:        r.to_num >>> 0,
            broadcast: (r.to_num >>> 0) === 0xFFFFFFFF || r.is_dm === 0,
            channel:   r.channel ?? 0,
            text:      r.text,
            ts:        r.ts,
            time:      new Date(r.ts * 1000).toLocaleTimeString(),
            direction: ownNums.has(r.from_num) ? 'tx' : 'rx',
            ackStatus: null,
            src:       r.rx_devices ? r.rx_devices.split(',').filter(Boolean) : [],
          }));
          this.messages.forEach(m => { if (m.pktId) this._seenPacketIds.add(m.pktId); });
          try { localStorage.setItem("msgHistory", JSON.stringify(this.messages.slice(0, 20))); } catch (_) {}
        }
      } catch (e) {
        console.warn('loadMessages failed', e);
      }
    },

    displayMessages() {
      const msgs = this.messages;
      const byPktId = new Map();
      for (const m of msgs) { if (m.pktId) byPktId.set(m.pktId, m); }

      // Walk a message up its reply chain to find the ultimate root visible in this window.
      // Stops when the parent is absent (orphan) or has no replyId.
      const getRoot = (m, visited = new Set()) => {
        if (!m.replyId || !byPktId.has(m.replyId) || visited.has(m.pktId)) return m;
        visited.add(m.pktId);
        return getRoot(byPktId.get(m.replyId), visited);
      };

      // Bucket every reply under its ultimate root at depth 1 (flat thread)
      const childrenOf = new Map();
      const knownChildren = new Set();
      for (const m of msgs) {
        if (!m.replyId) continue;
        const root = getRoot(m);
        if (root === m) continue; // m is itself a root (orphan whose parent is unknown)
        if (!childrenOf.has(root.pktId)) childrenOf.set(root.pktId, []);
        childrenOf.get(root.pktId).push(m);
        knownChildren.add(m);
      }

      // Roots: messages not bucketed under any known ancestor in this window
      const roots = msgs.filter(m => !knownChildren.has(m));

      const result = [];
      for (const root of roots) {
        // Orphan roots (their own parent is missing) still get the ↩ indicator
        const rootIsOrphan = !!(root.replyId && !byPktId.has(root.replyId));
        result.push({ ...root, isReply: rootIsOrphan, replyDepth: 0 });
        const replies = (childrenOf.get(root.pktId) || []).slice().sort((a, b) => a.ts - b.ts);
        for (const r of replies) result.push({ ...r, isReply: true, replyDepth: 1 });
      }
      return result;
    },

    // -- BLE management -------------------------------------------------------
    async bleScan() {
      this.bleScanning = true;
      this.bleError = "";
      try {
        const data = await fetchJSON("/ble/scan");
        this.bleDevices = data.devices || [];
        if (this.bleDevices.length === 0) this.bleError = "No Meshtastic devices found.";
      } catch (e) {
        this.bleError = "Scan failed: " + (e.message || e);
      } finally {
        this.bleScanning = false;
      }
    },

    async bleConnect(address) {
      const addr = address || this.bleAddress;
      if (!addr) return;
      this.bleAddress = addr;
      this.bleConnecting = true;
      this.bleError = "";
      try {
        await fetchJSON("/devices", "POST", { address: addr, pin: this.blePin || "" });
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          await this.loadDevices();
          const dev = this.availableDevices.find(d => d.ble_address?.toUpperCase() === addr.toUpperCase());
          if (dev) {
            if (!this.activeNodeId) await this.selectDevice(dev.node_id);
            if (dev.ble_state !== "connecting") break;
          }
        }
      } catch (e) {
        this.bleError = "Connect failed: " + (e.message || e);
      } finally {
        this.bleConnecting = false;
      }
    },

    sortNodes(key, keepDir) {
      if (!keepDir) {
        this.nodeSort.dir = this.nodeSort.key === key ? -this.nodeSort.dir : -1;
      }
      this.nodeSort.key = key;
      const dir = this.nodeSort.dir;
      const getVal = (n) => {
        switch (key) {
          case "long_name":  return n.user?.long_name || "";
          case "short_name": return n.user?.short_name || "";
          case "id":         return n.user?.id || String(n.num ?? 0);
          case "battery":    return n.device_metrics?.battery_level ?? -1;
          case "snr":        return n.snr ?? -999;
          case "rssi":       return rssiPercent(n.rssi ?? -999);
          case "km":         return this.nodeKm(n) ?? 9999;
          case "az":         return this.nodeAz(n) ?? -1;
          case "hops":       return n.hops ?? 999;
          case "last_heard": return n.last_heard ?? 0;
          default:           return n[key] ?? "";
        }
      };
      this.nodes.sort((a, b) => {
        const av = getVal(a), bv = getVal(b);
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    },

    saveNodeFilter(key, val) {
      this.nodeFilters[key] = val;
      const cfgKey = FILTER_CFG_KEY[key];
      if (cfgKey) fetchJSON(`/config/${cfgKey}`, 'PUT', { value: val }).catch(() => {});
      this.loadNodes();
    },

    toggleNodeRole(role, checked) {
      const ALL = ['CLIENT','CLIENT_BASE','CLIENT_MUTE','ROUTER','ROUTER_CLIENT','ROUTER_LATE','TRACKER','SENSOR','REPEATER'];
      let cur = this.nodeFilters.nodeRoles.length ? [...this.nodeFilters.nodeRoles] : [...ALL];
      cur = checked ? [...new Set([...cur, role])] : cur.filter(r => r !== role);
      this.saveNodeFilter('nodeRoles', cur.length === ALL.length ? [] : cur);
    },

    filteredNodes() {
      const bridgeNums = new Set(
        this.availableDevices
          .map(d => d.node_id?.startsWith('!') ? parseInt(d.node_id.slice(1), 16) : null)
          .filter(n => n != null && !isNaN(n))
      );
      return bridgeNums.size ? this.nodes.filter(n => !bridgeNums.has(n.num >>> 0)) : this.nodes;
    },

    nodeById(nodeId) {
      if (!nodeId?.startsWith('!')) return null;
      const num = parseInt(nodeId.slice(1), 16);
      return this.nodes.find(n => n.num === num) || null;
    },

    nodeGroupLabel(n) {
      const key = this.nodeSort.key;
      const now = Date.now() / 1000;
      switch (key) {
        case 'last_heard': {
          const lh = n.last_heard;
          if (!lh) return 'Unknown';
          const age = now - lh;
          if (age < 120)   return 'Just now';
          if (age < 300)   return '5 min';
          if (age < 900)   return '15 min';
          if (age < 1800)  return '30 min';
          if (age < 3600)  return '1 hour';
          if (age < 10800) return '3 hours';
          if (age < 21600) return '6 hours';
          if (age < 86400) return 'Today';
          return 'Older';
        }
        case 'snr': {
          const snr = n.snr;
          if (snr == null) return 'No signal';
          if (snr >= 5)    return 'Strong';
          if (snr >= 0)    return 'Good';
          if (snr >= -5)   return 'Fair';
          if (snr >= -10)  return 'Weak';
          return 'Very weak';
        }
        case 'hops': {
          const h = n.hops;
          if (h == null) return 'Unknown';
          if (h === 0)   return 'Direct';
          if (h === 1)   return '1 hop';
          if (h === 2)   return '2 hops';
          if (h === 3)   return '3 hops';
          return '4+ hops';
        }
        case 'km': {
          const km = this.nodeKm(n);
          if (km == null) return 'No position';
          if (km < 2)    return '< 2 km';
          if (km < 5)    return '2–5 km';
          if (km < 10)   return '5–10 km';
          if (km < 25)   return '10–25 km';
          if (km < 50)   return '25–50 km';
          if (km < 100)  return '50–100 km';
          return '> 100 km';
        }
        case 'long_name': {
          const name = n.user?.long_name || n.user?.short_name || '';
          if (!name) return 'Unnamed';
          const c = name[0].toUpperCase();
          if (c <= 'E') return 'A–E';
          if (c <= 'J') return 'F–J';
          if (c <= 'O') return 'K–O';
          if (c <= 'T') return 'P–T';
          if (c <= 'Z') return 'U–Z';
          return 'Other';
        }
        default: return null;
      }
    },

    groupedNodes() {
      const nodes = this.filteredNodes();
      const groups = [];
      let curLabel = null;
      for (const n of nodes) {
        const label = this.nodeGroupLabel(n) ?? '—';
        if (label !== curLabel) {
          curLabel = label;
          groups.push({ label, nodes: [] });
        }
        groups[groups.length - 1].nodes.push(n);
      }
      const multi = groups.length > 1;
      return groups.map(g => ({ ...g, showHeader: multi }));
    },

    // -- websocket live feed ---------------------------------------------------
    connectWS() {
      const path = this.activeNodeId ? `/${this.activeNodeId}/events` : '/events';
      const ws = new WebSocket(location.origin.replace(/^http/, "ws") + path);
      this._ws = ws;
      ws.onopen  = () => {
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

    // -- Rotator ---------------------------------------------------------------
    _onRotatorEvent(data) {
      this.rotatorConnected = true;
      this.rotatorStatus = { ...this.rotatorStatus, ...data };
      if (data.az != null) {
        const azChanged = this.yagiAz !== data.az;
        this.yagiAz = data.az;
        if (azChanged && this.tab === "radar") this._animateBeam(data.az);
      }
      if ('point_target' in data) {
        this.yagiPointTarget = data.point_target;
        if (this.tab === "radar") this.drawRadar();
      }
    },

    _animateBeam(newAz) {
      const beamG = document.getElementById('radar-beam-g');
      if (!beamG) return;
      if (!beamG.firstChild) this._drawRadarBeam();
      if (this._radarBeamAz == null) {
        beamG.style.transition = 'none';
        beamG.style.transform = `rotate(${newAz}deg)`;
        beamG.getBoundingClientRect();
        beamG.style.transition = 'transform 1.2s ease';
      } else {
        beamG.style.transform = `rotate(${newAz}deg)`;
      }
      this._radarBeamAz = newAz;
      const lbl = beamG.querySelector('text');
      if (lbl) lbl.textContent = Math.round(newAz) + '°';
    },

    async loadRotatorState() {
      try {
        const d = await fetchJSON("/rotator/status");
        this.rotatorMode      = d.mode ?? 0;
        this.rotatorConnected = d.connected ?? false;
        this.rotatorStatus    = d;
        if (d.az != null) this.yagiAz = d.az;
        const pt = d.point_target ?? null;
        this.yagiPointTarget = pt && this.filteredNodes().some(n => n.num === pt) ? pt : null;
      } catch (_) {}
    },

    async setRotatorMode(m) {
      this.rotatorMode = m;
      try { await fetchJSON("/rotator/mode", "POST", { mode: m }); } catch (_) {}
    },

    async moveRotator(az) {
      if (az == null) return;
      await fetchJSON("/rotator/move", "POST", { az: Number(az) });
    },

    async loadRotatorCfg() {
      try {
        const needsSchema = !this.rotatorCfgSchema;
        const [schema, data] = await Promise.all([
          needsSchema ? fetchJSON("/schema/rotator_config") : Promise.resolve(this.rotatorCfgSchema),
          fetchJSON("/rotator/firmware_config"),
        ]);
        if (needsSchema) this.rotatorCfgSchema = schema;
        await nextFrame();
        const el = document.getElementById("rotator_cfg_form");
        if (el && !el.dataset.dirty) {
          el.innerHTML = "";
          el.dataset.formRoot = "1";
          el.appendChild(buildForm(schema.fields, data, []));
        }
      } catch (e) {
        console.warn("Failed to load rotator cfg", e);
      }
    },

    async saveRotatorConfig() {
      this.rotatorCfgSaved = false;
      this.rotatorCfgError = "";
      try {
        const el = document.getElementById("rotator_cfg_form");
        const payload = collectForm(el, this.rotatorCfgSchema.fields);
        await fetchJSON("/rotator/firmware_config", "POST", payload);
        el.removeAttribute("data-dirty");
        this.rotatorCfgSaved = true;
        setTimeout(() => { this.rotatorCfgSaved = false; }, 2000);
      } catch (e) {
        this.rotatorCfgError = String(e);
      }
    },

    async rotatorCalibrate(procedure) {
      this.rotatorCalSent = false;
      this.rotatorCalError = "";
      try {
        await fetchJSON("/rotator/calibrate", "POST", { procedure });
        this.rotatorCalSent = true;
        setTimeout(() => { this.rotatorCalSent = false; }, 2000);
      } catch (e) {
        this.rotatorCalError = String(e);
      }
    },

    _applyStateEvent(ev) {
      const t = ev.type;
      // Merge any status fields the event carries into this.status
      const fields = ["ble_state","ble_address","ble_error","ble_rssi","ble_rssi_pct",
                      "config_complete","node_count","my_node_num","last_rx_snr","last_rx_rssi",
                      "has_my_info","has_mqtt_config","mqtt_proxy"];
      const patch = {};
      for (const f of fields) if (ev[f] !== undefined) patch[f] = ev[f];
      if (Object.keys(patch).length) this.status = { ...this.status, ...patch };

      if (t === "snapshot" || t === "ready") {
        this.ble_ready = true;
        this.mqttProxy = !!(ev.mqtt_proxy);
        this.serverReachable = true;
        if (t === "ready") {
          this._drainReadbackQueue();
          this.bootstrapDevice();
        }
      } else if (t === "mqtt_proxy_up") {
        this.mqttProxy = true;
      } else if (t === "mqtt_proxy_down") {
        this.mqttProxy = false;
      } else {
        // connecting | syncing | sync_progress | reconnecting | error | idle
        // Don't collapse the dashboard during OTA — the bridge may reconnect mid-flash
        if (!this.otaActive) this.ble_ready = false;
        this.serverReachable = true;
      }
    },

    handleEvent(ev) {
      if (ev.type === "rotator") { this._onRotatorEvent(ev.data || {}); return; }

      if (ev.type === "ota_start") {
        this.otaActive = true;
        this.otaPct = 0;
        this.otaBleAddr = ev.ble_addr || ev.device || null;
        this.otaError = null;
        // fall through to event log
      }
      if (ev.type === "ota_progress") {
        this.otaPct = ev.data?.pct ?? this.otaPct;
        return;
      }
      if (ev.type === "ota_complete" || ev.type === "ota_error") {
        this.otaActive = false;
        this.otaError = ev.type === "ota_error" ? (ev.data?.error || "OTA failed") : null;
        // fall through to event log
      }

      // State-machine events from bridge — device-scoped
      if (["snapshot", "ready", "connecting", "syncing", "sync_progress",
           "reconnecting", "error", "idle", "mqtt_proxy_up", "mqtt_proxy_down"].includes(ev.type)) {
        if (!ev.device || ev.device === this.activeNodeId) {
          this._applyStateEvent(ev);
        }
        return;
      }

      // Legacy status event — backward compat during transition
      if (ev.type === "status") {
        if (!ev.device || ev.device === this.activeNodeId) {
          this.status = { ...this.status, ...ev.data };
          this.mqttProxy = ev.data.mqtt_proxy_connected;
          this.ble_ready = !!(ev.data.ready || (ev.data.ble_state === 'ready' && ev.data.config_complete));
          this.serverReachable = true;
        }
        return;
      }

      if (ev.type === "tilt_update" && ev.from_num != null) {
        const idx = this.nodes.findIndex(n => n.num === ev.from_num);
        if (idx >= 0) this.nodes[idx] = { ...this.nodes[idx], tilt: ev.data };
        if (this.nodeSelf?.num === ev.from_num) this.nodeSelf = { ...this.nodeSelf, tilt: ev.data };
        return;
      }

      if (ev.type === "node_update" && ev.data?.num != null) {
        const upd = ev.data;
        const idx = this.nodes.findIndex(n => n.num === upd.num);
        if (idx >= 0) this.nodes[idx] = { ...this.nodes[idx], ...upd };
        else this.nodes.push(upd);
        this.updateHomePos();
        if (this.tab === "radar" && this.homePos) {
          if (upd.position?.latitude_i) this.refreshRadar();
          else this.drawRadar();
        }
        if (this.tab === "nodes") this.sortNodes(this.nodeSort.key, true);
      }

      if (ev.device && this.activeNodeId && ev.device !== this.activeNodeId) return;
      const time = new Date().toLocaleTimeString();
      const summary = summarizeEvent(ev);
      this.events.unshift({ type: ev.type, time, summary, device: ev.device || null });
      if (this.events.length > 80) this.events.pop();

      if (ev.type === "packet") {
        const pkt = ev.data?.packet;
        const portnum = pkt?.decoded?.portnum;
        if (portnum === "TEXT_MESSAGE_APP" && pkt?.decoded?.payload) {
          try {
            const pktId = pkt.id;
            if (pktId && this._seenPacketIds.has(pktId)) {
              // Duplicate from second radio — add device badge to existing entry
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

              // Absorb echo of a locally sent TX message: update its pktId so threading works
              const localTx = this.messages.find(m => m._localTx && m.fromNum === (pkt.from ?? 0) && m.text === text);
              if (localTx) {
                localTx.pktId = pktId;
                delete localTx._localTx;
              } else {
                const toNum = pkt.to >>> 0;
                this.messages.unshift({
                  pktId, fromNum: pkt.from ?? 0, to: toNum,
                  broadcast: toNum === 0xFFFFFFFF || pkt.to == null,
                  channel: pkt.channel ?? 0,
                  replyId: pkt.decoded.reply_id || null,
                  text, ts: pkt.rx_time || Math.floor(Date.now() / 1000), time, direction: 'rx', ackStatus: null,
                  src: ev.device ? [ev.device] : [],
                });
                if (this.messages.length > 50) this.messages.pop();
                try { localStorage.setItem("msgHistory", JSON.stringify(this.messages.slice(0, 20))); } catch (_) {}
                if (this.tab !== 'messages') { this.unreadMessages++; this.playMsgSound(); }
              }
            }
          } catch (_) {}
        }
        if (pkt?.from != null) {
          this.lastHeardNum = pkt.from;
          if (this.tab === "radar") this.drawRadar();
        }
        if (this.tab === "nodes" && portnum === "TELEMETRY_APP") this.sortNodes(this.nodeSort.key, true);
        if (portnum === "RANGE_TEST_APP" && this.tab === "range") this.loadRangeTest();
      }
      if (ev.type === "mqtt_node" && ev.data) {
        const upd = ev.data;
        const idx = this.nodes.findIndex((n) => n.num === upd.num);
        if (idx >= 0) this.nodes[idx] = { ...this.nodes[idx], ...upd };
        else this.nodes.push(upd);
        if (this.tab === "radar" && this.homePos && upd.position?.latitude_i) this.refreshRadar();
      }
    },

    // -- Radio Config tab -------------------------------------------------------
    switchCfgTab(name) {
      this.cfgTab = name;
      localStorage.setItem("activeCfgTab", name);
      if (name === "radio") {
        if (this.radioTab === "device")   this.loadSections();
        else if (this.radioTab === "channels") this.loadChannels();
        else if (this.radioTab === "owner")    this.loadOwner();
      } else if (name === "bridge")  this.loadBridgeConfig();
      else if (name === "rotator") this.loadRotatorCfg();
    },

    resetRadioCfg() {
      this.allSections  = [];
      this.channels     = [];
      this.channelSchema = null;
      this.ownerSchema  = null;
      this.fixedPosition = { lat: null, lon: null, alt: null, loaded: false, saved: false, error: "" };
      if (this.radioTab === "device")   this.loadSections();
      else if (this.radioTab === "channels") this.loadChannels();
      else if (this.radioTab === "owner")    this.loadOwner();
    },

    async loadSections() {
      if (this.allSections.length) return;
      const sec = await fetchJSON("/sections");
      this.allSections = [
        ...sec.config.map((name) => ({ name, kind: "config", loaded: false, loading: false, saved: false, error: "" })),
        ...sec.module_config.map((name) => ({ name, kind: "module_config", loaded: false, loading: false, saved: false, error: "" })),
      ].sort((a, b) => a.name.localeCompare(b.name));
    },

    async onSectionToggle(sec) {
      if (sec.loaded || sec.loading) return;
      sec.loading = true;
      try {
        const [schema, values] = await Promise.all([
          fetchJSON(`/schema/${sec.name}`),
          fetchJSON(this.cd(`/config/${sec.name}`)),
        ]);
        sec.schema = schema;
        sec.data = values[sec.name] || values || {};
        await nextFrame();
        const el = document.getElementById("sec_" + sec.name);
        if (!el.dataset.dirty) {
          el.innerHTML = "";
          el.dataset.formRoot = "1";
          el.appendChild(buildForm(schema.fields, sec.data, []));
        }
        sec.loaded = true;
        if (sec.name === "position" && !this.fixedPosition.loaded) await this.loadFixedPosition();
      } catch (e) {
        sec.error = "Failed to load: " + e;
      } finally {
        sec.loading = false;
      }
    },

    async loadFixedPosition() {
      this.fixedPosition.error = "";
      try {
        const res = await fetchJSON(this.cd("/fixed_position"));
        const pos = res.position || {};
        this.fixedPosition.lat = pos.latitude_i != null ? pos.latitude_i / 1e7 : null;
        this.fixedPosition.lon = pos.longitude_i != null ? pos.longitude_i / 1e7 : null;
        this.fixedPosition.alt = pos.altitude ?? null;
        this.fixedPosition.loaded = true;
      } catch (e) {
        this.fixedPosition.error = "Failed to load: " + e;
      }
    },

    async saveFixedPosition() {
      this.fixedPosition.saved = false;
      this.fixedPosition.error = "";
      if (this.fixedPosition.lat == null || this.fixedPosition.lon == null) {
        this.fixedPosition.error = "Latitude and longitude are required";
        return;
      }
      const body = {
        latitude_i: Math.round(this.fixedPosition.lat * 1e7),
        longitude_i: Math.round(this.fixedPosition.lon * 1e7),
      };
      if (this.fixedPosition.alt != null && this.fixedPosition.alt !== "")
        body.altitude = Math.round(this.fixedPosition.alt);
      try {
        const res = await fetchJSON(this.cd("/fixed_position"), "PUT", body);
        if (res.error) throw new Error(res.error.message);
        this.fixedPosition.saved = true;
        setTimeout(() => (this.fixedPosition.saved = false), 2500);
      } catch (e) {
        this.fixedPosition.error = "Save failed: " + e;
      }
    },

    async clearFixedPosition() {
      this.fixedPosition.saved = false;
      this.fixedPosition.error = "";
      try {
        const res = await fetchJSON(this.cd("/fixed_position"), "DELETE");
        if (res.error) throw new Error(res.error.message);
        this.fixedPosition.lat = null;
        this.fixedPosition.lon = null;
        this.fixedPosition.alt = null;
        this.fixedPosition.saved = true;
        setTimeout(() => (this.fixedPosition.saved = false), 2500);
      } catch (e) {
        this.fixedPosition.error = "Clear failed: " + e;
      }
    },

    _drainReadbackQueue() {
      const queue = this._readbackQueue.splice(0);
      for (const fn of queue) fn();
    },

    async saveSection(sec) {
      this.ble_ready = false;
      sec.saved = false;
      sec.error = "";
      const el = document.getElementById("sec_" + sec.name);
      const payload = collectForm(el, sec.schema.fields);
      try {
        const res = await fetchJSON(this.cd(`/config/${sec.name}`), "PUT", payload);
        if (res.error) throw new Error(res.error.message);
        this._readbackQueue.push(async () => {
          try {
            const values = await fetchJSON(this.cd(`/config/${sec.name}`));
            sec.data = values[sec.name] || values || {};
            const formEl = document.getElementById("sec_" + sec.name);
            if (formEl && !formEl.dataset.dirty) {
              formEl.innerHTML = "";
              formEl.appendChild(buildForm(sec.schema.fields, sec.data, []));
            }
          } catch (_) {}
          sec.saved = true;
          setTimeout(() => (sec.saved = false), 2500);
        });
      } catch (e) {
        this.ble_ready = this.status.ble_state === 'active' && !!this.status.config_complete;
        sec.error = "Save failed: " + e;
      }
    },

    async loadChannels() {
      if (this.channels.length) return;
      this.channels = Array.from({ length: 8 }, (_, i) => ({
        index: i, loaded: false, loading: false, saved: false, error: "", data: {},
      }));
      try {
        const all = await fetchJSON(this.cd("/channels"));
        for (const ch of this.channels) {
          const c = all.channels?.[String(ch.index)];
          if (c) ch.data = c;
        }
      } catch (_) {}
    },

    async onChannelToggle(ch) {
      if (ch.loaded || ch.loading) return;
      ch.loading = true;
      try {
        if (!this.channelSchema) this.channelSchema = await fetchJSON("/schema/channel");
        const live = await fetchJSON(this.cd(`/channels/${ch.index}`));
        ch.data = live || {};
        const formData = { ...(live?.settings || {}), role: live?.role };
        await nextFrame();
        const el = document.getElementById("ch_" + ch.index);
        if (!el.dataset.dirty) {
          el.innerHTML = "";
          el.dataset.formRoot = "1";
          el.appendChild(buildForm(this.channelSchema.fields, formData, []));
        }
        ch.loaded = true;
      } catch (e) {
        ch.error = "Failed to load: " + e;
      } finally {
        ch.loading = false;
      }
    },

    async saveChannel(ch) {
      this.ble_ready = false;
      ch.saved = false;
      ch.error = "";
      const el = document.getElementById("ch_" + ch.index);
      const payload = collectForm(el, this.channelSchema.fields);
      const body = { settings: { ...payload }, role: payload.role };
      delete body.settings.role;
      try {
        const res = await fetchJSON(this.cd(`/channels/${ch.index}`), "PUT", body);
        if (res.error) throw new Error(res.error.message);
        this._readbackQueue.push(async () => {
          try {
            const live = await fetchJSON(this.cd(`/channels/${ch.index}`));
            ch.data = live || {};
            const formData = { ...(live?.settings || {}), role: live?.role };
            const formEl = document.getElementById("ch_" + ch.index);
            if (formEl && !formEl.dataset.dirty) {
              formEl.innerHTML = "";
              formEl.dataset.formRoot = "1";
              formEl.appendChild(buildForm(this.channelSchema.fields, formData, []));
            }
          } catch (_) {}
          ch.saved = true;
          setTimeout(() => (ch.saved = false), 2500);
        });
      } catch (e) {
        this.ble_ready = this.status.ble_state === 'active' && !!this.status.config_complete;
        ch.error = "Save failed: " + e;
      }
    },

    async loadOwner() {
      if (this.ownerSchema) return;
      this.ownerSchema = await fetchJSON("/schema/owner");
      this.ownerData = await fetchJSON(this.cd("/owner"));
      await nextFrame();
      const el = document.getElementById("owner_form");
      el.innerHTML = "";
      const editable = ["long_name", "short_name", "is_licensed"];
      const editFields = this.ownerSchema.fields.filter((f) => editable.includes(f.name));
      const readonlyFields = this.ownerSchema.fields.filter((f) => !editable.includes(f.name));
      el.appendChild(buildForm(editFields, this.ownerData, []));
      const ro = document.createElement("div");
      ro.className = "divider text-xs";
      ro.textContent = "read-only";
      el.appendChild(ro);
      el.appendChild(buildForm(readonlyFields, this.ownerData, [], { readonly: true }));
    },

    async saveOwner() {
      this.ownerSaved = false;
      this.ownerError = "";
      const el = document.getElementById("owner_form");
      const payload = collectForm(el, this.ownerSchema.fields.filter((f) =>
        ["long_name", "short_name", "is_licensed"].includes(f.name)));
      try {
        const res = await fetchJSON(this.cd("/owner"), "PUT", payload);
        if (res.error) throw new Error(res.error.message);
        this.ownerSaved = true;
        setTimeout(() => (this.ownerSaved = false), 2500);
      } catch (e) {
        this.ownerError = "Save failed: " + e;
      }
    },

    // -- Messages ---------------------------------------------------------------
    async sendMessage() {
      if (!this.msgText.trim()) return;
      this.msgSent = false;
      const text = this.msgText, channel = Number(this.msgChannel), time = new Date().toLocaleTimeString();
      const fromId = this.msgFrom || this.activeNodeId;
      const to = this.msgIsDirect && this.msgDirectTo ? Number(this.msgDirectTo) : 0xFFFFFFFF;
      const fromNum = parseInt((fromId || '').replace('!', ''), 16) || 0;
      const body = { text, channel };
      if (this.msgIsDirect && this.msgDirectTo) body.to = to;
      if (this.msgReplyId) body.reply_id = this.msgReplyId;

      // Add optimistic TX entry BEFORE the POST so the WS echo (which arrives
      // almost immediately) can be absorbed rather than creating a duplicate.
      const txEntry = {
        fromNum, to: to >>> 0,
        broadcast: to === 0xFFFFFFFF, channel, text,
        ts: Math.floor(Date.now() / 1000), time, direction: 'tx', ackStatus: 'sending',
        src: fromId ? [fromId] : [], replyId: this.msgReplyId || null,
        _localTx: true,
      };
      this.messages.unshift(txEntry);
      if (this.messages.length > 50) this.messages.pop();

      // Clear compose immediately
      this.msgInputHistory = [text, ...this.msgInputHistory.filter(t => t !== text)].slice(0, 50);
      try { localStorage.setItem('msgInputHistory', JSON.stringify(this.msgInputHistory)); } catch (_) {}
      this.msgHistoryIdx = -1;
      this.msgDraft = '';
      this.msgText = "";
      this.msgReplyId = null;
      this.msgReplyFrom = null;
      if (this.msgIsModal) this.closeMessageModal();

      try {
        await fetchJSON("/" + fromId + "/messages", "POST", body);
        txEntry.ackStatus = 'sent';
        this.msgSent = true;
        setTimeout(() => (this.msgSent = false), 2000);
      } catch (e) {
        // Remove the optimistic entry so the user can retry
        const idx = this.messages.indexOf(txEntry);
        if (idx !== -1) this.messages.splice(idx, 1);
      }
    },

    openMessageModal(mode, node) {
      this.msgIsDirect = mode === 'direct';
      this.msgDirectTo = mode === 'direct' ? (node?.num ?? '') : '';
      this.msgInsertNode = node?.num ?? null;
      this.msgText = '';
      this.msgSent = false;
      this.msgIsModal = true;
      this.$nextTick(() => this.$refs.msgModalDialog?.showModal());
    },

    closeMessageModal() {
      this.msgIsModal = false;
      this.$refs.msgModalDialog?.close();
    },

    replyTo(m) {
      const target = m.direction === 'tx' ? m.to : m.fromNum;
      this.msgInsertNode = target;
      if (target && (target >>> 0) !== 0xFFFFFFFF) {
        this.msgDirectTo = target;
        this.msgIsDirect = !m.broadcast;
      }
      this.msgReplyId = m.pktId || null;
      this.msgReplyFrom = m.fromNum || null;
    },

    insertText(val) {
      if (!val) return;
      const ta = this._composeTa;
      if (!ta) { this.msgText += val; return; }
      const s = ta.selectionStart, e = ta.selectionEnd;
      this.msgText = this.msgText.slice(0, s) + val + this.msgText.slice(e);
      this.$nextTick(() => { ta.selectionStart = ta.selectionEnd = s + val.length; ta.focus(); });
    },

    insertNodeMeta() {
      if (!this.msgInsertNode) return null;
      const node = this.nodes.find(n => n.num === this.msgInsertNode);
      const lat = node?.position?.latitude_i != null ? node.position.latitude_i / 1e7 : null;
      const lon = node?.position?.longitude_i != null ? node.position.longitude_i / 1e7 : null;
      const hp = this.homePos;
      const dist = (hp && lat != null) ? haversine(hp.lat, hp.lon, lat, lon).toFixed(1) : null;
      const az   = (hp && lat != null) ? Math.round(bearing(hp.lat, hp.lon, lat, lon)) : null;
      return { shortName: this.nodeShortName(this.msgInsertNode), longName: this.nodeLongName(this.msgInsertNode), dist, az };
    },

    navigateMsgHistory(e, dir) {
      const h = this.msgInputHistory;
      if (!h.length) return;
      const ta = e.target;
      if (dir < 0 && ta.selectionStart > 0) return;
      if (dir > 0 && ta.selectionEnd < ta.value.length) return;
      e.preventDefault();
      if (dir < 0) {
        if (this.msgHistoryIdx === -1) this.msgDraft = this.msgText;
        this.msgHistoryIdx = Math.min(this.msgHistoryIdx + 1, h.length - 1);
      } else {
        if (this.msgHistoryIdx < 0) return;
        this.msgHistoryIdx--;
        if (this.msgHistoryIdx < 0) { this.msgText = this.msgDraft; return; }
      }
      this.msgText = h[this.msgHistoryIdx];
    },

    mentionedNodes() {
      const q = this.mentionQuery.toLowerCase();
      return this.nodes
        .filter(n => n.user?.short_name && (
          n.user.short_name.toLowerCase().startsWith(q) ||
          (n.user.long_name || '').toLowerCase().startsWith(q)
        ))
        .slice(0, 8);
    },

    handleMsgInput(e) {
      this._composeTa = e.target;
      const ta = e.target;
      const before = ta.value.slice(0, ta.selectionStart);
      const m = before.match(/@(\w*)$/);
      if (m) {
        this.mentionQuery = m[1];
        this.mentionPos = before.lastIndexOf('@');
        this.mentionIdx = 0;
        this.mentionOpen = this.mentionedNodes().length > 0;
      } else {
        this.mentionOpen = false;
      }
    },

    handleMsgKeydown(e) {
      this._composeTa = e.target;
      if (this.mentionOpen) {
        const items = this.mentionedNodes();
        if (e.key === 'ArrowDown') { e.preventDefault(); this.mentionIdx = Math.min(this.mentionIdx + 1, items.length - 1); return; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); this.mentionIdx = Math.max(this.mentionIdx - 1, 0); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (items[this.mentionIdx]) this.selectMention(items[this.mentionIdx]); return; }
        if (e.key === 'Escape') { e.preventDefault(); this.mentionOpen = false; return; }
        return;
      }
      if (e.key === 'ArrowUp')   this.navigateMsgHistory(e, -1);
      if (e.key === 'ArrowDown') this.navigateMsgHistory(e, 1);
    },

    selectMention(node) {
      const sn = node.user?.short_name || ('!' + node.num.toString(16).slice(-4));
      const ta = this._composeTa;
      const cursorAfterAt = this.mentionPos + 1 + this.mentionQuery.length;
      this.msgText = this.msgText.slice(0, this.mentionPos) + '@' + sn + ' ' + this.msgText.slice(cursorAfterAt);
      this.mentionOpen = false;
      this.$nextTick(() => { if (ta) { ta.selectionStart = ta.selectionEnd = this.mentionPos + sn.length + 2; ta.focus(); } });
    },

    playMsgSound() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine'; o.frequency.value = 880;
        g.gain.setValueAtTime(0.25, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        o.start(ctx.currentTime); o.stop(ctx.currentTime + 0.35);
      } catch (_) {}
    },

    nodeShortName(num) {
      const n = this.nodes.find(n => n.num === num);
      return n?.user?.short_name || ('!' + (num & 0xFFFF).toString(16).toUpperCase());
    },
    nodeLongName(num) {
      const n = this.nodes.find(n => n.num === num);
      return n?.user?.long_name || n?.user?.short_name || ('!' + (num & 0xFFFF).toString(16).toUpperCase());
    },
    avatarColor(num) {
      const h = ((num >>> 0) * 2654435761 >>> 0) % 360;
      return `hsl(${h},55%,45%)`;
    },
    deviceLabel(nodeId) {
      if (!nodeId) return '';
      const cfg = this.deviceConfigs[nodeId];
      if (cfg?.label) return cfg.label;
      const d = this.availableDevices.find(d => d.node_id === nodeId);
      return d?.short_name || nodeId.replace('!', '').slice(-4).toUpperCase();
    },

    rotatorDeviceId() {
      const entry = Object.entries(this.deviceConfigs).find(([, c]) => c?.is_rotator);
      return entry ? entry[0] : null;
    },

    async pointAtNode(node) {
      if (node._az == null) return;
      await fetchJSON("/rotator/move", "POST", { az: node._az });
      this.yagiPointTarget = node.num;
      if (this.tab === "radar") this.drawRadar();
    },

    // -- Range test -----------------------------------------------------------
    async loadRangeTest() {
      if (!this.rangeRadioId && this.activeNodeId) this.rangeRadioId = this.activeNodeId;
      this.rangeLoading = true;
      try {
        const nodeIds = Object.keys(this.deviceConfigs);
        const [data, ...loraCfgs] = await Promise.all([
          fetchJSON('/range_test/log'),
          ...nodeIds.map(id =>
            fetchJSON(`/${id}/config`).then(r => ({ id, tx_power: r?.config?.lora?.tx_power ?? null })).catch(() => ({ id, tx_power: null }))
          ),
        ]);
        // Merge live tx_power into deviceConfigs (non-reactive, just for rangeEnrich lookup)
        for (const { id, tx_power } of loraCfgs) {
          if (tx_power != null && this.deviceConfigs[id]) {
            this.deviceConfigs[id] = { ...this.deviceConfigs[id], tx_power_dbm: tx_power };
          }
        }
        this.rangeLog = (data.log || []).slice().reverse();
      } catch (_) {
      } finally {
        this.rangeLoading = false;
      }
    },

    async clearRangeTest() {
      await fetchJSON('/range_test/log', "DELETE");
      this.rangeLog = [];
    },

    async loadRangeTimer() {
      try {
        const t = await fetchJSON('/range_test/timer');
        this.rangeTimer = t;
        this._startRangeCountdown();
      } catch (_) {}
    },

    _startRangeAutoSync() {
      if (this._rangeAutoSync) clearInterval(this._rangeAutoSync);
      this._rangeAutoSync = setInterval(async () => {
        if (this.tab !== 'range') { clearInterval(this._rangeAutoSync); this._rangeAutoSync = null; return; }
        await this.loadRangeTimer();
      }, 15000);
    },

    _startRangeCountdown() {
      if (this._rangeCountdown) clearInterval(this._rangeCountdown);
      if (!this.rangeTimer.active) { clearInterval(this._rangeAutoSync); this._rangeAutoSync = null; return; }
      this._rangeCountdown = setInterval(() => {
        if (!this.rangeTimer.endsAt) { clearInterval(this._rangeCountdown); return; }
        const rem = Math.max(0, Math.round((this.rangeTimer.endsAt - Date.now()) / 1000));
        this.rangeTimer = { ...this.rangeTimer, remaining: rem };
        if (rem === 0) {
          clearInterval(this._rangeCountdown);
          this.rangeTimer = { active: false, endsAt: null, nodeId: null, remaining: null };
        }
      }, 1000);
    },

    async startRangeTest() {
      const nodeId = this.rangeRadioId || this.activeNodeId;
      if (!nodeId) return;
      const t = await fetchJSON('/range_test/start', 'POST', { nodeId, durationMin: this.rangeDuration });
      this.rangeTimer = { active: true, endsAt: t.endsAt, nodeId, remaining: this.rangeDuration * 60 };
      this._startRangeCountdown();
      this._startRangeAutoSync();
      await fetchJSON(`/config/range_test.duration`, 'PUT', { value: this.rangeDuration });
    },

    async stopRangeTest() {
      if (this._rangeCountdown) clearInterval(this._rangeCountdown);
      this.rangeTimer = { active: false, endsAt: null, nodeId: null, remaining: null };
      await fetchJSON('/range_test/stop', 'POST', {});
    },

    rangeFmtCountdown(sec) {
      if (sec == null) return '';
      const m = Math.floor(sec / 60), s = sec % 60;
      return m + ':' + String(s).padStart(2, '0');
    },

    filteredRangeLog() {
      const id = this.rangeRadioId || this.activeNodeId;
      if (!id) return this.rangeLog;
      return this.rangeLog.filter(e => e.rx_device === id);
    },

    rangeEnrich(e) {
      const node = this.nodes.find(n => n.num === e.from_num);
      const lat = node?.position?.latitude_i != null ? node.position.latitude_i / 1e7 : null;
      const lon = node?.position?.longitude_i != null ? node.position.longitude_i / 1e7 : null;
      const distKm = (this.homePos && lat != null) ? haversine(this.homePos.lat, this.homePos.lon, lat, lon) : null;
      const az     = (this.homePos && lat != null) ? bearing(this.homePos.lat, this.homePos.lon, lat, lon) : null;
      let expectedRssi = null, excessLoss = null;
      if (distKm != null && distKm > 0) {
        const fspl = 20 * Math.log10(distKm) + 20 * Math.log10(868) + 32.4;
        const txNodeId = "!" + (e.from_num >>> 0).toString(16);
        const txCfg = this.deviceConfigs[txNodeId] || {};
        const txPow  = txCfg.tx_power_dbm ?? 22;
        const txEIRP = txPow + (txCfg.gain_dbi ?? 2) - (txCfg.cable_loss_db ?? 0);
        const rxCfg = this.deviceConfigs[e.rx_device] || {};
        const rxGain = (rxCfg.gain_dbi ?? 2) - (rxCfg.cable_loss_db ?? 0);
        expectedRssi = Math.round(txEIRP + rxGain - fspl);
        if (e.rssi != null) excessLoss = parseFloat((expectedRssi - e.rssi).toFixed(1));
      }
      return {
        ...e,
        nodeName: node?.user?.long_name || node?.user?.short_name || ("!" + (e.from_num ?? 0).toString(16).slice(-4)),
        distKm, az: az != null ? Math.round(az) : null, expectedRssi, excessLoss,
      };
    },

    rangeStats() {
      const enriched = this.filteredRangeLog().map(e => this.rangeEnrich(e)).filter(e => e.rssi != null);
      if (!enriched.length) return null;
      const rssis  = enriched.map(e => e.rssi).sort((a, b) => a - b);
      const losses = enriched.filter(e => e.excessLoss != null).map(e => e.excessLoss).sort((a, b) => a - b);
      const dists  = enriched.filter(e => e.distKm != null).map(e => e.distKm);
      const median = arr => arr[Math.floor(arr.length / 2)];
      return {
        count: enriched.length,
        medianRssi: median(rssis), bestRssi: rssis[rssis.length - 1], worstRssi: rssis[0],
        medianExcessLoss: losses.length ? parseFloat(median(losses).toFixed(1)) : null,
        maxDistKm: dists.length ? Math.max(...dists).toFixed(1) : null,
      };
    },

    // -- Signal bars ----------------------------------------------------------
    signalBarFill(n) {
      const snr = this.status.last_rx_snr;
      const bars = snr == null ? 1 : snr > 0 ? 4 : snr > -7 ? 3 : snr > -14 ? 2 : 1;
      if (n > bars) return "oklch(var(--bc)/0.12)";
      if (bars >= 3) return "oklch(var(--su))";
      if (bars >= 2) return "oklch(var(--wa))";
      return "oklch(var(--er))";
    },

    signalQuality(rssi, snr) {
      const hasRssi = rssi != null, hasSnr = snr != null;
      if (!hasRssi && !hasSnr) return { pct: 0, label: 'No signal', cls: 'text-base-content/30', badgeCls: 'badge-ghost', none: true };
      const snrScore  = hasSnr  ? Math.max(0, Math.min(1, (snr  + 20) / 30)) : null;
      const rssiScore = hasRssi ? Math.max(0, Math.min(1, (rssi + 120) / 70)) : null;
      const pct = Math.round(
        snrScore != null && rssiScore != null ? (snrScore * 0.6 + rssiScore * 0.4) * 100
        : (snrScore ?? rssiScore) * 100
      );
      const label    = pct >= 76 ? 'Excellent' : pct >= 51 ? 'Good' : pct >= 26 ? 'Fair' : 'Poor';
      const cls      = pct >= 76 ? 'text-success' : pct >= 51 ? 'text-success' : pct >= 26 ? 'text-warning' : 'text-error';
      const badgeCls = pct >= 76 ? 'badge-success' : pct >= 51 ? 'badge-success' : pct >= 26 ? 'badge-warning' : 'badge-error';
      return { pct, label, cls, badgeCls, none: false };
    },

    sigBars(rssi, snr, scale = 1) {
      const sq = this.signalQuality(rssi, snr);
      if (sq.none) return '';
      const parts = [3, 6, 9, 12].map((h, i) =>
        `<i style="height:${Math.round(h * scale)}px;opacity:${sq.pct > i * 25 ? 1 : 0.15}"></i>`
      ).join('');
      const tip = `${sq.label} (${sq.pct}%) · ${rssi != null ? rssi + ' dBm' : '–'} / ${snr != null ? snr + ' dB' : '–'}`;
      return `<span class="sig-bars ${sq.cls}" title="${tip}">${parts}</span>`;
    },

    sigBadge(rssi, snr) {
      const sq = this.signalQuality(rssi, snr);
      if (sq.none) return '<span class="badge badge-xs badge-ghost">no RF</span>';
      const b = (h, on) => `<i style="display:block;width:2px;border-radius:1px;background:currentColor;height:${h}px;opacity:${on?0.85:0.2}"></i>`;
      const tip = `${sq.label} (${sq.pct}%) · ${rssi != null ? rssi + ' dBm' : '–'} / ${snr != null ? snr + ' dB' : '–'}`;
      return `<span class="badge badge-xs ${sq.badgeCls} inline-flex items-end gap-px px-1" title="${tip}">${b(4,sq.pct>0)}${b(6,sq.pct>25)}${b(8,sq.pct>50)}${b(10,sq.pct>75)}</span>`;
    },

    // -- Radar ----------------------------------------------------------------
    async initRadar() {
      if (this._initRadarRunning) return;
      this._initRadarRunning = true;
      try {
        if (!this.homePos) return;
        this.refreshRadar();
        this.geocodeNodes();
        if (this.yagiAz != null) this._animateBeam(this.yagiAz);
      } finally {
        this._initRadarRunning = false;
      }
    },

    refreshRadar() {
      if (!this.homePos) return;
      this.radarNodes = this.filteredNodes()
        .filter((n) => n.position?.latitude_i && n.position?.longitude_i)
        .map((n) => {
          const lat = n.position.latitude_i / 1e7;
          const lon = n.position.longitude_i / 1e7;
          const existing = this.radarNodes.find((r) => r.num === n.num);
          return {
            ...n,
            _km: haversine(this.homePos.lat, this.homePos.lon, lat, lon),
            _az: bearing(this.homePos.lat, this.homePos.lon, lat, lon),
            _lat: lat, _lon: lon,
            _address: existing?._address,
          };
        });
      // Clear point target if it is not in the filtered node set (e.g. a bridge node)
      if (this.yagiPointTarget && !this.filteredNodes().some(n => n.num === this.yagiPointTarget))
        this.yagiPointTarget = null;
      this.drawRadar();
    },

    drawRadar() {
      if (!this.homePos) return;
      const maxKm = this.radarRange === "0"
        ? (this.radarNodes.length ? Math.max(...this.radarNodes.map((n) => n._km)) * 1.15 : 50)
        : Number(this.radarRange);
      this._drawRadarBg(maxKm);
      this._drawRadarBeam();
      this._drawRadarNodes(maxKm);
    },

    _radarNorm(km, maxKm) {
      if (!km || !maxKm) return 0;
      const f = this.radarLogScale
        ? Math.log1p(km) / Math.log1p(maxKm)
        : km / maxKm;
      return Math.min(f, 1.0);
    },

    _drawRadarBg(maxKm) {
      const bg = document.getElementById('radar-bg-g');
      if (!bg) return;
      const CX = 300, CY = 300, R = 256;
      const G0 = "rgba(0,255,80,0.06)", G1 = "rgba(0,255,80,0.45)", G2 = "rgba(0,255,80,0.40)";
      const G3 = "rgba(0,255,80,0.70)", G4 = "rgba(0,255,80,0.95)";
      bg.innerHTML = '';
      bg.appendChild(svgElem('circle', { cx: CX, cy: CY, r: R, style: 'fill:url(#radarBg)' }));
      const scanG = svgElem('g', { 'clip-path': 'url(#radarClip)', style: 'pointer-events:none' });
      for (let yy = CY - R; yy < CY + R; yy += 4)
        scanG.appendChild(svgElem('line', { x1: CX - R, y1: yy, x2: CX + R, y2: yy, style: 'stroke:rgba(0,0,0,0.10);stroke-width:1' }));
      bg.appendChild(scanG);
      const ringKms = this.radarLogScale
        ? (() => {
            const cands = [1, 2, 5, 10, 20, 50, 100, 150, 250, 500, 1000].filter(k => k < maxKm);
            return [...cands.slice(-3), maxKm];
          })()
        : [1, 2, 3, 4].map(i => maxKm * i / 4);
      ringKms.forEach((km, idx) => {
        const isFull = idx === ringKms.length - 1;
        const r = this._radarNorm(km, maxKm) * R;
        bg.appendChild(svgElem('circle', { cx: CX, cy: CY, r, style: `fill:none;stroke:${isFull ? G2 : G1};stroke-width:${isFull ? 1.2 : 0.9};stroke-dasharray:${isFull ? '' : '5 5'}` }));
        const lbl = svgElem('text', { x: CX + 5, y: CY - r + 12, style: `fill:${G3};font-size:10px;font-family:'Oxanium',monospace;letter-spacing:0.05em` });
        lbl.textContent = (km < 10 ? km.toFixed(km % 1 ? 1 : 0) : km) + ' km';
        bg.appendChild(lbl);
      });
      if (this.radarCrosshair) {
        bg.appendChild(svgElem('line', { x1: CX, y1: CY - R, x2: CX, y2: CY + R, style: `stroke:${G1};stroke-width:0.7;stroke-dasharray:2 8` }));
        bg.appendChild(svgElem('line', { x1: CX - R, y1: CY, x2: CX + R, y2: CY, style: `stroke:${G1};stroke-width:0.7;stroke-dasharray:2 8` }));
        const d45 = R * 0.707;
        bg.appendChild(svgElem('line', { x1: CX - d45, y1: CY - d45, x2: CX + d45, y2: CY + d45, style: `stroke:${G0};stroke-width:0.6;stroke-dasharray:2 10` }));
        bg.appendChild(svgElem('line', { x1: CX + d45, y1: CY - d45, x2: CX - d45, y2: CY + d45, style: `stroke:${G0};stroke-width:0.6;stroke-dasharray:2 10` }));
      }
      for (let deg = 0; deg < 360; deg += 10) {
        const isMajor = deg % 30 === 0, tickLen = isMajor ? 11 : 5;
        const rad = deg * Math.PI / 180;
        const ox = CX + Math.sin(rad) * R, oy = CY - Math.cos(rad) * R;
        const ix = CX + Math.sin(rad) * (R - tickLen), iy = CY - Math.cos(rad) * (R - tickLen);
        bg.appendChild(svgElem('line', { x1: ox, y1: oy, x2: ix, y2: iy, style: `stroke:rgba(0,255,80,${isMajor ? 0.70 : 0.38});stroke-width:${isMajor ? 1.2 : 0.8}` }));
      }
      bg.appendChild(svgElem('circle', { cx: CX, cy: CY, r: R, style: `fill:none;stroke:${G2};stroke-width:1.5;filter:url(#rimGlow)` }));
      bg.appendChild(svgElem('circle', { cx: CX, cy: CY, r: R + 6, style: 'fill:none;stroke:rgba(0,255,80,0.10);stroke-width:3' }));
      bg.appendChild(svgElem('circle', { cx: CX, cy: CY, r: R + 10, style: 'fill:none;stroke:rgba(0,255,80,0.04);stroke-width:2' }));
      for (const [label, dx, dy] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]]) {
        const t = svgElem('text', { x: CX + dx * (R + 22), y: CY + dy * (R + 22) + 5, style: `fill:${G4};font-size:13px;font-weight:700;font-family:'Oxanium',monospace;text-anchor:middle;letter-spacing:0.1em` });
        t.textContent = label;
        bg.appendChild(t);
      }
    },

    _drawRadarBeam() {
      const beamG = document.getElementById('radar-beam-g');
      if (!beamG || this.yagiAz == null) return;
      const CX = 300, CY = 300, R = 256;
      const rotId = this.rotatorDeviceId();
      const bw = Math.max(1, Math.min(rotId ? (this.deviceConfigs[rotId]?.beam_deg ?? 5) : 5, 180));
      const HW = (bw / 2) * Math.PI / 180;
      const wx1 = CX + Math.sin(-HW) * R, wy1 = CY - Math.cos(-HW) * R;
      const wx2 = CX + Math.sin(HW) * R,  wy2 = CY - Math.cos(HW) * R;
      const az = Math.round(this._radarBeamAz ?? this.yagiAz);
      beamG.innerHTML = `<path d="M ${CX} ${CY} L ${wx1.toFixed(1)} ${wy1.toFixed(1)} A ${R} ${R} 0 0 1 ${wx2.toFixed(1)} ${wy2.toFixed(1)} Z" style="fill:rgba(80,200,255,0.14);stroke:none;clip-path:url(#radarClip)"/><line x1="${CX}" y1="${CY}" x2="${CX}" y2="${CY - R}" style="stroke:rgba(80,200,255,0.85);stroke-width:2;opacity:0.9"/><text x="${CX}" y="${CY - R - 15}" style="fill:rgba(255,50,50,0.95);font-size:11px;font-weight:700;font-family:'Oxanium',monospace;text-anchor:middle;dominant-baseline:middle;pointer-events:none">${az}°</text>`;
    },

    _drawRadarNodes(maxKm) {
      const ng = document.getElementById('radar-nodes-g');
      if (!ng) return;
      ng.innerHTML = '';
      const nodes = this.radarNodes;
      const CX = 300, CY = 300, R = 256;
      const G4 = 'rgba(0,255,80,0.95)', AMBER = 'rgba(255,200,40,0.90)';
      const CLUSTER_R = 22, BASE_DIAG = 12, STEP_DIAG = 14, HOR_LEN = 16;
      const selectedNum = this.radarSelected?.num;
      const lastHeardNum = this.lastHeardNum;
      const pointTarget = this.yagiPointTarget;

      const npos = nodes.map(node => {
        const az = node._az * Math.PI / 180;
        const normKm = this._radarNorm(node._km, maxKm);
        return { x: CX + Math.sin(az) * normKm * R, y: CY - Math.cos(az) * normKm * R, diagLen: BASE_DIAG, isRight: null };
      });
      const clusterOf = new Array(npos.length).fill(-1);
      for (let i = 0; i < npos.length; i++) {
        if (clusterOf[i] >= 0) continue;
        const members = [i]; clusterOf[i] = i;
        for (let j = i + 1; j < npos.length; j++) {
          if (clusterOf[j] >= 0) continue;
          const dx = npos[i].x - npos[j].x, dy = npos[i].y - npos[j].y;
          if (dx * dx + dy * dy < CLUSTER_R * CLUSTER_R) { members.push(j); clusterOf[j] = i; }
        }
        if (members.length > 1) members.forEach((idx, rank) => { npos[idx].diagLen = BASE_DIAG + rank * STEP_DIAG; npos[idx].isRight = rank % 2 === 0; });
      }

      nodes.forEach((node, ni) => {
        const { x, y, diagLen } = npos[ni];
        const isRight = npos[ni].isRight !== null ? npos[ni].isRight : x >= CX;
        const dotColor = ageColor(node.last_heard, this.heatmapMaxAge);
        const isSelected = node.num === selectedNum;
        const isLastHeard = node.num === lastHeardNum;
        const g = svgElem('g', { class: 'radar-node' + (isSelected ? ' radar-node-selected' : ''), style: 'cursor:pointer' });
        if (isLastHeard) {
          const rs = `stroke:${AMBER};stroke-width:1.2`;
          g.appendChild(svgElem('circle', { cx: x, cy: y, r: 13, style: `fill:none;${rs};stroke-dasharray:3 4` }));
          g.appendChild(svgElem('line', { x1: x-17, y1: y, x2: x-7, y2: y, style: rs }));
          g.appendChild(svgElem('line', { x1: x+7,  y1: y, x2: x+17, y2: y, style: rs }));
          g.appendChild(svgElem('line', { x1: x, y1: y-17, x2: x, y2: y-7,  style: rs }));
          g.appendChild(svgElem('line', { x1: x, y1: y+7,  x2: x, y2: y+17, style: rs }));
        }
        if (node.num === pointTarget) {
          const rs = 'stroke:rgba(255,30,30,0.95);stroke-width:1.8';
          g.appendChild(svgElem('circle', { cx: x, cy: y, r: 16, style: `fill:none;${rs};stroke-dasharray:4 3` }));
          g.appendChild(svgElem('line', { x1: x-22, y1: y, x2: x-10, y2: y, style: rs }));
          g.appendChild(svgElem('line', { x1: x+10, y1: y, x2: x+22, y2: y, style: rs }));
          g.appendChild(svgElem('line', { x1: x, y1: y-22, x2: x, y2: y-10, style: rs }));
          g.appendChild(svgElem('line', { x1: x, y1: y+10, x2: x, y2: y+22, style: rs }));
        }
        if (isSelected)
          g.appendChild(svgElem('circle', { cx: x, cy: y, r: 12, style: `fill:none;stroke:${G4};stroke-width:1.5;stroke-dasharray:4 3` }));
        g.appendChild(svgElem('circle', { cx: x, cy: y, r: isSelected ? 5 : 4, style: `fill:${dotColor};filter:url(#blipGlow)` }));
        const title = svgElem('title');
        title.textContent = node.user?.long_name || node.user?.id || ('!' + (node.num ?? 0).toString(16).slice(-4));
        g.appendChild(title);
        const label = node.user?.short_name || ('!' + (node.num ?? 0).toString(16).slice(-4));
        const diagSign = isRight ? 1 : -1;
        const elbowX = x + diagSign * diagLen, elbowY = y - diagLen;
        const capX = elbowX + diagSign * HOR_LEN;
        g.appendChild(svgElem('line', { x1: x + diagSign * 5, y1: y - 4, x2: elbowX, y2: elbowY, style: `stroke:${dotColor};stroke-width:0.8;opacity:0.7;pointer-events:none` }));
        g.appendChild(svgElem('line', { x1: elbowX, y1: elbowY, x2: capX, y2: elbowY, style: `stroke:${dotColor};stroke-width:0.8;opacity:0.7;pointer-events:none` }));
        const txt = svgElem('text', { class: 'radar-node-label', x: capX + diagSign * 3, y: elbowY + 4, style: `fill:${dotColor};font-size:10px;font-family:'Oxanium',monospace;pointer-events:none;text-anchor:${isRight ? 'start' : 'end'}` });
        txt.textContent = label;
        g.appendChild(txt);
        g.addEventListener('click', (e) => { e.stopPropagation(); this.radarSelected = node; this.openNodeInfo(node); });
        ng.appendChild(g);
      });

      const hSize = 7;
      ng.appendChild(svgElem('polygon', { points: `${CX},${CY-hSize} ${CX+hSize},${CY} ${CX},${CY+hSize} ${CX-hSize},${CY}`, style: `fill:${G4};filter:url(#blipGlow)` }));
      ng.appendChild(svgElem('line', { x1: CX-16, y1: CY, x2: CX-hSize-1, y2: CY, style: `stroke:${G4};stroke-width:1.2` }));
      ng.appendChild(svgElem('line', { x1: CX+hSize+1, y1: CY, x2: CX+16, y2: CY, style: `stroke:${G4};stroke-width:1.2` }));
      ng.appendChild(svgElem('line', { x1: CX, y1: CY-16, x2: CX, y2: CY-hSize-1, style: `stroke:${G4};stroke-width:1.2` }));
      ng.appendChild(svgElem('line', { x1: CX, y1: CY+hSize+1, x2: CX, y2: CY+16, style: `stroke:${G4};stroke-width:1.2` }));
    },

    openNodeInfo(node) {
      const radarNode = this.radarNodes.find((r) => r.num === node.num);
      const lat = node.position?.latitude_i  != null ? node.position.latitude_i  / 1e7 : null;
      const lon = node.position?.longitude_i != null ? node.position.longitude_i / 1e7 : null;
      this.nodeInfo = radarNode || { ...node, _km: this.nodeKm(node), _az: this.nodeAz(node), _lat: lat, _lon: lon };
      this.$nextTick(() => this.$refs.nodeInfoDialog?.showModal());
      if (!this.nodeInfo._address && this.nodeInfo._lat != null && this.nodeInfo._lon != null) {
        geocodeLatLon(this.nodeInfo._lat, this.nodeInfo._lon).then((addr) => {
          if (this.nodeInfo?.num === node.num) this.nodeInfo = { ...this.nodeInfo, _address: addr };
        });
      }
    },

    toggleRadarCrosshair() {
      this.radarCrosshair = !this.radarCrosshair;
      this.saveRadarPref('crosshair', this.radarCrosshair);
      this.drawRadar();
    },

    async geocodeNodes() {
      this.geocoding = true;
      for (const node of [...this.radarNodes]) {
        if (node._address || !node._lat || !node._lon) continue;
        const addr = await geocodeLatLon(node._lat, node._lon);
        node._address = addr;
        const idx = this.radarNodes.findIndex((r) => r.num === node.num);
        if (idx >= 0) this.radarNodes[idx] = { ...this.radarNodes[idx], _address: addr };
        if (this.radarSelected?.num === node.num)
          this.radarSelected = { ...this.radarSelected, _address: addr };
      }
      this.geocoding = false;
    },

    // -- formatting helpers ---------------------------------------------------
    fmtUptime(secs) {
      if (secs == null) return "–";
      const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
      if (d > 0) return `${d}d ${h}h`;
      if (h > 0) return `${h}h ${m}m`;
      return `${m}m`;
    },
    fmtBytes(b) {
      if (b == null) return "–";
      if (b > 1024) return (b / 1024).toFixed(1) + " KB";
      return b + " B";
    },
    dewPoint(tempC, rh) {
      if (tempC == null || rh == null || rh <= 0) return null;
      const a = 17.27, b = 237.7;
      const alpha = (a * tempC) / (b + tempC) + Math.log(rh / 100);
      return (b * alpha) / (a - alpha);
    },
    fmtAge(ts) {
      if (!ts) return "–";
      const secs = Math.floor(Date.now() / 1000) - ts;
      if (secs < 60) return secs + "s ago";
      if (secs < 3600) return Math.floor(secs / 60) + "m ago";
      if (secs < 86400) return Math.floor(secs / 3600) + "h ago";
      return Math.floor(secs / 86400) + "d ago";
    },
    badgeForType(type) {
      switch (type) {
        case "packet": return "badge-primary";
        case "node_info": return "badge-secondary";
        case "config_complete_id": return "badge-success";
        case "mqttClientProxyMessage": return "badge-accent";
        default: return "badge-ghost";
      }
    },
  };
}

// ============================================================================
// Dynamic form building / collection from /schema/* responses
// ============================================================================

function buildForm(fields, data, path, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "grid grid-cols-1 sm:grid-cols-2 gap-3";
  for (const field of fields)
    wrap.appendChild(buildField(field, data?.[field.name], path.concat(field.name), opts));
  return wrap;
}

function _formRoot(el) {
  return el.closest('[data-form-root]');
}

function buildField(field, value, path, opts = {}) {
  const fieldPath = path.join(".");
  if (field.type === "object") {
    const box = document.createElement("div");
    box.className = "col-span-1 sm:col-span-2 border border-base-300 rounded-lg p-3";
    const title = document.createElement("div");
    title.className = "text-xs font-semibold uppercase text-base-content/50 mb-2";
    title.textContent = field.name.replace(/_/g, " ");
    box.appendChild(title);
    box.appendChild(buildForm(field.fields, value || {}, path, opts));
    return box;
  }
  const ctl = document.createElement("label");
  ctl.className = "form-control w-full";
  const labelRow = document.createElement("div");
  labelRow.className = "label py-1";
  const labelText = document.createElement("span");
  labelText.className = "label-text text-xs";
  labelText.textContent = (field.label ?? field.name.replace(/_/g, " ")) + (field.repeated ? " (comma separated)" : "");
  labelRow.appendChild(labelText);
  if (field.unit) {
    const unitSpan = document.createElement("span");
    unitSpan.className = "label-text-alt text-xs opacity-50";
    unitSpan.textContent = field.unit;
    labelRow.appendChild(unitSpan);
  }
  ctl.appendChild(labelRow);

  const sensitive = SENSITIVE_FIELDS.has(field.name);
  let input;

  if (field.type === "bool" && !field.repeated) {
    input = document.createElement("input");
    input.type = "checkbox";
    input.className = "toggle toggle-primary toggle-sm";
    input.checked = !!value;
    input.dataset.field = fieldPath;
    input.dataset.type = field.type;
    ctl.style.flexDirection = "row";
    ctl.style.alignItems = "center";
    ctl.style.justifyContent = "space-between";
  } else if (field.type === "enum" && !field.repeated) {
    input = document.createElement("select");
    input.className = "select select-bordered select-sm w-full";
    for (const opt of field.options) {
      const o = document.createElement("option");
      o.value = opt; o.textContent = opt;
      if (opt === value) o.selected = true;
      input.appendChild(o);
    }
    input.dataset.field = fieldPath;
    input.dataset.type = field.type;
  } else {
    input = document.createElement("input");
    input.className = "input input-bordered input-sm w-full font-mono";
    input.dataset.field = fieldPath;
    input.dataset.type = field.type;
    input.dataset.repeated = field.repeated ? "1" : "";
    if (field.repeated) {
      input.type = "text";
      input.value = Array.isArray(value) ? value.join(", ") : "";
    } else if (field.type === "int") {
      input.type = "number"; input.step = "1"; input.value = value ?? 0;
      if (field.min !== undefined) input.min = field.min;
    } else if (field.type === "float") {
      input.type = "number"; input.step = "any"; input.value = value ?? 0;
      if (field.min !== undefined) input.min = field.min;
    } else {
      input.type = (sensitive && field.type !== "bytes") ? "password" : "text";
      input.value = value ?? "";
      if (sensitive && field.type !== "bytes" && !value) {
        input.placeholder = "not set";
      }
    }
    if (sensitive && !opts.readonly) {
      input.disabled = true;
      const unlock = document.createElement("label");
      unlock.className = "label cursor-pointer gap-1 py-0";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.className = "checkbox checkbox-xs";
      cb.addEventListener("change", () => {
        input.disabled = !cb.checked;
        input.type = cb.checked ? "text" : "password";
        if (!cb.checked && !input.value) input.placeholder = "not set";
      });
      const lbl = document.createElement("span");
      lbl.className = "label-text text-xs text-warning";
      lbl.textContent = "unlock to edit";
      unlock.appendChild(cb); unlock.appendChild(lbl);
      labelRow.appendChild(unlock);
    }
  }
  if (opts.readonly) {
    input.disabled = true;
    if (input.tagName === "SELECT") input.classList.add("opacity-60");
  }

  input.addEventListener("focus",  () => { ctl.classList.add("field-focused"); });
  input.addEventListener("blur",   () => { ctl.classList.remove("field-focused"); });
  input.addEventListener("input",  () => { _formRoot(input)?.setAttribute("data-dirty", "1"); });
  input.addEventListener("change", () => { _formRoot(input)?.setAttribute("data-dirty", "1"); });

  ctl.appendChild(input);
  if (field.hint) {
    const hintRow = document.createElement("div");
    hintRow.className = "label py-0";
    const hintSpan = document.createElement("span");
    hintSpan.className = "label-text-alt text-xs opacity-50";
    hintSpan.textContent = field.hint;
    hintRow.appendChild(hintSpan);
    ctl.appendChild(hintRow);
  }
  return ctl;
}

function collectForm(container, fields) { return collectFromInputs(container, fields, []); }

function collectFromInputs(container, fields, path) {
  const out = {};
  for (const field of fields) {
    const p = path.concat(field.name);
    if (field.type === "object") { out[field.name] = collectFromInputs(container, field.fields, p); continue; }
    const input = container.querySelector(`[data-field="${p.join(".")}"]`);
    if (!input || input.disabled) continue;
    out[field.name] = readFieldValue(input, field);
  }
  return out;
}

function readFieldValue(input, field) {
  if (field.type === "bool" && !field.repeated) return input.checked;
  if (field.repeated) {
    const raw = input.value.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (field.type === "int" || field.type === "float") return raw.map(Number);
    return raw;
  }
  if (field.type === "int")   return parseInt(input.value, 10) || 0;
  if (field.type === "float") return parseFloat(input.value) || 0;
  return input.value;
}

// ============================================================================
// misc helpers
// ============================================================================

async function fetchJSON(url, method = "GET", body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  return res.json();
}

function b64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

function nextFrame() { return new Promise((resolve) => requestAnimationFrame(resolve)); }

// ============================================================================
// Radar helpers
// ============================================================================

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
    Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos((lon2 - lon1) * Math.PI / 180);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function rssiPercent(rssi) {
  if (rssi == null) return null;
  return Math.max(0, Math.min(100, Math.round((rssi + 120) / 70 * 100)));
}

function ageColor(lastHeard, maxAge = 3600) {
  if (!lastHeard) return "rgba(255,255,255,0.25)";
  const ageSec = Math.max(0, Date.now() / 1000 - lastHeard);
  const t = Math.min(ageSec / maxAge, 1);
  const hue = 55 - t * 55;
  const lit  = 82 - t * 32;
  return `hsl(${hue}, 92%, ${lit}%)`;
}

function svgElem(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  return el;
}

// ============================================================================
// Nominatim geocoding — sequential queue with 1.1s inter-request delay
// ============================================================================

const _geocodeCache = new Map();
let _geocodeQueue = Promise.resolve();

function geocodeLatLon(lat, lon) {
  const key = lat.toFixed(4) + "," + lon.toFixed(4);
  if (_geocodeCache.has(key)) return Promise.resolve(_geocodeCache.get(key));
  const p = _geocodeQueue.then(
    () => new Promise((resolve) => {
      setTimeout(async () => {
        try {
          const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=18`;
          const res = await fetch(url, { headers: { "Accept-Language": "en" } });
          const data = await res.json();
          const a = data.address || {};
          const street   = [a.house_number, a.road].filter(Boolean).join(" ");
          const locality = a.city || a.town || a.village || a.suburb || a.county || "";
          const postcode = a.postcode || "";
          const parts    = [street, locality, postcode].filter(Boolean);
          const addr = parts.join(", ") || (data.display_name || "").split(",").slice(0, 3).join(", ") || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
          _geocodeCache.set(key, addr);
          resolve(addr);
        } catch (_) {
          const fallback = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
          _geocodeCache.set(key, fallback);
          resolve(fallback);
        }
      }, 1100);
    })
  );
  _geocodeQueue = p;
  return p;
}

function summarizeEvent(ev) {
  switch (ev.type) {
    case "packet": {
      const pkt = ev.data?.packet;
      const portnum = pkt?.decoded?.portnum || "?";
      return `from !${(pkt?.from ?? 0).toString(16)} -> ${portnum}`;
    }
    case "node_info": {
      const u = ev.data?.node_info?.user;
      return u ? `${u.long_name} (${u.id})` : "node update";
    }
    case "config_complete_id": return "NodeDB sync complete";
    case "mqttClientProxyMessage": return ev.data?.mqttClientProxyMessage?.topic || "";
    default: return "";
  }
}
