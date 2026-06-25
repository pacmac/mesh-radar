import { nodeList } from './node-list.js';
import { getAllDeviceCfgs } from './device-config.js';

// Resolve the display label for a node num using the 3-step rule:
//   1. label (user alias) from device_configs
//   2. short_name from the mesh node cache
//   3. ?xxxx — last 4 hex chars of the node ID, unknown prefix
export function resolveNodeLabel(num) {
  if (num == null) return null;
  const hex    = (num >>> 0).toString(16);
  const nodeId = '!' + hex;

  const cfgs = getAllDeviceCfgs();
  if (cfgs[nodeId]?.label) return cfgs[nodeId].label;

  const cached = nodeList._cache.get(num);
  if (cached?.user?.short_name) return cached.user.short_name;

  return '?' + hex.slice(-3).toUpperCase();
}

// Convenience: takes a node_id string like "!fa39f7b4".
export function resolveDeviceLabel(nodeId) {
  if (!nodeId) return null;
  const num = parseInt(nodeId.replace('!', ''), 16);
  return isNaN(num) ? nodeId : resolveNodeLabel(num);
}
