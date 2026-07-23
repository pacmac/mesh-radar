// The single derivation rule for a node's client_role — node-dash's own answer to
// "is this node OURS (a custom/PAC node) and what kind", distinct from the
// Meshtastic `role` (how it behaves on the mesh). CORE node data: stored in the DB
// and carried in the node WS feed; plugins/custom-node surfaces consume it but
// never re-derive it. See docs/modules/client-role.md.
//
// Our alarm firmware (pac-garage-alarm 260720-2+) DECLARES itself: it sets
// user.role = 200 (PAC_ALARM) in NodeInfo — a private value in a reserved PAC range
// 200-255, clear of upstream's 0..12. DeviceConfig.Role is NOT a closed enum; it is
// extended upstream, and mt-transport owns both the firmware and its protobuf, so a
// private value is legitimate.
//
// The gw cannot map a private value to an enum name, so it arrives as a
// FLOAT-FORMATTED NUMERIC STRING — role === "200.0" (verified on live data), not
// "200" and not a name. Hence the numeric parse below.

// The declared role our alarm firmware advertises.
export const PAC_ALARM_ROLE = 200;

// Pre-260720-2 alarm units still report SENSOR. Kept so upgrading firmware doesn't
// silently unflag a real alarm unit. RETIRE once every alarm runs 260720-2+ — it
// carries a false-positive risk (a stock node may legitimately be SENSOR) that the
// declared role does not.
export const LEGACY_OUR_ROLES = ['SENSOR'];

// → 'PAC_ALARM' for one of ours, else null (a regular public node).
export function clientRole(role) {
  if (role == null || role === '') return null;
  if (Number(role) === PAC_ALARM_ROLE) return 'PAC_ALARM';   // declared — reliable
  if (LEGACY_OUR_ROLES.includes(role)) return 'PAC_ALARM';   // legacy firmware
  return null;
}
