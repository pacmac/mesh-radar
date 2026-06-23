// mesh-gw dashboard — Alpine compose entry point.
// State and init() only. All logic lives in the app-*.js mixin modules.
import { uiMixin }        from './app-ui.js';
import { navMixin, initTab } from './app-nav.js';
import { wsMixin }        from './app-ws.js';
import { devicesMixin }   from './app-devices.js';
import { nodesMixin }     from './app-nodes.js';
import { rotatorMixin }   from './app-rotator.js';
import { radarMixin }     from './app-radar.js';
import { messagesMixin }  from './app-messages.js';
import { rangeMixin }     from './app-range.js';
import { telemetryMixin } from './app-telemetry.js';
import { configMixin }      from './app-config.js';
import { componentsMixin }  from './app-components.js';
import { fetchJSON, themeColor, svgElem } from './app-helpers.js';
import { initPersist, persistGet, persistSet } from './app-persist.js';

// Helpers used directly in Alpine template expressions or component functions must be window globals.
window.fetchJSON  = fetchJSON;
window.themeColor = themeColor;
window.svgElem    = svgElem;
window.persistSet = persistSet;

function dashboard() {
  return {
    // -- Navigation -----------------------------------------------------------
    tab:           initTab(),
    cfgTab:        persistGet('cfgTab', 'radio'),
    drawerOpen:    false,
    sidebarPinned: persistGet('sidebarPinned', true),

    // -- Device selection -----------------------------------------------------
    activeNodeId:  persistGet('activeNodeId', ''),
    cfgRadioId:    '',
    radioTab:      'device',
    availableDevices: [],
    deviceBleStates:  {},
    deviceConfigs:    {},
    deviceNodes:      {},
    autoPurge:        {},
    _readbackQueues:  {},

    // -- Info -----------------------------------------------------------------
    info:          { my_info: {}, metadata: {} },
    nodeSelf:      {},
    mqttProxy:     false,
    mqttCfg:       {},
    loraCfg:       {},
    packetSources: [],

    // -- Nodes ----------------------------------------------------------------
    nodes:       [],
    nodeTotal:   0,
    nodeCount:   0,
    nodeSort:    { key: 'last_heard', dir: -1 },
    nodeSource:  'both',
    nodeFilters: {
      maxHops: 99, namedOnly: false, hasPos: false, hasSignal: false,
      hasTelem: false, msgOnly: false, maxAge: 0, hideMqtt: false, nodeRoles: [],
    },

    // -- Connectivity ---------------------------------------------------------
    wsConnected:    false,
    serverReachable: true,
    bridgeConnected: true,
    events:          [],

    // -- Rotator / Yagi -------------------------------------------------------
    yagiAz:          null,
    yagiConnected:   false,
    yagiPointTarget: null,
    yagiTargetMeta:  {},
    yagiSignal:      { num: null, rssi: null, snr: null, ts: null },
    _sigTick:        0,
    rotatorStatus:   {},
    rotatorConnected: false,
    rotatorManualAz:  null,
    rotatorMode:      0,
    pwmRunPctInput:   null,
    pwmFreqInput:     null,

    // -- OTA ------------------------------------------------------------------
    otaActive:    false,
    otaDone:      false,
    otaPct:       0,
    otaBleAddr:   null,
    otaProtocol:  null,
    otaError:     null,
    deviceOtaState: {},
    _otaSeq:      0,

    // -- Scan -----------------------------------------------------------------
    scanMode:      false,
    scanStep:      5,
    scanDwell:     60,
    actvDwell:     90,
    scanData:      {},
    scanProgress:  null,
    scanCurrentAz: null,

    // -- Radar ----------------------------------------------------------------
    radarRange:     '50',
    radarLogScale:  false,
    radarNodes:     [],
    radarSelected:  null,
    homePos:        null,
    geocoding:      false,
    radarCrosshair: true,
    heatmapMaxAge:  3600,
    nodeInfo:       null,
    tracerouteResult:  null,
    traceroutePending: false,
    lastHeardNum:   null,

    // -- Messages -------------------------------------------------------------
    msgFrom:    persistGet('msgFrom', ''),
    msgIsDirect: false,
    msgDirectTo: '',
    msgReplyId:  null,
    msgReplyFrom: null,
    msgInsertNode: null,
    msgNodeCache:  {},
    _knownNodes:   [],
    msgEmojiSet: [
      {e:'👍',t:'Thumbs up'},{e:'👋',t:'Hello / goodbye'},{e:'🙂',t:'Smile'},
      {e:'✅',t:'Yes / confirmed'},{e:'❌',t:'No / cancel'},{e:'❓',t:'Question'},
      {e:'😎',t:'Cool'},{e:'🤔',t:'Thinking'},{e:'🌞',t:'Good morning'},
      {e:'🍻',t:'Cheers'},{e:'📻',t:'Radio'},{e:'73',t:'73 — best regards (ham)'},
    ],
    msgInputHistory: persistGet('msgInputHistory', []),
    msgHistoryIdx: -1,
    msgDraft: '',
    mentionOpen: false,
    mentionQuery: '',
    mentionPos: 0,
    mentionIdx: 0,
    unreadMessages: 0,
    _seenPacketIds: new Set(),
    msgChannel: '0',
    msgText: '',
    msgSent: false,
    messages: [],
    msgIsModal: false,
    _composeTa: null,

    // -- UI state -------------------------------------------------------------
    toasts: [],
    ops:    {},

    // -- BLE setup ------------------------------------------------------------
    bleDevices:   [],
    bleScanning:  false,
    bleConnecting: false,
    bleAddress:   '',
    blePin:       '',
    bleError:     '',

    // -- Telemetry / tilt / env -----------------------------------------------
    envHistory:  {},
    envWindow:   persistGet('envWindow', 24),
    tiltHistory: [],
    tiltWindow:  persistGet('tiltWindow', 4),
    tiltPeak:    0,
    tiltRings:   [1, 2, 3, 4],
    tiltZero:       persistGet('tiltZero', null),
    tiltNorthAngle: persistGet('tiltNorthAngle', null),

    // -- Alerts ---------------------------------------------------------------
    alertRules:       [],
    alertSmtp:        {},
    alertTestSending: false,
    alertTestResult:  '',
    alertTestOk:      false,

    // -- Config tab -----------------------------------------------------------
    allSections: [],
    channels:    [],
    channelSchema: null,
    ownerSchema:   null,
    ownerData:     {},
    ownerSaved:    false,
    ownerError:    '',
    fixedPosition: { lat: null, lon: null, alt: null, loaded: false, saved: false, error: '' },
    bridgeConfigSchema: null,
    bridgeConfigSaved:  false,
    bridgeConfigError:  '',
    rotatorCfgSchema: null,
    rotatorCfgSaved:  false,
    rotatorCfgError:  '',
    rotatorCalSent:   false,
    rotatorCalError:  '',
    rotatorOffsetInput: '',
    antennaSaved: false,
    antennaError: '',
    homePosSaved: false,
    homePosError: '',

    // -- Live feed ------------------------------------------------------------
    feedVisible: [],   // populated in init() from feedFilterOptions; DOM persist manages it

    // -- Range test -----------------------------------------------------------
    rangeLog:     [],
    rangeLoading: false,
    rangeRxFilter:  '',
    rangeDuration:  10,
    rangeNodeFilter: '',
    _rangeStats:     null,
    _rangeChartCache: null,
    rangeTimer: { active: false, endsAt: null, nodeId: null, remaining: null },
    _rangeCountdown: null,
    _rangeAutoSync:  null,

    // -- Init -----------------------------------------------------------------
    async init() {
      initPersist();
      this.feedVisible = (window.feedFilterOptions || []).map(o => o.id);

      try {
        const saved = JSON.parse(localStorage.getItem('msgHistory') || '[]');
        if (Array.isArray(saved) && saved.length) {
          this.messages = saved;
          saved.forEach(m => { if (m.pktId) this._seenPacketIds.add(m.pktId); });
        }
      } catch (_) {}

      await this.loadConfig();
      await this.loadDeviceConfigs();
      await this.loadBridgeConfig();

      if (this.activeNodeId) await this.bootstrapDevice();

      await this.loadMessages();

      this.connectWS();

      window.addEventListener('popstate', e => {
        const pathToTab = {
          '/overview': 'overview', '/radar': 'radar', '/nodes': 'nodes',
          '/config': 'cfg', '/range': 'range', '/messages': 'messages', '/devices': 'devices',
        };
        const t = e.state?.tab ?? pathToTab[window.location.pathname] ?? 'overview';
        this.setNav(t);
      });

      this.$watch('activeNodeId', () => { this.loadTiltHistory(); this.loadEnvHistory(this.activeNodeId); });
      this.$watch('tiltWindow',        () => this.loadTiltHistory());
      this.$watch('envWindow',         () => this.loadEnvHistory(this.activeNodeId));
      this.$watch('rangeNodeFilter',   () => { this._rangeStats = null; this._rangeChartCache = null; });
      this.$watch('rangeRxFilter',     () => { this._rangeStats = null; this._rangeChartCache = null; this.rangeNodeFilter = ''; });
      this.$watch('tiltPeak', peak => {
        const stops = [0.25, 0.5, 1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90];
        const maxRing = stops.find(v => v >= Math.max(peak * 1.25, 0.5)) ?? 90;
        const q = maxRing / 4;
        this.tiltRings = [q, q*2, q*3, maxRing].map(v => +v.toFixed(2));
      });

      this.loadTiltHistory();
      this.loadEnvHistory(this.activeNodeId);
      setInterval(() => { if (this.yagiSignal.ts) this._sigTick++; }, 1000);

      if (this.tab === 'radar') this.$nextTick(() => this.initRadar());
      else if (this.tab === 'cfg') this.switchCfgTab(this.cfgTab);
      else if (this.tab === 'range') { this.loadRangeTest(); this.loadRangeTimer(); this._startRangeAutoSync(); }
    },
  };
}

// Expose as a global so x-data="dashboard()" in index.html continues to work.
// Use defineProperties to merge mixins so getters are transferred without being invoked.
window.dashboard = function() {
  const state = dashboard();
  const mixins = [
    uiMixin, navMixin, wsMixin, devicesMixin, nodesMixin,
    rotatorMixin, radarMixin, messagesMixin, rangeMixin, telemetryMixin, configMixin,
    componentsMixin,
  ];
  for (const mixin of mixins) {
    Object.defineProperties(state, Object.getOwnPropertyDescriptors(mixin));
  }
  return state;
};
