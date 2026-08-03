// relay-observation — who relayed each packet, and how it reached us.
//
// Task `packet-provenance-capture`. Spec: docs/modules/relay-observation.md
//
// WHY THIS EXISTS. Relay membership was only knowable from
// `traceroute_history.route`, which is populated ONLY on success (3,383 ok rows
// carry a route; 18,908 timeout rows carry none). So "this target shares a relay
// with a known-good path" merely restates "this target has answered before" — a
// ranking built on it scores 19.9% vs 0.0% and means nothing. That mistake was
// made and caught on 2026-08-03. Every packet already carries the answer, and
// collecting it costs no airtime.

import { insertRelayObservation, pruneRelayObservations } from './db.js';
import { getConfig } from './db.js';

const PRUNE_EVERY = 5000;
let _sincePrune = 0;

// Retention is enforced inline rather than on a timer. `startAutoPurgeScheduler`
// purges the RADIO's NodeDB over the air on a per-device schedule and has nothing
// to do with local table retention; hooking it there would couple a database
// concern to a mesh operation. A counter needs no scheduler and cannot drift.
function _maybePrune() {
  if (++_sincePrune < PRUNE_EVERY) return;
  _sincePrune = 0;
  const raw  = Number(getConfig('relay_observation.retain_days', 30));
  const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, raw)) : 30;
  try {
    const n = pruneRelayObservations(days);
    if (n) console.log(`[relay-obs] pruned ${n} rows older than ${days}d`);
  } catch (e) {
    console.error(`[relay-obs] prune failed: ${e.message}`);
  }
}

// PROTO3 ZERO-OMISSION IS THE WHOLE RISK HERE. mesh-gw serialises with default
// omission, so a zero-valued field is ABSENT ENTIRELY. persist.js:115 already
// documents this for relay_node and the same rule applies to every field below:
//
//   relay_node          absent => 0                    NOT RELAYED, never "unknown"
//   hop_limit           absent => 0
//   transport_mechanism absent => TRANSPORT_INTERNAL    (enum 0), never "unknown"
//
// Enum verified against mesh.proto: INTERNAL=0, LORA=1, LORA_ALT1..3=2..4,
// MQTT=5, MULTICAST_UDP=6, API=7, UNICAST_UDP=8.
//
// hop_start is NOT defaulted — absent hop_start is genuinely no information, and
// persist.js treats it the same way.
export function captureRelayObservation(packet, device, ts) {
  if (!packet?.from) return;
  insertRelayObservation({
    ts:         packet.rx_time || ts || Math.floor(Date.now() / 1000),
    from_num:   packet.from,
    relay_byte: packet.relay_node ?? 0,
    rx_device:  device ?? null,
    hop_start:  packet.hop_start ?? null,
    hop_limit:  packet.hop_limit ?? 0,
    transport:  packet.transport_mechanism ?? 'TRANSPORT_INTERNAL',
    decoded:    packet.decoded ? 1 : 0,
  });
  _maybePrune();
}
