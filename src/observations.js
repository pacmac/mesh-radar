// Turning domain events into observations. PURE — no database, no clock, no
// network, no imports from src/ at all.
//
// This is the producer side of MESH_REACH_SPEC §7f: core emits, this maps, the
// composition root hands the result to the engine. Keeping the mapping pure is
// what lets it be tested with plain objects, and is why it does not import
// observatory.js — the boundary test permits exactly two importers of the
// engine, and this is deliberately not one of them.

/** Everything knowable at reception time, as an observation.
 *
 *  Returns null when there is nothing worth recording. Never throws — it runs
 *  on the packet hot path.
 *
 *  Pure: `rotatorStatus` and `deviceCfgs` are passed IN. Reading them here
 *  would make this untestable without a live rotator and a database, and would
 *  break the rule that a producer is a function of its inputs.
 *
 *  @param packet        the mesh packet
 *  @param device        MAC of the radio that heard it
 *  @param ts            arrival time, epoch SECONDS (house convention)
 *  @param replay        true when re-ingesting history
 *  @param rotatorStatus rotator.status — { az, moving/busy } or null
 *  @param deviceCfgs    getAllDeviceCfgs() — MAC-keyed antenna profiles
 */
export function packetObservation(packet, device, ts, replay, rotatorStatus, deviceCfgs) {
  if (!packet || packet.from == null) return null;

  // A REPLAY MUST NEVER BE STAMPED WITH TODAY'S ANTENNA POSITION. Re-ingesting
  // July's packets would otherwise manufacture bearings that were never
  // measured — fabricating precisely the data this exists to start collecting.
  if (replay) return null;

  const hops = packet.hop_start != null
    ? Math.max(0, packet.hop_start - (packet.hop_limit ?? 0))
    : null;

  return {
    ts,
    kind: 'reception',
    entity: String(packet.from),
    source: device ?? null,
    data: {
      rx_device: device ?? null,
      az:        antennaBearing(device, rotatorStatus, deviceCfgs),
      beam_deg:  beamwidth(device, deviceCfgs),
      rssi:      num(packet.rx_rssi),
      snr:       num(packet.rx_snr),
      hops,
      portnum:   packet.decoded?.portnum ?? null,
      packet_id: packet.id ?? null,
    },
  };
}

/** Where the antenna was pointing when this packet arrived, or NULL.
 *
 *  NULL, NEVER 0. North is a real bearing; a wrong one is indistinguishable
 *  from a measurement once it is stored. Same class of mistake as B41 (fmtAgo
 *  clamping a future instant to "0s ago") and as the bytes-0-vs-null error
 *  services corrected on /history: a plausible wrong value is worse than an
 *  absent one, because nothing downstream can tell it apart.
 *
 *  Null unless ALL of these hold:
 *    - the radio is a rotator AND directional (beam < 360). Read from the
 *      stored per-device profile, never a hardcoded MAC — an omnidirectional
 *      antenna's "bearing" is noise, and storing it invites someone to average
 *      the two radios later.
 *    - the rotator is SETTLED. A bearing taken mid-slew is a smear across
 *      however far it travelled, not a measurement.
 *    - an azimuth is actually present.
 *
 *  `held` IS DELIBERATELY NOT A DISQUALIFIER, and this needs saying because it
 *  reads like an oversight. The rotator has TWO users — node-dash and the garage
 *  alarm — and the alarm periodically points the yagi somewhere and holds it
 *  (Peter, 2026-08-02). A held antenna is stationary at a known azimuth, so
 *  every packet heard during that hold carries a perfectly good bearing. It is
 *  only *commanding* that is blocked while held, not measuring.
 *
 *  That is a gift rather than an obstacle: the alarm moving the antenna for its
 *  own reasons donates azimuth diversity we did not have to ask for, and azimuth
 *  diversity is the entire input the bearing estimator is missing (B54 — 305
 *  bearings spanning two degrees, because nothing has moved it).
 *
 *  NOTE FOR WHOEVER WRITES THE ESTIMATOR: this is not a bearing to the node. A
 *  yagi's front-to-back ratio means a strong nearby node is heard whichever way
 *  it faces — measured errors up to 108° on known-position nodes. The signal
 *  lives in MARGINAL receptions near the noise floor, and the usable statistic
 *  is the azimuth at which RSSI PEAKS across a sweep. See MESH_REACH_SPEC §7c.
 */
export function antennaBearing(device, rotatorStatus, deviceCfgs) {
  const cfg = deviceCfgs?.[device];
  if (!cfg?.is_rotator) return null;
  if (!(cfg.beam_deg > 0 && cfg.beam_deg < 360)) return null;
  if (!rotatorStatus) return null;
  if (rotatorStatus.moving || rotatorStatus.busy) return null;
  return num(rotatorStatus.az);
}

/** The receiving antenna's beamwidth, or null. Stored alongside the bearing so
 *  a later estimator knows how wide the wedge was WITHOUT having to trust that
 *  today's config matches the day the packet arrived. Configuration drifts;
 *  observations do not. */
export function beamwidth(device, deviceCfgs) {
  const b = deviceCfgs?.[device]?.beam_deg;
  return (typeof b === 'number' && b > 0 && b < 360) ? b : null;
}

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
