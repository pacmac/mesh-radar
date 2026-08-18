import { handleEvent } from './persist.js';
import { nodeList, hopsAway } from './node-list.js';
import { activeTracker } from './active-tracker.js';
import { scanner } from './scanner.js';
import { insertRangeTestEntry, insertEnvHistory, touchRfHeard } from './db.js';
import { traceroute } from './traceroute.js';
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
      // A RECEPTION IS PERSISTED, ALWAYS — OUTSIDE THE SCAN GUARD.
      //
      // `yagiOnly` exists so that during a scan only the scan listener may update
      // the CACHE; that is a scan-attribution rule and it still applies below.
      // But "we received a packet from node X at time T" is true whichever radio
      // heard it, and withholding it does not make the scan more accurate — it
      // just loses the fact, and `last_heard` goes stale while we are actively
      // hearing the node. Peter, 2026-08-18: "last_heard is KING, it must never
      // be stale." docs/modules/last-heard-is-king.md.
      //
      // RF ONLY. An MQTT-delivered packet did not travel the whole path by radio,
      // so it must not count as having heard the node — that is the distinction
      // node_filters.hide_mqtt_only rests on.
      if (pkt?.from && !ev.via_mqtt) touchRfHeard(pkt.from, pkt.rx_time);
      if (pkt?.from && !yagiOnly) {
        nodeList.touchLastHeard(pkt.from, pkt.rx_time, rxDevice);
        // Guarded hops-away, updated per packet (firmware NodeDB updateFrom analog)
        nodeList.setHopsAway(pkt.from, hopsAway(pkt.hop_start, pkt.hop_limit));
      }
      // TRACEROUTE REPLIES. RESTORED 2026-08-18 — spec
      // docs/modules/traceroute-decode-restored.md.
      //
      // THIS LINE'S ABSENCE MADE EVERY TRACEROUTE TIME OUT. It was removed on
      // 2026-08-17 with the rest of the traceroute surface, correctly at the
      // time: every dispatcher was gone, so nothing could be pending and a
      // decoder had nothing to match. Dispatch came back the next day as
      // POST /traceroute — and this did not come back with it.
      //
      // For the whole of that window a reply could arrive perfectly, on the
      // right radio, from the right node, and NOTHING WOULD LOOK AT IT. Five
      // traceroutes ran to their full timeout, including one to a node with a
      // 70% answer rate that had been heard on RF sixty seconds earlier, and
      // every one was attributed to a degraded mesh — because a broken decoder
      // and a silent mesh produce identical evidence.
      //
      // THE LESSON: a component removed as dead must be re-checked when the
      // thing that made it dead comes back. Removing the dispatcher is what made
      // this dead code; restoring the dispatcher should have restored this, and
      // nothing linked the two.
      //
      // It also decodes replies we merely OVERHEAR, which cost no transmission
      // at all — traceroute.js records those with null attribution, honestly
      // marking them as not ours.
      traceroute.handlePacket(pkt, rxDevice);
    }
    // mesh-gw's own decoded traceroute event, fed through the same handler via a
    // synthetic packet. Restored with the raw path above and for the same reason.
    if (ev.type === 'traceroute' && ev.from_num) {
      traceroute.handlePacket({
        from: ev.from_num, to: ev.to_num,
        decoded: { portnum: 'TRACEROUTE_APP', route_discovery: ev.data ?? {} },
      }, ev.addr || ev.device || null);
    }
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
