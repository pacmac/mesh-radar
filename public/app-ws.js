// WebSocket connection and event dispatch mixin.
import { b64ToUtf8, summarizeEvent, FEED_FILTER_OPTIONS } from './app-helpers.js';
import { persistSet, persistGet } from './app-persist.js';

// The SNR ingest boundary moved to the SERVER (src/snr.js, applied in
// ws-relay.js). Rows arrive in dB with null for unmeasured hops, so there is
// nothing to decode here — and nothing in public/ may decode again.
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
    // Plugin OBSERVERS run first and claim nothing. They exist because a plugin
    // sometimes needs an event core owns — the alarm defaults its align target
    // from `node_list`'s favourites, which core claims and returns on. An
    // observer reads the PUSHED PAYLOAD (ev), never component state, since core
    // has not updated it yet at this point.
    for (const plugin of (window.__dashPlugins || [])) {
      try { plugin.wsObservers?.[ev.type]?.call(this, ev); }
      // A broken plugin must never take the core event loop down with it.
      catch (e) { console.error('[plugin observer]', plugin.name, ev.type, e); }
    }

    if (ev.type === 'config_op')           { handleConfigOp(ev); return; }
    if (ev.type === 'bridge_connected')    { this.bridgeConnected = true;  return; }
    if (ev.type === 'bridge_disconnected') { this.bridgeConnected = false; return; }
    // Plugin-contributed event types. Core keeps FIRST REFUSAL — this runs only
    // after every core handler above has declined, so a plugin can never shadow
    // a core message. Core does not know what types exist here; a plugin
    // registers them in window.__dashPlugins (docs/BROWSER_PLUGIN_SPEC.md).
    for (const plugin of (window.__dashPlugins || [])) {
      const fn = plugin.wsHandlers?.[ev.type];
      if (fn) { fn.call(this, ev); return; }
    }

    if (ev.type === 'settings') {
      // Page state arrives over WS only (settings-via-ws) — replayed on
      // connect and re-broadcast after every config write, so filter/radar
      // changes are live in every tab. Replaces the deleted loadConfig GET.
      const cfg = ev.config || {};
      // SERVED, not decided. Whether the observatory exists is the backend's
      // answer; the nav renders it and nothing here works it out. Defaults FALSE
      // so a settings frame that has not arrived yet hides the entries rather
      // than flashing pages that 404.
      this.observatoryEnabled = cfg['observatory.enabled'] === true;
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
      // perf.failure_epoch is no longer adopted — the success-rate stat it fed
      // went with the traceroute history (2026-08-17). The config key itself
      // stays in the store for whatever replaces it.
      if (cfg['range_test.duration']) this.rangeDuration = cfg['range_test.duration'];
      // Rotator commands go straight from the browser to mesh-gw's aim plugin
      // now (2026-09-03, task rotator-command-via-meshgw-aim) — same host as
      // this page, only the port differs, and only the server knows it.
      // SERVER-SUPPLIED, never a hardcoded LAN address in client JS.
      if (ev.meshgw_port) {
        const hadBase = !!this.meshgwBase;
        this.meshgwBase = `${location.protocol}//${location.hostname}:${ev.meshgw_port}`;
        // Settings can arrive after initRadar() already ran and no-opped for
        // lack of a base URL — catch up the one-shot check here instead of
        // leaving rotatorConnected stuck false for the rest of the session.
        if (!hadBase && this.tab === 'radar') this._checkRotatorStatus();
      }
      if (this.tab === 'radar' && this.homePos) this.refreshRadar();
      return;
    }


    // Node focus page. The reply carries display-ready sections; the hint
    // carries only a num, so we re-request rather than trust a pushed value.
    // Observatory feed (src/observatory-ws.js) — replayed on connect, appended
    // on arrival. Pure state application; nothing is derived here.
    if (ev.type === 'observations_replay') { this.applyObservationsReplay(ev); return; }
    if (ev.type === 'observation')         { this.applyObservation(ev); return; }
    if (ev.type === 'relay_usage')         { this.applyRelayUsage(ev); return; }
    if (ev.type === 'reach_model')         { this.applyReachModel(ev); return; }
    if (ev.type === 'mesh_links')          { this.applyMeshLinks(ev); return; }
    if (ev.type === 'missions')            { this.applyMissions(ev); return; }
    if (ev.type === 'mission_activity')    { this.applyMissionActivity(ev); return; }
    if (ev.type === 'charts')              { this.applyCharts(ev); return; }
    if (ev.type === 'event_log')           { this.applyEventLog(ev); return; }
    if (ev.type === 'event')               { this.applyEvent(ev); return; }
    if (ev.type === 'snapshot')           { this.onSnapshot(ev); return; }
    if (ev.type === 'radar')              { this.onRadarOverlays(ev); this.drawRadar?.(); return; }
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

    // THE AIMING ANIMATION IS GONE — 'trace_aiming' and 'trace_aimed' removed
    // 2026-08-17, spec docs/modules/traceroute-removal-browser.md.
    //
    // Peter, 2026-08-04, on what is being lost: "the beauty and refinement of
    // the radar is it actually animates the whole traceroute, the antenna
    // aiming, the target node, and also displays an animated route when it is
    // actively trace routing." Worth rebuilding on top of whatever replaces
    // the dispatcher — the animation was never the broken part.
    //
    // Both events were emitted by traceroute.run(). Nothing dispatches, so
    // nothing emits them, and a handler for an event that can never arrive is
    // exactly the fragment this removal is for.

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
      // msgFrom bookkeeping removed 2026-09-03, task
      // messages-frontend-and-browser-route-removed — fed the deleted compose
      // modal's default "From" device.
      // Perf page cold-load: perfDev() resolves once the device list exists.
      // The history re-slice that sat here went with the history itself
      // (2026-08-17, spec docs/modules/traceroute-removal-browser.md); the
      // theory constants still need adopting.
      if (this.tab === 'perf' && devices.length) this.adoptPerfLoraCfg();
      return;
    }

    // BLE pairing and OTA flash/download progress events (need_pair, ota_*) are
    // no longer consumed — mesh-gw owns both flows and their UI now (2026-09-03,
    // task devices-management-removed-meshgw-owns-it). Unhandled WS event types
    // fall through safely below.

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

    // known_nodes / message_history handling removed 2026-09-03, task
    // messages-frontend-and-browser-route-removed — the backend no longer
    // sends either (their only consumer was the deleted Messages page).

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

    if (ev.type === 'verdict_bands') {
      // The band tables. Static config, sent once on connect. The page looks
      // values up against these instead of holding thresholds of its own —
      // BROWSER_CONTRACT, and docs/modules/signal-verdict.md.
      const { type: _t, ...bands } = ev;
      this.verdictBands = bands;
      return;
    }

    // THE TRACEROUTE STATUS FEED. One event type carrying a phase; the browser
    // stores it and renders, and decides nothing. Spec:
    // docs/modules/radar-traceroute-overlay.md.
    //
    // OBSERVING, NOT COMMANDING — the distinction that was got wrong on
    // 2026-08-17 when the route overlay was deleted along with the TRACE button.
    // Nothing in public/ posts a traceroute; this only watches.
    if (ev.type === 'traceroute_status') {
      // Replace by run id. A terminal phase STAYS in the map — Peter, 2026-08-18:
      // "should a finished trace disappear on its own - no, because then I can
      // see the last traceroute." Retiring dims it; nothing is removed.
      this.traceroutes = { ...this.traceroutes, [ev.id]: { ...ev, retired: false } };

      // A SUCCESS NEEDS A DURATION. The trace stops the instant the reply lands
      // (traceroute.js:668), so without this the bright state lasted one redraw
      // and a succeeded trace looked identical to a stale one.
      //
      // THIS TIMER IS IN SCOPE. Peter, 2026-08-18: "NO TIMERS ... that is related
      // to DATA polling ... BUT any such timer cannot be a trigger or event that
      // is outside the scope of the UI." It fetches nothing, derives nothing, and
      // its whole effect is a colour change. The DEADLINE ITSELF IS SERVED —
      // ev.timing.deadline_ts, computed from Peter's traceroute.timeout_sec — so
      // the server decides when and this only executes it. A persistence constant
      // invented here would put that judgement back in the browser.
      this._traceRetire = this._traceRetire || {};
      if (this._traceRetire[ev.id]) {
        clearTimeout(this._traceRetire[ev.id]);
        delete this._traceRetire[ev.id];
      }
      if (ev.phase === 'answered' && ev.timing?.deadline_ts) {
        // Clamped at 0: a reply arriving after the deadline retires at once
        // rather than scheduling into the past.
        const ms = Math.max(0, ev.timing.deadline_ts * 1000 - Date.now());
        this._traceRetire[ev.id] = setTimeout(() => {
          const run = this.traceroutes?.[ev.id];
          if (run) this.traceroutes = { ...this.traceroutes, [ev.id]: { ...run, retired: true } };
          delete this._traceRetire[ev.id];
          if (this.tab === 'radar') this.refreshRadar();
        }, ms);
      }

      if (this.tab === 'radar') this.refreshRadar();
      return;
    }

    // 'traceroute_history' and 'traceroute_failed' handlers REMOVED 2026-08-17,
    // spec docs/modules/traceroute-removal-browser.md. They fed the perf page's
    // history store. Peter kept the 37,424 stored rows and dropped the reads:
    // the data is still in traceroute_history for the redesign to use, but
    // nothing serves it and nothing here consumes it.

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

    // The [V1] legacy raw-packet block that decoded TRACEROUTE_APP off the
    // packet feed and patched last_traceroute itself is REMOVED — 2026-08-17,
    // spec docs/modules/traceroute-removal-browser.md. It was the browser
    // decoding a mesh payload and deciding what it meant, which is the
    // BROWSER_CONTRACT violation the SSOT_TRACEROUTE flag existed to retire.

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
    // 'passive_trace_start' and 'route_discovered' handlers REMOVED 2026-08-17,
    // spec docs/modules/traceroute-removal-browser.md.
    //
    // route_discovered was the last writer of node.last_traceroute in the
    // browser, and it also carried the 30 s _passiveTraceTimer that cleared the
    // radar's passive-trace highlight — a timer in public/, and one that
    // decided on its own when a measurement had gone stale.

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
      // The TEXT_MESSAGE_APP special case (unread badge, sound, node-name cache
      // for the compose box) is gone with the Messages page — 2026-09-03, task
      // messages-frontend-and-browser-route-removed.
      if (pkt?.from != null) {
        this.lastHeardNum = pkt.from;
        if (this.tab === 'radar') this.drawRadar();
      }
      if (this.tab === 'nodes' && portnum === 'TELEMETRY_APP') this.sortNodes(this.nodeSort.key, true);
    }

    // message_status delivery-tick handling removed 2026-09-03, task
    // messages-frontend-and-browser-route-removed — updated this.messages,
    // which no longer exists (the Messages page is gone). The backend still
    // records delivery status to the messages table; this was purely a
    // browser-display update for a page that isn't rendered any more.

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
