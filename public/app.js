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
import { perfMixin }      from './app-perf.js?v=20260627rewrite';
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
    // 'radio' shim: the Radio config tab moved to the Devices page
    // (radio-config-into-devices) — a persisted 'radio' would strand the
    // user on a tab that no longer exists.
    cfgTab:        (t => t === 'radio' ? 'bridge' : t)(persistGet('cfgTab', 'bridge')),
    drawerOpen:    false,
    sidebarPinned: persistGet('sidebarPinned', true),

    // -- Device selection -----------------------------------------------------
    // SSOT is the radio's BLE MAC (IDENTITY.md; C3a). activeNodeId is a
    // DERIVED view for Domain-N uses (env/tilt slices, mesh addressing) and
    // legacy read sites; its setter maps node_id writes back to the MAC so
    // unconverted writers keep working. Persisted key: 'activeDevice'
    // (legacy 'activeNodeId' is shimmed once in the device_list handler).
    activeDevice:  persistGet('activeDevice', ''),
    get activeNodeId() {
      return (this.availableDevices || []).find(d => d.addr === this.activeDevice)?.node_id ?? '';
    },
    set activeNodeId(v) {
      this.activeDevice = v
        ? ((this.availableDevices || []).find(d => d.node_id === v || d.addr === v)?.addr ?? '')
        : '';
    },
    cfgRadioId:    '',
    radioTab:      'device',
    availableDevices: [],
    deviceBleStates:  {},
    deviceConfigs:    {},
    deviceNodes:      {},
    autoPurge:        {},
    _readbackQueues:  {},

    // -- Info -----------------------------------------------------------------
    nodeSelf:      {},
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
    rotatorTargets:  [],
    rotatorSchema:   null,   // v5 device config schema (pushed over WS)
    rotatorManualAz:  null,
    rotatorMode:      0,
    pwmRunPctInput:   null,
    pwmFreqInput:     null,

    // -- OTA ------------------------------------------------------------------
    // All loading/progress/error state lives in ops[key] via asyncOp/asyncOpStart/End.
    // Keys: 'otaFiles_!id', 'otaReleases', 'otaDownload_!id', 'otaFlash_!id', 'otaUpload_!id'
    otaFiles:          {},   // nodeId -> {files, hw_model, dir, error}
    otaSelectedFile:   {},   // nodeId -> filename string
    otaFetchOpen:      {},   // nodeId -> bool (GitHub fetch panel expanded)
    otaReleases:       null, // [{tag, name, assets, ...}]
    otaSelectedRelease:  '',
    otaNvsDeadline:      null,  // Unix ms; set during OTA_SERIAL_WAIT, cleared otherwise
    otaNvsCountdownSecs: null,  // live seconds remaining; driven by setInterval in app-ws.js
    _nvsCountdownTimer:  null,  // internal interval handle

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
    passiveTraceNum:   null,
    radarCtx:          null,   // [V2] SSOT_ROUTE_RENDER — backend-derived radar display state
    _radarScalePts:    null,   // adaptive-scale control points (display cache, hysteresis)
    _radarLabelAngles: null,   // Map num→arm angle — per-node label placement memory
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
    blePins:      {},   // per-device PIN: { [address]: pin }
    bleError:     '',

    // NEED_PAIR overlay — shown when a BLE device requires a PIN to pair
    needPairAddr:  null,   // MAC address of device stuck in NEED_PAIR
    needPairPin:   '',     // user-entered PIN value
    needPairError: '',     // e.g. "Wrong PIN — try again"
    needPairBusy:  false,  // true while submitting

    // -- Telemetry / tilt / env -----------------------------------------------
    envHistory:  {},
    envWindow:   persistGet('envWindow', 72),
    tiltHistory: [],
    tiltWindow:  persistGet('tiltWindow', 4),
    tiltPeak:    0,
    tiltRings:   [1, 2, 3, 4],
    tiltZero:       null,
    tiltNorthAngle: null,

    // -- Alerts ---------------------------------------------------------------
    alertRules:       [],
    alertSmtp:        {},
    alertSmtpSaving:  false,
    alertSmtpSaved:   false,
    alertSmtpError:   '',
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
    radarCfg:         { display: {}, pasv: {}, actv: {}, scan: {} },
    radarCfgSaved:    false,
    radarCfgError:    '',
    radarCfgSaving:   false,
    // Per-mode radio roles (Config → Modes). Populated from GET /config/modes.
    modesCfg:         { pasv: {}, actv: {}, scan: {} },
    modesCfgSaving:   false,
    modesCfgSaved:    false,
    modesCfgError:    '',
    rxRoleOptions: [
      { value: 'rotator',     label: 'Rotator' },
      { value: 'non-rotator', label: 'Any non-rotator' },
      { value: 'primary',     label: 'Primary' },
      { value: 'all',         label: 'All radios' },
    ],
    txRoleOptions: [
      { value: 'rotator',     label: 'Rotator' },
      { value: 'primary',     label: 'Primary' },
      { value: 'non-rotator', label: 'Any non-rotator' },
      { value: 'all',         label: 'All radios' },
      { value: 'rx',          label: 'Whichever heard it' },
    ],
    rotatorCalSent:   false,
    rotatorCalError:  '',
    rotatorOffsetInput: '',
    antennaSaved: false,
    antennaError: '',
    homePosSaved: false,
    homePosError: '',
    homeLat: null,
    homeLon: null,

    // -- Live feed ------------------------------------------------------------
    feedVisible: [],   // populated in init() from feedFilterOptions; DOM persist manages it

    // -- Performance ----------------------------------------------------------
    perfHistory:          [],
    perfLoading:          false,
    perfAutoNodes:        JSON.parse(persistGet('perfAutoNodes', '[]')),
    perfDevice: persistGet('perfDevice', ''),
    perfAutoIntervalMin:  parseInt(persistGet('perfAutoIntervalMin', '5'), 10) || 5,
    perfTrendWindowHours: parseInt(persistGet('perfTrendWindowHours', '72'), 10) || 72,
    perfExpert:           persistGet('perfExpert', 'false') === 'true',
    _perfAutoTimer:       null,

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
    _rangeTick:      0,
    _rangeUid:       0,

    // -- Init -----------------------------------------------------------------
    async init() {
      initPersist();
      this.feedVisible = (window.feedFilterOptions || []).map(o => o.id);

      // One-time migration: move tilt calibration from localStorage to server DB
      const lsZero  = localStorage.getItem('tiltZero');
      const lsNorth = localStorage.getItem('tiltNorthAngle');
      if (lsZero !== null || lsNorth !== null) {
        try {
          await fetch('/tilt_cal', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              zero:        lsZero  !== null ? JSON.parse(lsZero)       : undefined,
              north_angle: lsNorth !== null ? parseFloat(lsNorth)      : undefined,
            }),
          });
        } catch (_) {}
        localStorage.removeItem('tiltZero');
        localStorage.removeItem('tiltNorthAngle');
      }

      // settings arrive via the WS settings event (settings-via-ws)
      // device configs arrive on the WS device_list (C2)
      await this.loadBridgeConfig();

      if (this.activeNodeId) await this.bootstrapDevice();

      await this.loadMessages();

      this.connectWS();

      window.addEventListener('popstate', e => {
        const pathToTab = {
          '/overview': 'overview', '/radar': 'radar', '/nodes': 'nodes',
          '/config': 'cfg', '/range': 'range', '/messages': 'messages', '/devices': 'devices',
          '/performance': 'perf',
        };
        const t = e.state?.tab ?? pathToTab[window.location.pathname] ?? 'overview';
        this.setNav(t);
      });

      this.$watch('activeDevice', () => { this.loadTiltHistory(); this.loadEnvHistory(this.activeNodeId); });
      this.$watch('tiltWindow',        () => this.loadTiltHistory());
      this.$watch('envWindow',         () => this.loadEnvHistory(this.activeNodeId));
      this.$watch('rangeNodeFilter',   () => { this._rangeStats = null; this._rangeChartCache = null; });
      this.$watch('rangeRxFilter',     () => { this._rangeStats = null; this._rangeChartCache = null; this.rangeNodeFilter = ''; });
      this.$watch('rotatorStatus.variant', () => {
        // Device switched — rebuild the firmware config form against the new
        // variant's schema (v4 PWM ↔ v5 stepper) if the rotator cfg tab is open.
        if (this.tab === 'cfg' && this.cfgTab === 'rotator') {
          const el = document.getElementById('rotator_cfg_form');
          if (el) delete el.dataset.dirty;
          this.loadRotatorCfg();
        }
      });
      this.$watch('rotatorSchema', () => {
        // v5 device schema (re)arrived — rebuild the config form from it.
        if (this.tab === 'cfg' && this.cfgTab === 'rotator') {
          const el = document.getElementById('rotator_cfg_form');
          if (el) delete el.dataset.dirty;
          this.loadRotatorCfg();
        }
      });
      this.$watch('tab',               t => { if (t === 'perf') this.$nextTick(() => this.initPerfCharts()); });
      this.$watch('perfHistory',       () => this.$nextTick(() => this.updatePerfCharts()));
      this.$watch('perfTrendWindowHours', () => this.$nextTick(() => this.updatePerfCharts()));
      this.$watch('loraCfg',           () => this.$nextTick(() => this.updatePerfCharts()));
      this.$watch('homePos',           () => this.$nextTick(() => this.updatePerfCharts()));
      this.$watch('nodes',             () => this.$nextTick(() => this.updatePerfCharts()));
      this.$watch('deviceConfigs',     () => this.$nextTick(() => this.updatePerfCharts()));
      this.$watch('tiltPeak', peak => {
        const stops = [0.25, 0.5, 1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90];
        const maxRing = stops.find(v => v >= Math.max(peak * 1.25, 0.5)) ?? 90;
        const q = maxRing / 4;
        this.tiltRings = [q, q*2, q*3, maxRing].map(v => +v.toFixed(2));
      });

      this.loadTiltHistory();
      this.loadEnvHistory(this.activeNodeId);
      this.adoptPerfLoraCfg();
      setInterval(() => { if (this.yagiSignal.ts) this._sigTick++; }, 1000);
      setInterval(() => this._rangeTick++, 60000);

      if (this.tab === 'radar') this.$nextTick(() => this.initRadar());
      else if (this.tab === 'cfg') this.switchCfgTab(this.cfgTab);
      else if (this.tab === 'range') { this.loadRangeTest(); this.loadRangeTimer(); }
      else if (this.tab === 'perf') { this.adoptPerfLoraCfg(); this.perfHistory = this.perfHistorySlice(); this.$nextTick(() => this.initPerfCharts()); }
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
    componentsMixin, perfMixin,
  ];
  for (const mixin of mixins) {
    Object.defineProperties(state, Object.getOwnPropertyDescriptors(mixin));
  }
  return state;
};
