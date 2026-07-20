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
import { getDeviceChannelsByNodeId, broadcastChunkProgress, setChunkImagesProvider } from './ws-relay.js';
import { log } from './log.js';

const router = Router();

const PORT = process.env.PORT || 8000;
const HOST = `localhost:${PORT}`;          // the Client loopbacks through us
// 240 s was too tight and killed a transfer at 31/32. mt-transport's verified CLEAN run
// is 222 s, so that left 18 s of headroom — and with ~17% loss as the EXPECTED operating
// condition, any transfer needing a repair round cannot finish inside it. Their client's
// own default is 600 s; match it rather than impose a wall shorter than the work.
// The tail is ~90 s of the 222 s today (the receiver waits out an idle timer instead of
// acting on {cursor, done}); when mt-transport lands that, runs get shorter, not longer.
const DEADLINE_MS = 600000;

// node-dash owns the storage location (not the Client's cwd-relative ./payloads).
export const PAYLOAD_DIR = path.join(process.cwd(), 'data', 'payloads');

// Everything on disk under PAYLOAD_DIR, described for the browser. Finished images AND
// resumable partials: the Client preallocates `<name>.part` to the full length and keeps
// `<name>.part.json` beside it recording {pid, crc, count, len, have[]}.
//
// A partial is genuinely useful, not debris: chunks arrive in order from 0, so the
// non-zero prefix is a VALID TRUNCATED JPEG that a browser renders (verified — a
// truncated baseline JPEG draws its prefix). A stall at 16/32 is half a picture, not
// nothing.
//
// Everything here is computed server-side (URL, caption, percentage) — the browser
// renders it and decides nothing (BROWSER_CONTRACT).
function listStoredPayloads() {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(abs, relPath); continue; }
      if (e.name.endsWith('.json')) continue;               // sidecar, not a payload
      let st; try { st = fs.statSync(abs); } catch { continue; }

      const partial = e.name.endsWith('.part');
      let have = null, count = null, pct = null;
      if (partial) {
        try {
          const meta = JSON.parse(fs.readFileSync(`${abs}.json`, 'utf8'));
          have  = Array.isArray(meta.have) ? meta.have.length : null;
          count = meta.count ?? null;
          if (have != null && count) pct = Math.round((have / count) * 100);
        } catch { /* no sidecar — still listable, just without progress */ }
      }
      out.push({
        url: '/chunk-images/' + relPath.split('/').map(encodeURIComponent).join('/'),
        name: e.name,
        node: rel || null,
        bytes: st.size,
        modified: new Date(st.mtimeMs).toISOString(),
        partial,
        have, count, pct,
        caption: partial
          ? `${rel || '?'} · ${e.name} · incomplete${pct != null ? ` ${have}/${count} chunks (${pct}%)` : ''}`
          : `${rel || '?'} · ${e.name} · ${st.size} bytes`,
      });
    }
  };
  walk(PAYLOAD_DIR, '');
  return out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
}
setChunkImagesProvider(listStoredPayloads);

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
// LAYOUT-AGNOSTIC on purpose. chunkPush returns the buffer only — no path — and the
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

// The device answers a START in text on the command channel. `{"start":N,"ok":0}` is a
// REFUSAL — it will not send this pid — and mt-transport's client retries the START
// rather than failing fast, so without this the browser shows a blank progress bar while
// the device says "no" every 35 seconds. A flat refusal must not look like a dead radio.
//
// Read-only observation of a reply we already receive; it transmits nothing.
export function notePushReply(fromNum, text) {
  if (!_inFlight || !text || !text.startsWith('{')) return;
  if (Number(fromNum) !== Number(_inFlight.num)) return;   // a different node's reply
  let msg; try { msg = JSON.parse(text); } catch { return; }
  if (msg?.type !== 'push' || msg.start === undefined) return;
  if (msg.ok === 0 || msg.ok === false) {
    const detail = `device refused the transfer (start ok:0, cnt:${msg.cnt ?? '?'}) — it will not send pid ${_inFlight.pid}`;
    log.warn('chunk', `${detail} [node ${_inFlight.num}]`);
    broadcastChunkProgress({ type: 'chunk_error', num: _inFlight.num, pid: _inFlight.pid, error: detail });
  }
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
  if (!t.can('chunkPush')) {
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
    // NO automatic publish here — deliberately, after mt-transport pushed back.
    // An UNCONDITIONAL `push pub` is unsafe: at upst=3 the device is holding a
    // completed pass and publishing discards it, re-sending 32 chunks at ~2 s of
    // airtime each; at upst=2 it resets the cursor UNDER A RUNNING STREAM — and that
    // stream may be mt-transport's, which our one-in-flight guard cannot see.
    //
    // The decision needs `upst`, which means asking the device, and `Client.push()`
    // already calls `push stat` for its adoption decision. So publishing belongs
    // THERE — one place that decides, rather than two that are each correct alone and
    // combine badly. mt-transport is implementing it.
    //
    // Meanwhile a refused START is no longer silent (notePushReply), and the page
    // offers an explicit Publish control so the operator can stage deliberately.
    // PUSH only. Pull was removed entirely — its follow-up requests were the failure
    // (stall at 16/32, the device never received the pull for first=16).
    const r = await t.chunkPush({
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
