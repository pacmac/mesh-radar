// Browser-facing trigger for a chunked payload fetch (JPEG etc.) off a mesh node,
// via the optional mt-transport plugin. This module is the TRIGGER + PROGRESS half
// only: mt-transport's Client does the mesh work and stores the image itself, so
// nothing here writes files or decodes frames. See docs/modules/chunk-api.md.

import { Router } from 'express';
import path from 'path';
import { transport } from './transport-plugin.js';
import { resolvePrimaryNodeId } from './device-config.js';
import { resolveCommandChannel } from './node-settings.js';
import { getDeviceChannelsByNodeId, broadcastChunkProgress } from './ws-relay.js';
import { log } from './log.js';

const router = Router();

const PORT = process.env.PORT || 8000;
const HOST = `localhost:${PORT}`;          // the Client loopbacks through us
const DEADLINE_MS = 240000;                // mt-transport's suggested hard wall

// node-dash owns the storage location (not the Client's cwd-relative ./payloads).
export const PAYLOAD_DIR = path.join(process.cwd(), 'data', 'payloads');

// Exactly one transfer at a time — the mesh channel is shared with the alarm's own
// traffic and every node. A second request is refused, never queued.
let _inFlight = null;   // { num, pid } | null

const numToNodeId = (num) => '!' + ((num >>> 0).toString(16).padStart(8, '0'));

// POST /nodes/:num/chunk-fetch  { pid }
// The browser sends only num + pid. The gateway and the channel are SERVER
// decisions (BROWSER_CONTRACT) — channel is resolved BY NAME to Private, never a
// number, never primary.
router.post('/nodes/:num/chunk-fetch', async (req, res) => {
  const num = Number(req.params.num);
  const pid = Number(req.body?.pid);
  if (!Number.isInteger(num) || !Number.isInteger(pid)) {
    return res.status(400).json({ error: 'num and integer pid required' });
  }

  const t = transport();
  if (!t.can('chunkFetch')) {
    return res.status(503).json({ error: 'chunk transport not available on this box' });
  }
  if (_inFlight) {
    return res.status(409).json({ error: `a fetch is already in flight (node ${_inFlight.num}, pid ${_inFlight.pid})` });
  }

  const gatewayNodeId = resolvePrimaryNodeId();
  if (!gatewayNodeId) return res.status(503).json({ error: 'no gateway radio available to send from' });

  // Reused resolver (align + node-settings): finds the channel NAMED "Private" on
  // this gateway and returns its index, refusing index 0. Never PRIMARY.
  const ch = resolveCommandChannel(getDeviceChannelsByNodeId(gatewayNodeId));
  if (!ch.ok) return res.status(409).json({ error: ch.error });

  const target = numToNodeId(num);
  _inFlight = { num, pid };
  const startedAt = Date.now();
  broadcastChunkProgress({ type: 'chunk_progress', num, pid, received: 0, count: null, state: 'started' });

  // Respond immediately — a transfer is minutes long. Everything after this reaches
  // the browser over the WS, never a polled HTTP response.
  res.status(202).json({ ok: true, state: 'started', num, pid });

  try {
    const r = await t.chunkFetch({
      target,
      pid,
      channel: ch.channel,
      host: HOST,
      gatewayId: gatewayNodeId,
      deadlineMs: DEADLINE_MS,
      payloadDir: PAYLOAD_DIR,
      onProgress: ({ received, count, batch, elapsedMs }) =>
        broadcastChunkProgress({ type: 'chunk_progress', num, pid, received, count, batch, elapsedMs, state: 'running' }),
    });
    if (r && r.ok === false) throw new Error(r.error || 'fetch failed');
    const bytes = r?.value?.length ?? null;
    broadcastChunkProgress({ type: 'chunk_done', num, pid, bytes, elapsedMs: Date.now() - startedAt });
    log.info('chunk', `fetch ok node ${num} pid ${pid} via ${gatewayNodeId} ch${ch.channel} (${bytes ?? '?'} B)`);
  } catch (e) {
    broadcastChunkProgress({ type: 'chunk_error', num, pid, error: e.message });
    log.warn('chunk', `fetch failed node ${num} pid ${pid}: ${e.message}`);
  } finally {
    _inFlight = null;
  }
});

export default router;
