// The capture trigger: POST /nodes/:num/capture sends `cam grab`, correlates the device
// reply by reply_id, and returns the fresh pid the device just published. It does NOT
// push — the browser fetches that pid via the existing chunk-fetch path. See
// docs/modules/capture-api.md.
//
// Thin on purpose (mt-transport): `cam grab` is an INTERIM, pre-PIR primitive; when the
// PIR pipeline lands this route rewires to the product verb set and nothing else here
// needs to move.

import { Router } from 'express';
import { sendMeshText } from './mesh-send.js';
import { resolvePrimaryNodeId } from './device-config.js';
import { resolveCommandChannel } from './node-settings.js';
import { getDeviceChannelsByNodeId } from './ws-relay.js';
import { log } from './log.js';

const router = Router();

// `cam grab` is intermittent on the bench (mt-transport's I2C/UART issue, their side), so
// 10 s then give up and let the caller retry — silence is never reported as success.
const GRAB_TIMEOUT_MS = 10000;

// Last 4 hex of the node num — the alarm's `@<suffix> <verb>` addressing grammar, the same
// path the command/settings/chunk verbs use.
const hexSuffix = (num) => (Number(num) >>> 0).toString(16).padStart(8, '0').slice(-4);

// Commands awaiting a grab reply, keyed on the SENT packet id. The device threads its
// reply by reply_id = that id (verified on the wire), the same machinery settings verbs
// use — but classified here by `type`, not by `ok`, because a grab success carries no
// `ok` field and node-settings.handleReply would misread it as rejected.
const _pendingGrab = new Map();   // sentId -> { timer, resolve }

// Classify a device reply text into one of the three grab outcomes. Pure (no map, no
// timer) so it is unit-testable without transmitting. Classified by `type`, NOT by `ok`:
// a grab success carries no `ok` field, so node-settings.handleReply would misread it.
export function classifyGrabReply(text) {
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* not our JSON envelope */ }

  if (payload?.type === 'grab' && payload.pid != null) {
    return { ok: true, state: 'captured', reply: payload };
  }
  if (payload?.type === 'err') {
    // Capture failed (camera returned no frame). NORMAL and retryable — never a pid.
    return { ok: false, state: 'capture_failed', reply: payload, error: payload.msg || 'capture failed' };
  }
  // A reply on our reply_id we do not recognise. Not a success — do not invent a pid.
  return { ok: false, state: 'capture_failed', reply: payload, error: 'unexpected reply to cam grab' };
}

// Dispatched from bridge-events for every text reply carrying a reply_id. Returns true iff
// it consumed a reply we were waiting on.
export function handleGrabReply(replyId, text) {
  if (!replyId) return false;
  const entry = _pendingGrab.get(replyId);
  if (!entry) return false;

  clearTimeout(entry.timer);
  _pendingGrab.delete(replyId);
  entry.resolve(classifyGrabReply(text));
  return true;
}

// POST /nodes/:num/capture   (no body)
// Sends `@<suffix> cam grab` on the Private channel and awaits the device's reply.
router.post('/nodes/:num/capture', async (req, res) => {
  const num = Number(req.params.num);
  if (!Number.isInteger(num)) {
    return res.status(400).json({ error: 'integer num required' });
  }

  const gatewayNodeId = resolvePrimaryNodeId();
  if (!gatewayNodeId) return res.status(503).json({ error: 'no gateway radio available to send from' });

  // The channel NAMED "Private", refusing index 0 — never a body channel, never Primary.
  const ch = resolveCommandChannel(getDeviceChannelsByNodeId(gatewayNodeId));
  if (!ch.ok) return res.status(409).json({ error: ch.error });

  const suffix = hexSuffix(num);
  const text = `@${suffix} cam grab`;

  let sent;
  try {
    sent = await sendMeshText({ gatewayNodeId, text, channel: ch.channel, category: 'command' });
  } catch (err) {
    const m = /gateway (\d+)/.exec(err.message);
    return res.status(m ? Number(m[1]) : 502).json({ error: err.message });
  }
  if (!sent?.id) return res.status(502).json({ error: 'gateway returned no packet id' });
  log.info('capture', `@${suffix} cam grab via ${gatewayNodeId} ch${ch.channel} (pkt ${sent.id})`);

  const result = await new Promise(resolve => {
    const timer = setTimeout(() => {
      _pendingGrab.delete(sent.id);
      resolve({ ok: false, state: 'no_reply', error: `no reply within ${GRAB_TIMEOUT_MS / 1000}s` });
    }, GRAB_TIMEOUT_MS);
    _pendingGrab.set(sent.id, { timer, resolve });
  });

  if (result.state === 'captured') {
    const { pid, len, n, crc } = result.reply;
    log.info('capture', `grab ok node ${num}: pid ${pid} (${len} B, ${n} chunks, crc ${crc})`);
    return res.json({ ok: true, state: 'captured', pid, len, n, crc });
  }
  if (result.state === 'capture_failed') {
    log.warn('capture', `grab failed node ${num}: ${result.error} (st ${result.reply?.st ?? '?'})`);
    return res.status(502).json({ ok: false, state: 'capture_failed', error: result.error, st: result.reply?.st ?? null });
  }
  log.warn('capture', `grab timed out node ${num}`);
  return res.status(504).json({ ok: false, state: 'no_reply', error: result.error });
});

// Test/introspection aid — how many grabs are awaiting a reply.
export function pendingGrabCount() { return _pendingGrab.size; }

export default router;
