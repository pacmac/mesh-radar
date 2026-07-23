// Browser-facing endpoint for the settings SSOT.
//
// Wires saveNodeSetting() to a real transmitter: the send closure POSTs a text
// message via the gateway, and the channel is resolved BY NAME from that
// gateway's own channel list (Private only — index 0 is refused by
// resolveCommandChannel, per NODE_SETTINGS_SSOT_SPEC).
//
// The response reports what the DEVICE said. It is not the source of truth for
// the displayed value: that keeps coming from the device's type:config
// re-broadcast, cached in node_app_state.
import { Router } from 'express';
import { saveNodeSetting } from './node-settings.js';
import { getDeviceChannelsByNodeId } from './ws-relay.js';
import { resolvePrimaryNodeId } from './device-config.js';
import { sendMeshText } from './mesh-send.js';
const router = Router();

router.put('/nodes/:num/settings', async (req, res) => {
  const num = Number(req.params.num);
  const { path: settingPath, value } = req.body ?? {};
  if (!Number.isFinite(num) || !settingPath) {
    return res.status(400).json({ error: 'num and path are required' });
  }

  const gatewayNodeId = resolvePrimaryNodeId();
  if (!gatewayNodeId) {
    return res.status(503).json({ state: 'invalid', error: 'no gateway radio available to send from' });
  }
  const gatewayChannels = getDeviceChannelsByNodeId(gatewayNodeId);

  const result = await saveNodeSetting({
    num, path: settingPath, value, gatewayNodeId, gatewayChannels,
    // Addressed device command — recorded as 'command' via the shared send path.
    send: async ({ text, channel }) =>
      sendMeshText({ gatewayNodeId, text, channel, category: 'command' }),
  });

  // invalid  -> 400 (never transmitted)
  // rejected -> 409 (device said no)
  // no_reply -> 504 (silence is not success)
  const code = result.ok ? 200
    : result.state === 'invalid'  ? 400
    : result.state === 'rejected' ? 409
    : 504;
  res.status(code).json(result);
});

export default router;
