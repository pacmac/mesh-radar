import { nodeList } from './node-list.js';
import { handleEvent } from './persist.js';
import { getPrimaryMac, getDeviceCfg, getAllDeviceCfgs } from './device-config.js';
import { getLiveNodeIdByMac } from './ws-relay.js';
import { stmts } from './db.js';

export function registerStartupHandlers(bridge) {
  bridge.on('connected', async () => {
    const primaryMac = getPrimaryMac();
    const cfg = primaryMac ? getDeviceCfg(primaryMac) : {};

    try {
      const allResp = await bridge.get('/nodes');
      const allNodes = Object.values(allResp?.nodes ?? {});
      nodeList.seed(allNodes, null);
      nodeList.restoreDeviceAttribution(stmts.getNodeDevices.all());
      // Device configs are MAC-keyed; resolve each MAC to its node num via
      // the live registry (seeded from persisted node_mac.* at module load).
      // The old startsWith('!') guard matched nothing once configs became
      // MAC-keyed — this loop was dead (identity-phase-a B10).
      const allDeviceCfgs = getAllDeviceCfgs();
      for (const mac of Object.keys(allDeviceCfgs)) {
        if (!mac.includes(':')) continue;      // skip stale legacy !hex keys
        const nodeId = getLiveNodeIdByMac(mac);
        if (!nodeId) continue;
        const devNum = parseInt(nodeId.slice(1), 16);
        const devNode = allNodes.find(n => n.num === devNum);
        if (devNode) nodeList.seedOwnDevice(devNode, mac);
      }
      console.log(`[node-list] seeded ${allNodes.length} nodes`);
    } catch (err) {
      console.error(`[node-list] seed failed: ${err.message}`);
    }

    if (!cfg.load_nodes_on_boot) {
      console.log('[node-dash] load_nodes_on_boot=false — skipping persist seed');
      return;
    }
    try {
      const resp = await bridge.get('/nodes?named_only=true');
      const nodeMap = resp?.nodes ?? {};
      const entries = Object.values(nodeMap);
      for (const n of entries) {
        handleEvent({ type: 'node_update', data: n, device: null });
      }
      console.log(`[node-dash] seeded ${entries.length} named nodes into persist`);
    } catch (err) {
      console.error(`[node-dash] persist seed failed: ${err.message}`);
    }
  });
}
