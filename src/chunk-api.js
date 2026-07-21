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
import { getDeviceChannelsByNodeId, broadcastChunkProgress, setChunkImagesProvider, broadcastChunkImages } from './ws-relay.js';
import { sendMeshText } from './mesh-send.js';
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
function _ageText(mtimeMs) {
  const mins = Math.round((Date.now() - mtimeMs) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`;
}

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
      const href = '/chunk-images/' + relPath.split('/').map(encodeURIComponent).join('/');
      out.push({
        // A `.part` GROWS while the transfer runs, so the URL must change or the browser
        // renders its cached copy forever. Versioned server-side by mtime — the browser
        // must not be assembling URLs (BROWSER_CONTRACT).
        url: partial ? `${href}?t=${Math.round(st.mtimeMs)}` : href,
        name: e.name,
        node: rel || null,
        bytes: st.size,
        modified: new Date(st.mtimeMs).toISOString(),
        partial,
        have, count, pct,
        // No '?' placeholder: push writes to the payload ROOT (no node directory), so
        // `rel` is legitimately empty and printing '?' invented an unknown that isn't one.
        // Age matters more than the path here — a leftover partial from hours ago must not
        // read like a live one.
        caption: [
          rel || null,
          e.name,
          // "abandoned" only if it is NOT the transfer currently running. The server
          // knows which via _inFlight; calling a live, filling file abandoned was simply
          // wrong, and the browser must not be the one deciding.
          partial
            ? `incomplete${pct != null ? ` ${have}/${count} chunks (${pct}%)` : ''} · ${
                _inFlight && new RegExp(`(^|[^0-9])${_inFlight.pid}([^0-9]|$)`).test(e.name)
                  ? 'receiving now' : `abandoned ${_ageText(st.mtimeMs)}`}`
            : `${st.size} bytes · fetched ${_ageText(st.mtimeMs)}`,
        ].filter(Boolean).join(' · '),
      });
    }
  };
  walk(PAYLOAD_DIR, '');
  return out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
}
setChunkImagesProvider(listStoredPayloads);

// Exactly one transfer at a time — the mesh channel is shared with the alarm's own
// traffic and every node. A second request is refused, never queued.
let _inFlight = null;   // { num, pid, abort } | null

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
    // ABORT, do not merely announce. Reporting the refusal while the client kept
    // retrying START produced a 10-minute loop: ~2 frames on air every 30 s, the page
    // showing an error over a transfer that was still running. A reporter is not a
    // handler. `signal` is mt-transport's supported cancellation (Client 1.1.0).
    const held = msg.cnt ? ` — it holds a different payload (${msg.cnt} chunks)` : '';
    const detail = `device refused pid ${_inFlight.pid}${held}. Use "push stat" to see which pid it has, then fetch that.`;
    log.warn('chunk', `${detail} [node ${_inFlight.num}] — aborting`);
    try { _inFlight.abort?.abort(); } catch (e) { log.warn('chunk', `abort failed: ${e.message}`); }
    broadcastChunkProgress({ type: 'chunk_error', num: _inFlight.num, pid: _inFlight.pid, error: detail });
  }
}

// Every stored partial belonging to a pid, across BOTH layouts — push writes
// `pid-<N>.jpg.part` at the root, pull wrote `<node>/pid<N>.part` with a `.json` sidecar,
// and mt-transport has flagged the push path as not yet stable. So match on the filename
// containing the pid and ending `.part`, never on a fixed path.
function _partialsForPid(pid) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!/\.part(\.json)?$/.test(e.name)) continue;
      if (!new RegExp(`(^|[^0-9])${pid}([^0-9]|$)`).test(e.name)) continue;
      out.push(abs);
    }
  };
  walk(PAYLOAD_DIR);
  return out;
}

// POST /nodes/:num/chunk-fetch  { pid }
// The browser sends only num + pid. The gateway and the channel are SERVER
// decisions (BROWSER_CONTRACT) — channel is resolved BY NAME to Private, never a
// number, never primary.
router.post('/nodes/:num/chunk-fetch', async (req, res) => {
  const num = Number(req.params.num);
  // pid is OPTIONAL now: omit it and the device's own published pid is used.
  let pid = req.body?.pid == null || req.body.pid === '' ? null : Number(req.body.pid);
  if (!Number.isInteger(num) || (pid !== null && !Number.isInteger(pid))) {
    return res.status(400).json({ error: 'num required; pid optional (integer)' });
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

  // ASK THE DEVICE WHAT IT HOLDS, rather than assuming a pid.
  //
  // Hardcoding pid 1 caused a 10-minute retry loop: the device had superseded it with a
  // fresh camera capture (pid 55366), refused every START, and the client kept trying.
  // One `push stat` round-trip removes the guess. Safe here — the no-polling rule is
  // about control traffic landing mid-stream (upst=2), and nobody presses Start then.
  //
  // NO SUBSTITUTION. If the caller named a pid the device does not hold, that is reported,
  // not quietly swapped: fetching a different payload than the one requested is a wrong
  // answer that looks right.
  let avail = null;
  if (t.can('pushAvailable')) {
    try {
      const a = await t.pushAvailable({ target, channel: ch.channel, host: HOST,
                                        gatewayId: gatewayNodeId, payloadDir: PAYLOAD_DIR });
      avail = a?.value ?? null;
    } catch (e) {
      log.warn('chunk', `pushAvailable failed (${e.message}) — proceeding with the requested pid`);
    }
  }
  if (avail && avail.ready === false) {
    _inFlight = null;
    return res.status(409).json({
      error: `device has nothing published (upst=${avail.state}, badStarts=${avail.badStarts ?? '?'}). Press Publish first.`,
      available: avail,
    });
  }
  if (avail && avail.ready && pid && avail.pid && Number(pid) !== Number(avail.pid)) {
    _inFlight = null;
    return res.status(409).json({
      error: `device holds pid ${avail.pid} (${avail.chunks} chunks), not pid ${pid}. Fetch ${avail.pid}, or Publish to replace it.`,
      available: avail,
    });
  }
  // No pid asked for: take the device's own.
  if (avail && avail.ready && !pid) pid = Number(avail.pid);

  // Clear any ABANDONED partial for this pid before starting. A .part left by a failed
  // transfer cannot be resumed across a restart — the receiver's chunk map lives in the
  // client's memory, and repair is driven from that, not from the file — so it is dead
  // weight that was being announced to every new session as though it were live. Peter
  // opened a fresh session hours later and was still shown "pid-1.jpg.part · incomplete".
  //
  // Cleared HERE rather than on failure, deliberately: immediately after a failure the
  // partial is genuinely useful (it renders as half a picture, which is how the 16/32
  // stall was diagnosed). It only becomes clutter once superseded, and starting a new
  // transfer for the same pid is exactly that moment.
  for (const stale of _partialsForPid(pid)) {
    try { fs.unlinkSync(stale); log.info('chunk', `cleared abandoned partial ${path.basename(stale)}`); }
    catch (e) { log.warn('chunk', `could not clear ${stale}: ${e.message}`); }
  }

  // Tell every browser the listing changed. Clearing the old partial above was
  // invisible otherwise: chunk_images is only pushed on connect and after a terminal
  // event, so a page kept rendering the deleted partial — "abandoned 18 min ago" —
  // while a fresh transfer was already running.
  broadcastChunkImages();

  const _ac = new AbortController();
  _inFlight = { num, pid, abort: _ac };
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
    let r = await t.chunkPush({
      target,
      pid,
      channel: ch.channel,
      host: HOST,
      gatewayId: gatewayNodeId,
      deadlineMs: DEADLINE_MS,
      payloadDir: PAYLOAD_DIR,
      signal: _ac.signal,          // a refusal aborts; see notePushReply
      // No `batch`: under push the device streams at its own pace, so there is no
      // client batch size. mt-transport spec'd onProgress as {received, count,
      // elapsedMs} (specs/chunk-push.md §4b, citing this line). Keeping it would emit
      // `batch: undefined` to every browser once push lands.
      onProgress: ({ received, count, elapsedMs }) =>
        broadcastChunkProgress({ type: 'chunk_progress', num, pid, received, count, elapsedMs, state: 'running' }),
    });
    // AUTO-RECOVER FROM upst=0, ONCE. COMPLETE releases the device's buffer, so the
    // transfer AFTER a successful one is always refused until the payload is
    // republished — a permanent two-step (Publish, then Start) for the common case.
    //
    // Publishing blindly was withdrawn earlier because it is unsafe at upst=2 (resets the
    // cursor under a running stream) and wasteful at upst=3 (discards a finished pass).
    // This is not that: mt-transport's fail-fast reports the STATE, and `upst=0` is
    // unambiguous — nothing pending, nothing sending, nothing held. Publishing is safe
    // precisely and only in the state the device has just named.
    //
    // Strictly once. If the republish does not take, the second failure is reported as-is
    // rather than retried into a loop that puts frames on air indefinitely.
    if (r && r.ok === false && /upst=0/.test(r.error || '')) {
      log.info('chunk', `device reports upst=0 — republishing pid ${pid} and retrying once`);
      broadcastChunkProgress({ type: 'chunk_progress', num, pid, received: 0, count: null, state: 'started' });
      await sendMeshText({ gatewayNodeId, text: `@${target} push pub`, channel: ch.channel, category: 'command' });
      await new Promise(res2 => setTimeout(res2, 5000));
      r = await t.chunkPush({
        target, pid, channel: ch.channel, host: HOST, gatewayId: gatewayNodeId,
        deadlineMs: DEADLINE_MS, payloadDir: PAYLOAD_DIR, signal: _ac.signal,
        onProgress: ({ received, count, elapsedMs }) =>
          broadcastChunkProgress({ type: 'chunk_progress', num, pid, received, count, elapsedMs, state: 'running' }),
      });
    }

    if (r && r.ok === false) throw new Error(r.error || 'fetch failed');
    const bytes = r?.value?.length ?? null;

    // PERSIST THE BYTES OURSELVES. `Client.push()` resolves with VERIFIED bytes but does
    // NOT write them — only `fetchAndSave()` calls store.save(). Under pull the client
    // stored the image, so this route was written to just locate the file afterwards;
    // that assumption silently stopped holding at the protocol switch and a completed
    // 7156-byte transfer was discarded, leaving the viewer to report "location unknown"
    // for an image that had arrived intact.
    //
    // Written before the terminal broadcast so the listing that follows includes it.
    if (Buffer.isBuffer(r?.value) && r.value.length) {
      try {
        const dir = path.join(PAYLOAD_DIR, target);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `pid-${pid}.jpg`), r.value);
        log.info('chunk', `saved ${r.value.length} B to ${target}/pid-${pid}.jpg`);
      } catch (e) {
        log.warn('chunk', `could not save payload: ${e.message}`);
      }
    }

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
