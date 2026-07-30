// ALARM PLUGIN — image transfer progress. NOT CORE.
//
// Peter, 2026-07-29: "so I have some visibility" — the point of this page is to
// watch a picture arrive from the garage instead of guessing whether anything is
// happening. From GARG a single image is a ~20 minute operation.
//
// Delete this file and its one import in index.js and node-dash is unchanged.
// Registers through the host hooks built the same day; core names nothing here.
//
// See docs/CAMERA_PAGE_SPEC.md.

import * as pacHost from './pac-host.js';
import { registerWsWiring, registerConnectReplay } from './ws-relay.js';
import { fmtAgo, fmtUptime, fmtCount } from './format.js';
import { log } from './log.js';

// Chunks arrive sporadically over minutes, but the read is a 1.2 ms local call
// against pac-host's own memory, so polling cheaply is fine and makes the page
// feel live. Deliberately faster than the 5 s queue poll: a chunk landing is the
// thing the operator is watching.
const POLL_MS = 2000;

let _timer = null;
let _byNum = {};          // num -> display-ready unit model
let _broadcast = null;

const msToSec = ms =>
  (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) ? Math.floor(ms / 1000) : null;

// EVERY string here is computed server-side. The browser renders and decides
// nothing (BROWSER_CONTRACT) — including the relative times, which must be
// pushed rather than ticked locally.
function shapeTransfer(t, nowSec) {
  const received = t.received ?? 0;
  const count    = t.count;          // null until the MANIFEST arrives
  const started  = msToSec(t.startedAt);
  const lastRx   = msToSec(t.lastRxAt);

  return {
    pid: t.pid,
    // NEVER substitute 0 for a null count, and never derive a percentage from
    // one. services' own progress log printed "1/0 chunks (100%)" this morning
    // and they refused to let it back in through a new door; push.html hit the
    // same thing from the other side, where count:0 was mistaken for a manifest.
    chunks_text: count != null
      ? `${fmtCount(received)} / ${fmtCount(count)} chunks`
      : `${fmtCount(received)} chunks, total unknown`,
    percent_text: (t.percent != null && count != null) ? `${t.percent}%` : null,
    // Server-computed so the bar cannot invent a proportion it was not given.
    percent: (t.percent != null && count != null) ? t.percent : null,
    counts_text: `${fmtCount(received)} received · ${fmtCount(t.repairsSent ?? 0)} repairs · ${fmtCount(t.dupes ?? 0)} dupes`,
    // The DEVICE's own view of how far it has got, beside ours. Null if it has
    // never reported one — which is not zero.
    cursor_text: t.deviceCursor != null ? fmtCount(t.deviceCursor) : null,
    started_text: started != null ? `started ${fmtUptime(Math.max(0, nowSec - started))} ago` : null,
    // A formatted elapsed time, NOT a stall verdict. Whether a gap means the
    // transfer has died is a judgement, and nothing here publishes one.
    last_rx_text: lastRx != null ? `${fmtAgo(lastRx, nowSec)}` : null,
    aborted: !!t.aborted,
  };
}

async function _poll() {
  if (!pacHost.isAvailable()) {
    if (Object.keys(_byNum).length) { _byNum = {}; _push(); }
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const next = {};
  for (const u of pacHost.connectMessage().units ?? []) {
    let progress;
    try {
      progress = await pacHost.getImagesProgress(u.id);
    } catch (e) {
      // Keep last-known rather than blanking on a transient error — a blank
      // reads as "idle", which is a different and wrong statement.
      next[u.num] = _byNum[u.num] ?? null;
      log.warn('alarm-images', `progress fetch failed for ${u.id}: ${e.message}`);
      continue;
    }
    const transfers = Array.isArray(progress?.transfers) ? progress.transfers : [];
    next[u.num] = {
      id: u.id,
      // Both units currently report shortName GARG — one firmware image flashed
      // to two boards, same root cause as the PKI failure (services, B79). The
      // id is unique and stable, so it is shown rather than assumed away.
      label: `${u.shortName || u.name || u.id} ${u.id}`,
      // [] means IDLE: 200 and nothing in flight. Not an error, not unknown.
      // The page must be able to tell "nothing is happening" from "we cannot say".
      state: transfers.length ? 'running' : 'idle',
      idle_text: transfers.length ? null : 'no transfer in flight',
      // NEVER "your transfer". auto-adopt starts one for any pid seen pushed, so
      // a row is not necessarily one anybody requested — services: "we do not
      // hold enough identity to make that claim."
      transfers: transfers.map(t => shapeTransfer(t, nowSec)),
    };
  }
  if (JSON.stringify(next) !== JSON.stringify(_byNum)) {
    _byNum = next;
    _push();
  }
}

function _message() {
  return { type: 'alarm_images', units: _byNum };
}

function _push() {
  if (_broadcast) _broadcast(_message());
}

registerWsWiring(({ broadcast }) => {
  _broadcast = broadcast;
  if (_timer) return;
  _poll();
  _timer = setInterval(_poll, POLL_MS);
});

// Replayed to every new connection so the Camera page has state the moment it
// opens, never from a browser-triggered GET (BROWSER_CONTRACT).
registerConnectReplay(() => [_message()]);
