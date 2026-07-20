// The single derivation rule for a node's client_role — node-dash's own answer to
// "is this node OURS (a custom/PAC node) and what kind", distinct from the
// Meshtastic `role` (how it behaves on the mesh). CORE node data: stored in the DB
// and carried in the node WS feed; plugins/custom-node surfaces consume it but
// never re-derive it. See docs/modules/client-role.md.
//
// Custom types can't be Meshtastic roles (DeviceConfig.Role is a closed protobuf
// enum), so this is our own field. Interim: our alarm nodes repurpose the SENSOR
// role, so SENSOR is the marker. When the firmware declares a real type (PAC_ALARM)
// over our protocol, only this module + the DB generated column change.

// MT roles that currently mark our custom nodes.
export const OUR_ROLES = ['SENSOR'];

// → the role string when it is one of ours, else null (a regular public node).
export function clientRole(role) {
  return OUR_ROLES.includes(role) ? role : null;
}
