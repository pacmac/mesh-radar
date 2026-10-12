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
let _prunedOnLoad = false;

// Retention is enforced inline rather than on a timer. `startAutoPurgeScheduler`
// purges the RADIO's NodeDB over the air on a per-device schedule and has nothing
// to do with local table retention; hooking it there would couple a database
// concern to a mesh operation. A counter needs no scheduler and cannot drift.
function _maybePrune() {
  // PRUNE ONCE ON THE FIRST PACKET AFTER BOOT, as well as on the counter. The
  // counter alone is ~4 hours at ~20 packets/min, and _sincePrune is a
  // module-level variable reseeded at 0 on every restart — so under PM2 watch,
  // any restart cadence faster than 5,000 packets meant pruning NEVER ran and
  // the table grew past retain_days unbounded. The comment below claims a
  // counter "cannot drift"; it cannot drift, but it can be reset forever.
  if (!_prunedOnLoad) { _prunedOnLoad = true; }
  else if (++_sincePrune < PRUNE_EVERY) return;
  else _sincePrune = 0;
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

/** mesh.proto's Transport enum, value -> canonical name.
 *
 *  The enum listed in the comment above, made executable. It was already verified
 *  against mesh.proto and then not used, which is why the column split. */
const TRANSPORT_BY_VALUE = {
  0: 'TRANSPORT_INTERNAL',
  1: 'TRANSPORT_LORA',
  2: 'TRANSPORT_LORA_ALT1',
  3: 'TRANSPORT_LORA_ALT2',
  4: 'TRANSPORT_LORA_ALT3',
  5: 'TRANSPORT_MQTT',
  6: 'TRANSPORT_MULTICAST_UDP',
  7: 'TRANSPORT_API',
  8: 'TRANSPORT_UNICAST_UDP',
};

/** NEVER STORE A PEER'S ENUM VERBATIM. This is the whole lesson of 2026-08-23.
 *
 *  `transport: packet.transport_mechanism ?? 'TRANSPORT_INTERNAL'` was correct
 *  only for as long as mesh-gw happened to send enum NAMES. They switched to
 *  numeric VALUES at 2026-08-22 17:06 and we passed it straight through, so one
 *  column ended up holding TRANSPORT_LORA and 1.0 at the same time — 18,178 rows
 *  and climbing at ~1,145/hour.
 *
 *  Nothing here noticed. It took mesh-gw reading our database to find it, and by
 *  then six queries comparing this column to a string literal had been silently
 *  excluding every new row for fifteen hours — including snapshot-api.js:109,
 *  which feeds snapshot.distribution on /events.
 *
 *  ABSENT IS ENUM 0, NEVER "unknown" — proto3 omits zero-valued fields, the same
 *  rule as relay_byte and hop_limit above.
 *
 *  AN UNRECOGNISED VALUE IS MADE VISIBLE rather than passed through, because
 *  passing it through is exactly what caused this. TRANSPORT_UNKNOWN_<n> is
 *  stable, greppable, and cannot be mistaken for a real enum name.
 *
 *  docs/modules/relay-observation.md. */
export function normaliseTransport(raw) {
  if (raw == null || raw === '') return TRANSPORT_BY_VALUE[0];
  // Already canonical — accept unchanged so a re-run is idempotent, which the
  // backfill depends on.
  if (typeof raw === 'string' && raw.startsWith('TRANSPORT_')) return raw;
  // '1.0' and 1.0 alike: mesh-gw's numeric arrived through JSON as a float and
  // reached SQLite as the TEXT '1.0'. Number() takes both; Math.trunc drops the
  // decimal without rounding a 1.9 up into a different enum member.
  const n = Number(raw);
  if (Number.isFinite(n)) {
    const name = TRANSPORT_BY_VALUE[Math.trunc(n)];
    return name ?? `TRANSPORT_UNKNOWN_${Math.trunc(n)}`;
  }
  return `TRANSPORT_UNKNOWN_${String(raw)}`;
}

export function captureRelayObservation(packet, device, ts) {
  if (!packet?.from) return;
  insertRelayObservation({
    ts:         packet.rx_time || ts || Math.floor(Date.now() / 1000),
    from_num:   packet.from,
    relay_byte: packet.relay_node ?? 0,
    rx_device:  device ?? null,
    hop_start:  packet.hop_start ?? null,
    hop_limit:  packet.hop_limit ?? 0,
    transport:  normaliseTransport(packet.transport_mechanism),
    decoded:    packet.decoded ? 1 : 0,
    // ABOVE THE DECODED GATE, same as everything else here — `packet.decoded`
    // may be absent entirely (15% of live packets are encrypted-only), so
    // portnum_name is optional-chained rather than assumed. packet.id and
    // rx_snr are header-level, present regardless of decode status.
    // Relayed from fun via mesh-gw, item relay-observation-keeps-no-packet-type.
    portnum_name: packet.decoded?.portnum_name ?? null,
    packet_id:    packet.id ?? null,
    rx_snr:       packet.rx_snr ?? null,
  });
  _maybePrune();
}
