import { nodeList } from './node-list.js';
import { getAllDeviceCfgs } from './device-config.js';
import { stmts } from './db.js';

function getNodeinfoShortName(num) {
  try { return stmts.getNodeinfoByNum.get(num)?.short_name ?? null; }
  catch { return null; }
}

let _nodeIdToMac = null;
export function registerMacResolver(fn) { _nodeIdToMac = fn; }

let _macToNodeId = null;
export function registerNodeIdResolver(fn) { _macToNodeId = fn; }

// Resolve the display label for a node num using the 3-step rule:
//   1. label (user alias) from device_configs — resolved via live MAC lookup
//   2. short_name from the mesh node cache
//   3. ?xxxx — last 4 hex chars of the node ID, unknown prefix
export function resolveNodeLabel(num) {
  if (num == null) return null;
  const hex    = (num >>> 0).toString(16).padStart(8, '0');
  const nodeId = '!' + hex;

  const mac = _nodeIdToMac?.(nodeId);
  if (mac) {
    const cfg = getAllDeviceCfgs()[mac];
    if (cfg?.label) return cfg.label;
  }

  const cached = nodeList._cache.get(num);
  if (cached?.user?.short_name) return cached.user.short_name;

  // Persistent nodeinfo survives cache wipes (restarts, scans) — without
  // this, labels degrade to ?xxx whenever the in-memory cache is sparse
  const stored = getNodeinfoShortName(num);
  if (stored) return stored;

  return '?' + hex.slice(-3).toUpperCase();
}

// Convenience: takes a node_id ('!fa39f7b4') OR a BLE MAC. A MAC is never
// parseInt'd — parseInt('E9:…',16) = 233 produced garbage labels for every
// range-test rx_name (identity-phase-a B5).
export function resolveDeviceLabel(key) {
  if (!key) return null;
  let nodeId = String(key);
  if (nodeId.includes(':')) {
    const mac = nodeId.toUpperCase();
    const cfg = getAllDeviceCfgs()[mac];
    if (cfg?.label) return cfg.label;          // device alias directly by MAC
    nodeId = _macToNodeId?.(mac) ?? null;
    if (!nodeId) return mac;                   // honest fallback: the MAC itself
  }
  const num = parseInt(nodeId.replace('!', ''), 16);
  return isNaN(num) ? nodeId : resolveNodeLabel(num);
}
