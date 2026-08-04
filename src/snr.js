// snr — Meshtastic quarter-dB decoding. BACKEND ONLY.
//
// Deliberately its OWN module and deliberately NOT in utils.js. utils.js is
// served to the browser verbatim as `GET /utils.js`, so putting the wire format
// there would ship Meshtastic protocol knowledge straight back into the
// presentation layer — the same violation by a different route.
//
// Peter, 2026-08-04, on finding the decoder in public/app-helpers.js: "that is a
// blant violation of the UI rule", then on the first fix attempt: "but this is
// supposed to be a stand alone module and NOT mixed in with core?" Both correct.
//
// CLAUDE.md, Domain 2: the browser "does not know that mesh-gw exists. Zero gw
// API knowledge." A quarter-dB scaling factor and an INT8_MIN sentinel are gw
// API knowledge.
//
// THE WIRE (meshtastic/protobufs, mesh.proto, RouteDiscovery):
//   repeated int32 snr_towards = 2;  // The list of SNRs (in dB, scaled by 4)
//   repeated int32 snr_back    = 4;  // ditto
//
// -128 is INT8_MIN, written when the firmware could not measure that hop.
// Decoded it reads -32 dB, below LoRa's demodulation floor, so it cannot be a
// measurement and must become null — null meaning "not measured", which is not
// zero.
//
// WHERE THIS IS APPLIED: at the EMIT boundary, never at storage. The store keeps
// RAW wire units because that is what the wire said; the browser is handed dB
// and decides nothing.

/** The unmeasured-hop sentinel, named so it is not a bare magic number. */
export const SNR_UNKNOWN = -128;

/** One wire value to dB, or null when it was never measured. */
export function snrDb(raw) {
  if (raw == null) return null;
  // Range test rather than === SNR_UNKNOWN: nothing this low can be a real
  // reading either way, and it survives a neighbouring sentinel being added.
  if (raw <= -127) return null;
  return raw / 4;
}

/** A whole snr_towards / snr_back array. A non-array yields [], so a missing
 *  field and an empty one behave identically downstream. */
export function snrDbList(arr) {
  return Array.isArray(arr) ? arr.map(snrDb) : [];
}
