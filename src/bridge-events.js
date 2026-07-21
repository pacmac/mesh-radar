import { handleEvent } from './persist.js';
import { nodeList, hopsAway } from './node-list.js';
import { activeTracker } from './active-tracker.js';
import { scanner } from './scanner.js';
import { traceroute } from './traceroute.js';
import { stmts, insertRangeTestEntry, insertEnvHistory } from './db.js';
import { broadcastMessageHistory } from './ws-relay.js';
import { handleReply } from './node-settings.js';
import { handleAlignPong } from './align-api.js';
import { notePushReply } from './chunk-api.js';
import { handleGrabReply } from './capture-api.js';
import { ownDeviceNums } from './node-filter.js';
import { isListenerForMode } from './dash-mode.js';
import { FF } from './feature-flags.js';

const _lastEnvTs = new Map(); // num → last inserted ts (env metrics dedup)

export function registerBridgeEvents(bridge) {
  bridge.on('event', (ev) => {
    handleEvent(ev);

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

      // A device reply is threaded to its command by reply_id (API.md §3).
      // Routed here, after persistence, for the same ordering reason as the
      // history rebroadcast above.
      const pkt = ev.data.packet;
      if (pkt.decoded.reply_id) {
        // Decoded ONCE, in the shared scope, so every reply consumer sees it. A previous
        // version declared `text` inside the settings try-block only; handleGrabReply then
        // referenced it out of scope and threw "text is not defined" every time — a grab
        // reply arrived correctly but was never correlated, so the capture route timed out
        // and reported "no reply". Caught by a live press, not by the tests I deferred.
        const text = pkt.decoded.payload
          ? Buffer.from(pkt.decoded.payload, 'base64').toString('utf8') : '';
        try {
          handleReply(pkt.decoded.reply_id, text);
        } catch (e) {
          console.error('[settings] reply correlation failed:', e.message);
        }
        // A `cam grab` reply threads by the same reply_id but is classified by `type`
        // (grab/err), not `ok` — so it has its own correlator. Independent _pending map,
        // own try/catch, so a malformed grab reply cannot break settings or align.
        try {
          handleGrabReply(pkt.decoded.reply_id, text);
        } catch (e) {
          console.error('[capture] grab reply correlation failed:', e.message);
        }
        // A push START the DEVICE refuses ({"start":N,"ok":0}) is an explicit "no",
        // and it was invisible: the client retries the START and the UI shows a blank
        // progress bar, so a flat refusal looked identical to a dead radio. Surface it.
        try {
          notePushReply(pkt.from, text);
        } catch (e) {
          console.error('[chunk] push reply inspection failed:', e.message);
        }
        // The align ping loop needs the WHOLE packet, not just the text: the
        // per-radio envelope (pkt.rx_snr/rx_rssi) is the receiving radio's own
        // reading. No-op unless an align session is waiting on this reply_id.
        try {
          handleAlignPong(pkt, ev.addr || ev.device || null);
        } catch (e) {
          console.error('[align] pong correlation failed:', e.message);
        }
      }
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
        // Guarded hops-away, updated per packet (firmware NodeDB updateFrom analog)
        nodeList.setHopsAway(pkt.from, hopsAway(pkt.hop_start, pkt.hop_limit));
      }
      // ── [V1] LEGACY — remove when SSOT_TRACEROUTE verified ──────────────────
      if (!FF.SSOT_TRACEROUTE) {
        if (pkt?.decoded?.portnum === 'TRACEROUTE_APP' && pkt?.decoded?.route_discovery && pkt?.from) {
          const rd = pkt.decoded.route_discovery;
          const relay_positions = {};
          for (const num of rd.route ?? []) {
            const info = stmts.getNodeinfoByNum.get(num);
            if (info?.lat != null && info?.lon != null) {
              relay_positions[num] = { latitude_i: Math.round(info.lat * 1e7), longitude_i: Math.round(info.lon * 1e7) };
            }
          }
          nodeList.setTraceroute(pkt.from, {
            route:       rd.route       ?? [],
            route_back:  rd.route_back  ?? [],
            snr_towards: rd.snr_towards ?? [],
            snr_back:    rd.snr_back    ?? [],
            relay_positions,
            ts: Date.now(),
          }, pkt.to ?? null, rxDevice);
        }
      // ── [V2] SSOT — traceroute.js owns decode, relay_positions, storage ──────
      } else {
        traceroute.handlePacket(pkt, rxDevice);
      }
      // ─────────────────────────────────────────────────────────────────────────
    }
    if (ev.type === 'traceroute' && ev.from_num) {
      const rd = ev.data ?? {};
      if (FF.SSOT_TRACEROUTE) {
        const syntheticPkt = {
          from: ev.from_num, to: ev.to_num,
          decoded: { portnum: 'TRACEROUTE_APP', route_discovery: rd },
        };
        traceroute.handlePacket(syntheticPkt, ev.addr || ev.device || null);
      } else {
        if (Object.keys(rd).length) {
          const relay_positions = {};
          for (const num of rd.route ?? []) {
            const info = stmts.getNodeinfoByNum.get(num);
            if (info?.lat != null && info?.lon != null) {
              relay_positions[num] = { latitude_i: Math.round(info.lat * 1e7), longitude_i: Math.round(info.lon * 1e7) };
            }
          }
          nodeList.setTraceroute(ev.from_num, {
            route: rd.route ?? [], route_back: rd.route_back ?? [],
            snr_towards: rd.snr_towards ?? [], snr_back: rd.snr_back ?? [],
            relay_positions, ts: Date.now(),
          }, ev.to_num ?? null, ev.addr || ev.device || null);
        }
      }
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
