// mesh-gw dashboard — Alpine compose entry point.
// State and init() only. All logic lives in the app-*.js mixin modules.
import { uiMixin }        from './app-ui.js';
import { navMixin, initTab, nodeNumFromPath, tabFromPath } from './app-nav.js';
import { wsMixin }        from './app-ws.js';
import { devicesMixin }   from './app-devices.js';
import { nodesMixin }     from './app-nodes.js';
import { rotatorMixin }   from './app-rotator.js';
import { radarMixin }     from './app-radar.js';
import { snapshotMixin } from './app-snapshot.js';
import { messagesMixin }  from './app-messages.js';
import { rangeMixin }     from './app-range.js';
import { perfMixin }      from './app-perf.js?v=20260627rewrite';
import { telemetryMixin } from './app-telemetry.js';
import { configMixin }      from './app-config.js';
import { componentsMixin }  from './app-components.js';
import { nodeStatusMixin }  from './app-node-status.js';
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
    // Observatory sub-tab. Defaults to the board — the dashboard is the page;
    // the raw feeds are diagnostics you go looking for.
    obsTab:        persistGet('obsTab', 'board'),
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
    // Served band tables (WS `verdict_bands`). Null until connect — callers
    // render a muted placeholder rather than inventing a band.
    verdictBands:     null,
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
    // ── Radar layers ─────────────────────────────────────────────────────────
    // Which layers are VISIBLE is a view preference and lives in the browser.
    // What each layer CONTAINS is served — node_kind from src/node-kind.js,
    // clusters from src/clusters.js. The browser never decides membership.
    //
    // Labels are here because they name a browser-side view control, not a
    // backend concept. If these ever become backend concepts they must be served
    // like the mode vocabulary is.
    // `order` is BOTH the draw depth and the brightness. Peter, 2026-08-05:
    // "when I click a layer it will move to the top and previous layers will be
    // demoted ... as well as a toggle for a layer it also needs a depth or layer
    // number that auto increments and possibly also allows me to change the
    // order and IT MUST PERSIST."
    //
    // Highest order = the FOCUS layer: drawn last, drawn brightest. That replaces
    // the instinct to fade everything so it can coexist, which produced two
    // unreadable terrain renders before he told me to stop doing it.
    //
    // `draws: true` means it is a real draw layer with its own SVG group and can
    // be z-ordered. The node KINDS (doors/routers/endpoints) are filters WITHIN
    // the nodes layer — they share one <g>, so they cannot be independently
    // depth-ordered, and pretending otherwise would be a lie in the UI.
    radarLayers: [
      { key: 'terrain',   label: 'Terrain',   on: true, order: 1, draws: true  },
      { key: 'reach',     label: 'Reach',     on: true, order: 2, draws: true  },
      { key: 'clusters',  label: 'Clusters',  on: true, order: 3, draws: true  },
      { key: 'nodes',     label: 'Nodes',     on: true, order: 4, draws: true  },
      { key: 'doors',     label: '· Doors',     on: true, order: 0, draws: false },
      { key: 'routers',   label: '· Routers',   on: true, order: 0, draws: false },
      { key: 'endpoints', label: '· Endpoints', on: true, order: 0, draws: false },
    ],
    clusterData:    null,
    terrainData:    null,
    reachData:      null,
    clusterCard:    null,   // hovered cluster detail; null = hidden
    radarNodes:     [],
    radarSelected:  null,
    homePos:        null,
    geocoding:      false,
    radarCrosshair: true,
    heatmapMaxAge:  3600,
    nodeInfo:       null,
    // Node focus page (NODE_FOCUS_PAGE_SPEC). nodeStatus holds the last payload
    // the server sent — a display cache, never a source of decisions.
    nodeStatus:     null,
    nodeStatusNum:  null,
    favourites:     [],   // server-computed; nav entries for starred nodes
    // Chart window (1/4/24/72 HR). User input, forwarded to the backend —
    // the SERVER slices history and computes the axis labels for it.
    nodeWindowHours: Number(persistGet('nodeWindowHours', 24)),
    // Live traceroutes, keyed by the feed's run id. Peter, 2026-08-18: the radar
    // "can show it happening WITHOUT commanding it". Written ONLY by the
    // traceroute_status handler; nothing here initiates one.
    traceroutes:       {},
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
    // 'public' or 'private', never an index. It was `null` awaiting a served
    // integer; the value now arrives as a WORD on device_list.default_channel and
    // the gateway resolves it per radio. null until the first frame.
    // docs/modules/channels.md.
    msgChannel: null,
    // RETAINED, AND NOW ALWAYS EQUAL. It tracked which radio an index had been
    // chosen for, because index 1 is Private on the YAGI and `mqtt` on the OMNI,
    // so switching radio silently re-pointed the same number at a different
    // channel. A word cannot do that. Kept only because tab-shared and
    // tab-messages both still bind it; msgChannelStale() is now constant false.
    msgChannelFor: null,
    // Whether the observatory/DISC/snapshot subsystem exists at all.
    // SERVED on the settings frame (`observatory.enabled`), never decided
    // here. False until told, so the nav does not offer a page that 404s.
    observatoryEnabled: false,
    msgFilter: 'all',
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
    // rxRoleOptions/txRoleOptions DELETED — they were a retyped copy of the
    // server's RX_ROLES/TX_ROLES with the page's own labels. Served now via
    // GET /config/mode-vocabulary. Task `serve-mode-vocabulary`.
    modeVocab: null,
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
    // Only the radio scope survives. The history store, the loading flag, the
    // trend window, the expert toggle and the auto-trace schedule all described
    // traceroute measurements — removed 2026-08-17, spec
    // docs/modules/traceroute-removal-browser.md.
    perfDevice: persistGet('perfDevice', ''),

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
    // Layer visibility AND order, restored from the single browser store. NOT
    // from initRadar() — that early-returns before homePos is ready on a cold
    // load and never retries, which is why the first version never restored.
    try { this.restoreRadarLayers(); } catch (e) { console.warn('restoreRadarLayers', e); }
      this.feedVisible = (window.feedFilterOptions || []).map(o => o.id);

      // One-time migration: move tilt calibration from localStorage to server DB.
      //
      // These two reads MUST stay on raw localStorage. A migration reads the
      // LEGACY location by definition — pointing them at ui_prefs (as a
      // find-and-replace briefly did) makes the migration find nothing and
      // strands the old values forever.
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

      // Deep link: /node/!hexid loaded directly. The RPC is re-issued on WS
      // open too, since the socket may not be ready at this point.
      const bootNode = nodeNumFromPath();
      if (bootNode) this.focusNode(bootNode);

      window.addEventListener('popstate', e => {
        const nodeNum = nodeNumFromPath();
        if (nodeNum) { this.setNav('node'); this.focusNode(nodeNum); return; }
        const stateTab = e.state?.tab;
        const t = (stateTab && ['overview','radar','nodes','cfg','range','messages','devices','perf'].includes(stateTab))
          ? stateTab
          : (tabFromPath() ?? 'overview');
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
      // The seven perf-chart watchers are gone with the charts they redrew —
      // 2026-08-17, spec docs/modules/traceroute-removal-browser.md. Every one
      // of them existed to re-render a plot of traceroute_history rows.
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
      else if (this.tab === 'perf') { this.adoptPerfLoraCfg(); }
    },
  };
}

// Expose as a global so x-data="dashboard()" in index.html continues to work.
// Use defineProperties to merge mixins so getters are transferred without being invoked.
window.dashboard = function() {
  const state = dashboard();
  // Plugin-contributed state, merged before the mixins that read it. Same rule:
  // core never names a plugin, and no plugins means no change at all.
  for (const p of (window.__dashPlugins || [])) Object.assign(state, p.state || {});
  const mixins = [
    uiMixin, navMixin, wsMixin, devicesMixin, nodesMixin,
    rotatorMixin, radarMixin, messagesMixin, rangeMixin, telemetryMixin, configMixin,
    componentsMixin, perfMixin, nodeStatusMixin, snapshotMixin,
    // Plugin-contributed mixins. Core does not know what any of them are; a
    // plugin registers itself in window.__dashPlugins from a script emitted
    // BEFORE this file (src/browser-plugins.js). With no plugins this is [].
    ...(window.__dashPlugins || []).flatMap(p => p.mixins || []),
  ];
  for (const mixin of mixins) {
    Object.defineProperties(state, Object.getOwnPropertyDescriptors(mixin));
  }
  return state;
};
