#!/usr/bin/env node
// Read-only observer for a live chunk-push transfer. See docs/modules/push-observer.md.
//
// NEVER TRANSMITS. It subscribes to node-dash's /events exactly as a browser does and
// reports what it sees. Triggering a fetch is a separate deliberate act — the curl is
// printed below, because a transfer puts frames on air and the bench unit is shared.
//
// Design rule throughout: SILENCE IS NEVER SUCCESS. Every terminal state prints a line,
// and while idle it heartbeats what it has and hasn't seen. Three separate bugs on
// 2026-07-20 came from reading an absence as a result.

import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const HOST       = arg('--host', 'localhost:8000');
const STALL_SEC  = Number(arg('--stall-sec', 45));
const EXPECT_CRC = (arg('--expect-crc', '') || '').toLowerCase().replace(/^0x/, '');
const PAYLOAD_DIR = join(process.cwd(), 'data', 'payloads');

const t0 = Date.now();
const ts = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(`[${ts()}]`, ...a);

// ---- state ---------------------------------------------------------------
let active = null;            // {num, pid, count, received, startedAt}
let frames261 = 0;            // raw + typed frames seen for the current transfer
let lastFrameAt = 0;
let manifestSeen = false;
let tiltDuringTransfer = 0;
let stalled = false;
let exitCode = 0;
let idleTicks = 0;

// CRC32 — table-free, small; the payload is kilobytes.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

// Newest file under data/payloads — the Client writes it, we only read it back.
function newestPayload() {
  if (!existsSync(PAYLOAD_DIR)) return null;
  const out = [];
  const walk = d => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push({ p, mtime: statSync(p).mtimeMs, size: statSync(p).size });
    }
  };
  try { walk(PAYLOAD_DIR); } catch { return null; }
  return out.sort((a, b) => b.mtime - a.mtime)[0] || null;
}

function finish(kind, detail) {
  const secs = active ? ((Date.now() - active.startedAt) / 1000).toFixed(1) : '?';
  const ratio = active?.count ? (frames261 / active.count).toFixed(2) : '?';
  say(`${kind} ${detail} elapsed=${secs}s frames261=${frames261} ratio=${ratio}/chunk`);

  if (kind === 'DONE') {
    const f = newestPayload();
    if (!f) { say('VERIFY-FAIL no file under data/payloads — chunk_done claimed success'); exitCode = 1; }
    else {
      const buf = readFileSync(f.p);
      const crc = crc32(buf);
      say(`VERIFY file=${f.p} bytes=${buf.length} crc32=${crc}`);
      if (EXPECT_CRC) {
        if (crc === EXPECT_CRC) say('CRC-MATCH image is byte-correct');
        else { say(`CRC-MISMATCH expected=${EXPECT_CRC} got=${crc}`); exitCode = 1; }
      }
    }
  }
  if (tiltDuringTransfer > 0) {
    say(`TILT-GATE-VIOLATION ${tiltDuringTransfer} tilt_update event(s) fired during 261 traffic — a push frame reached the tilt decoder`);
    exitCode = 1;
  } else if (frames261 > 0) {
    say('TILT-GATE-OK no tilt_update fired during 261 traffic');
  }
  active = null; frames261 = 0; manifestSeen = false; tiltDuringTransfer = 0; stalled = false;
}

// ---- stall + idle reporting ---------------------------------------------
setInterval(() => {
  if (active && lastFrameAt && !stalled) {
    const quiet = (Date.now() - lastFrameAt) / 1000;
    if (quiet > STALL_SEC) {
      stalled = true; exitCode = 1;
      say(`STALL no 261 frame for ${quiet.toFixed(0)}s (received=${active.received}/${active.count ?? '?'}) — transfer is not progressing`);
    }
  }
  if (!active && ++idleTicks % 6 === 0) {
    say(`NO-VERDICT idle — no transfer seen yet (uptime ${((Date.now() - t0) / 60000).toFixed(0)}m). Silence here means nothing has started, not that anything passed.`);
  }
}, 10000);

// ---- the feed ------------------------------------------------------------
function connect() {
  const ws = new WebSocket(`ws://${HOST}/events`);
  ws.on('open', () => say(`observing ws://${HOST}/events — stall threshold ${STALL_SEC}s`));
  ws.on('message', m => {
    let ev; try { ev = JSON.parse(m); } catch { return; }

    if (ev.type === 'chunk_progress') {
      if (ev.state === 'started') {
        active = { num: ev.num, pid: ev.pid, count: null, received: 0, startedAt: Date.now() };
        frames261 = 0; manifestSeen = false; tiltDuringTransfer = 0; stalled = false;
        lastFrameAt = Date.now();
        say(`START num=${ev.num} pid=${ev.pid}`);
      } else if (active) {
        active.received = ev.received ?? active.received;
        if (!manifestSeen && ev.count != null) {
          manifestSeen = true;
          active.count = ev.count;
          say(`MANIFEST count=${ev.count} — full shape known from the first frames (manifest-first confirmed)`);
        }
        const pct = active.count ? ((active.received / active.count) * 100).toFixed(0) : '?';
        say(`PROGRESS ${active.received}/${active.count ?? '?'} (${pct}%) elapsed=${((ev.elapsedMs ?? 0) / 1000).toFixed(0)}s frames261=${frames261}`);
      }
      return;
    }
    if (ev.type === 'chunk_done')  { finish('DONE',  `bytes=${ev.bytes}`); return; }
    if (ev.type === 'chunk_error') { exitCode = 1; finish('ERROR', `msg="${ev.error}"`); return; }

    // Raw + typed 261 frames. Counting only — decoding is mt-transport's job.
    const rawPort = ev?.data?.packet?.decoded?.portnum;
    if ((ev.type === 'packet' && Number(rawPort) === 261) ||
        (ev.type === 'private_app' && Number(ev.portnum) === 261)) {
      frames261++; lastFrameAt = Date.now();
      if (stalled) { stalled = false; say('RECOVERED 261 frames resumed after a stall'); }
      return;
    }

    // The tilt gate under real push load: proven closed, now observed closed.
    if (ev.type === 'tilt_update' && frames261 > 0) tiltDuringTransfer++;
  });
  ws.on('close', () => { say('feed closed — reconnecting in 5s'); setTimeout(connect, 5000); });
  ws.on('error', e => say(`feed error: ${e.message}`));
}

say('push-observer — READ ONLY, transmits nothing.');
say('To start a transfer (this DOES put frames on air, and the bench unit is shared):');
say(`  curl -X POST http://${HOST}/nodes/<num>/chunk-fetch -H 'content-type: application/json' -d '{"pid":1}'`);
connect();
process.on('SIGINT', () => { say(`stopping (exit ${exitCode})`); process.exit(exitCode); });
