// Browser-facing trigger for a chunked payload fetch (JPEG etc.) off a mesh node,
// via the optional mt-transport plugin. This module is the TRIGGER + PROGRESS half
// only: mt-transport's Client does the mesh work and stores the image itself, so
// nothing here writes files or decodes frames. See docs/modules/chunk-api.md.

import { Router } from 'express';
import path from 'path';
import fs from 'fs';
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

// The device's command grammar is `@<4-hex-suffix> <verb>` — the SAME addressing the
// command route uses (command-api.js hexSuffix). The Client prefixes '@' to whatever
// target it is given, so passing a full node id produced `@!8cee336b chunk info 1`,
// which the device silently ignores. Evidence: 155 `@336b …` commands were answered;
// 18 `@!8cee336b …` were not answered once.
const hexSuffix = (num) => (Number(num) >>> 0).toString(16).padStart(8, '0').slice(-4);

// The browser must never derive the image's path: assembling it there is the browser
// deciding state, and GETting a listing breaks the WS-only transport rule. So the
// server resolves it and pushes the URL on chunk_done (BROWSER_CONTRACT).
//
// LAYOUT-AGNOSTIC on purpose. chunkFetch returns the buffer only — no path — and the
// Client's PayloadStore names the file. mt-transport documents
// <payloadDir>/<node>/<when>_pid<N>.jpg, but that has never been observed here, so we
// find the newest file written since the fetch began rather than build a filename from
// an unverified claim. 2 s slack covers clock/mtime granularity.
function _newestPayloadSince(sinceMs) {
  const cutoff = sinceMs - 2000;
  let best = null;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs >= cutoff && (!best || st.mtimeMs > best.mtimeMs)) {
        best = { abs: p, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(PAYLOAD_DIR);
  if (!best) return { url: null, file: null };
  const rel = path.relative(PAYLOAD_DIR, best.abs);
  // Escape each segment; the separator stays a real '/' so the static mount resolves it.
  const url = '/chunk-images/' + rel.split(path.sep).map(encodeURIComponent).join('/');
  return { url, file: path.basename(best.abs) };
}

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

  const target = hexSuffix(num);
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
      // No `batch`: under push the device streams at its own pace, so there is no
      // client batch size. mt-transport spec'd onProgress as {received, count,
      // elapsedMs} (specs/chunk-push.md §4b, citing this line). Keeping it would emit
      // `batch: undefined` to every browser once push lands.
      onProgress: ({ received, count, elapsedMs }) =>
        broadcastChunkProgress({ type: 'chunk_progress', num, pid, received, count, elapsedMs, state: 'running' }),
    });
    if (r && r.ok === false) throw new Error(r.error || 'fetch failed');
    const bytes = r?.value?.length ?? null;
    // Server-owned location — the browser renders this, never builds it.
    const { url, file } = _newestPayloadSince(startedAt);
    broadcastChunkProgress({ type: 'chunk_done', num, pid, bytes, url, file, elapsedMs: Date.now() - startedAt });
    if (!url) {
      log.warn('chunk', `stored image not found under ${PAYLOAD_DIR} for node ${num} pid ${pid} — viewer will show "location unknown"`);
    }
    log.info('chunk', `fetch ok node ${num} pid ${pid} via ${gatewayNodeId} ch${ch.channel} (${bytes ?? '?'} B)${file ? ` -> ${file}` : ''}`);
  } catch (e) {
    broadcastChunkProgress({ type: 'chunk_error', num, pid, error: e.message });
    log.warn('chunk', `fetch failed node ${num} pid ${pid}: ${e.message}`);
  } finally {
    _inFlight = null;
  }
});

export default router;
