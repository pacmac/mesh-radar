import { handleEvent } from './persist.js';
import { nodeList, hopsAway } from './node-list.js';
import { activeTracker } from './active-tracker.js';
import { scanner } from './scanner.js';
import { insertRangeTestEntry, insertEnvHistory, touchRfHeard } from './db.js';
import { broadcastMessageHistory } from './ws-relay.js';
import { ownDeviceNums } from './node-filter.js';
import { isListenerForMode } from './dash-mode.js';
import { handleAutomationEvent } from './automation.js';

const _lastEnvTs = new Map(); // num → last inserted ts (env metrics dedup)

export function registerBridgeEvents(bridge) {
  bridge.on('event', (ev) => {
    handleEvent(ev);

    // @verb commands broadcast on the private channel. AFTER handleEvent so the
    // command is already in the message log before we act on it — a verb that
    // moved the rotator but left no record of arriving would be undiagnosable.
    // It dedups by packet id internally: both radios hear the same broadcast.
    handleAutomationEvent(ev);

    // A received text message is now authoritative-history-driven exactly like a
    // sent one: push the enriched history so the browser never constructs a
    // message itself (MESSAGE_PIPELINE_REWRITE_SPEC).
    //
    // This MUST be here, after handleEvent, and not in ws-relay's own listener:
    // attachWsRelay registers at index.js:235 and registerBridgeEvents at :309,
    // so ws-relay's handler runs BEFORE the row is persisted and would broadcast
    // history that does not yet contain the message.
    if (ev.type === 'packet' && ev.data?.packet?.decoded?.portnum === 'TEXT_MESSAGE_APP') {
      broadcastMessageHistory();
    }
    if (ev.type === 'node_update' || ev.type === 'node_info') {   // V2 emits node_info
      nodeList.handleNodeUpdate(ev);
      const node = ev.data;
      const em = node?.environment_metrics;
      if (em && node?.num && ownDeviceNums().has(node.num) && (em.temperature != null || em.relative_humidity != null)) {
        const now = Math.floor(Date.now() / 1000);
        const last = _lastEnvTs.get(node.num) ?? 0;
        if (now - last > 60) {
          _lastEnvTs.set(node.num, now);
          insertEnvHistory({
            ts: now,
            num: node.num,
            temperature:         em.temperature         ?? null,
            relative_humidity:   em.relative_humidity   ?? null,
            barometric_pressure: em.barometric_pressure ?? null,
          });
          nodeList.setEnvironmentMetrics(node.num, em);
        }
      }
    }
    if (ev.type === 'packet') {
      activeTracker.handlePacket(ev);
      scanner.handlePacket(ev);
      const pkt = ev.data?.packet;
      const rxDevice = ev.addr || ev.device || null;
      // During a scan, only the SCAN listener(s) may update last-heard (default: rotator/YAGI).
      const yagiOnly = scanner.active && !isListenerForMode('scan', rxDevice);
      if (pkt?.from && !yagiOnly) {
        nodeList.touchLastHeard(pkt.from, pkt.rx_time, rxDevice);
        // RF ONLY. An MQTT-delivered packet did not travel the whole path by
        // radio, so it must not count as having heard the node — that is the
        // distinction node_filters.hide_mqtt_only rests on.
        if (!ev.via_mqtt) touchRfHeard(pkt.from, pkt.rx_time);
        // Guarded hops-away, updated per packet (firmware NodeDB updateFrom analog)
        nodeList.setHopsAway(pkt.from, hopsAway(pkt.hop_start, pkt.hop_limit));
      }
      // TRACEROUTE DECODE REMOVED — 2026-08-17, task
      // `traceroute-remove-backend-remainder`. Both paths went: the [V1] legacy
      // branch that decoded route_discovery here and resolved relay positions
      // itself, and the [V2] traceroute.handlePacket() that owned decode,
      // relay_positions and storage.
      //
      // This one is a genuine LOSS, and it is Peter's instruction: "all traces
      // of it removed". We overhear other people's traceroute replies on the
      // mesh, and decoding them cost us no transmission at all. That passive
      // data is no longer captured. Whatever replaces the dispatcher should
      // take this back first — it is the cheapest route information available,
      // and the only kind that does not put a frame on air.
    }
    // The `ev.type === 'traceroute'` branch — mesh-gw's own decoded traceroute
    // event, fed through the same handlePacket — is removed for the same reason.
    if (ev.type === 'range_test') {
      try {
        const seq = parseInt((ev.data?.text || '').replace(/[^0-9]/g, '')) || null;
        insertRangeTestEntry({
          ts:        Math.floor(Date.now() / 1000),
          from_num:  ev.from_num   ?? null,
          rssi:      ev.rx_rssi    ?? null,
          snr:       ev.rx_snr     ?? null,
          hops:      ev.hops       ?? null,
          seq,
          rx_device: ev.addr || ev.device || null,
          via_mqtt:  ev.via_mqtt ? 1 : 0,
        });
      } catch (err) {
        console.error(`[range_test] DB insert failed: ${err.message}`);
      }
    }
  });
}
