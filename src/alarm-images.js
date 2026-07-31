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
import { fmtAgo, fmtUptime, fmtCount, fmtStamp } from './format.js';
import { log } from './log.js';

// Chunks arrive sporadically over minutes, but the read is a 1.2 ms local call
// against pac-host's own memory, so polling cheaply is fine and makes the page
// feel live. Deliberately faster than the 5 s queue poll: a chunk landing is the
// thing the operator is watching.
const POLL_MS = 2000;

// How many past attempts to remember per unit. Peter, 2026-07-31: "no previus
// failed/ succeeded tests" — a transfer that ends leaves NO trace in pac-host's
// /progress, so a week of failures and a week of nothing looked identical. We
// only know what we observed while running; that limit is stated on the page
// rather than papered over.
const HISTORY_MAX = 12;

let _timer = null;
let _byNum = {};          // num -> display-ready unit model
let _stored = {};         // num -> Set of stored pids (the image route's allowlist)
let _history = {};        // num -> [{ pid, received, count, outcome, ... }] newest first
let _live = {};           // num -> { pid -> last raw transfer seen }, for end-detection
let _broadcast = null;

const msToSec = ms =>
  (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) ? Math.floor(ms / 1000) : null;

const fmtBytes = b =>
  (typeof b === 'number' && Number.isFinite(b) && b >= 0)
    ? (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} kB`)
    : null;

/** Is this pid one we have actually seen in pac-host's stored list for this
 *  unit? `alarm-image-api.js`'s allowlist — see that module's spec. Asking
 *  pac-host for an unstored pid does not 404, it hangs. */
export function isStoredPid(num, pid) {
  return _stored[num] instanceof Set && _stored[num].has(Number(pid));
}

// A stored row shaped for display. Every string is built here.
function shapeImage(img, num, nowSec, newerPidSeen) {
  const savedSec = msToSec(img.savedAt);
  // pac-host returns newest first, so a pid already seen higher up the list is
  // a NEWER image under the same number. GET /images/<t>/<pid> returns only
  // that newest one, so this row exists but cannot be fetched on its own.
  const addressable = !newerPidSeen;
  return {
    // NOT keyed on pid: a pid is a uint16 and recycles, and !987ab80f currently
    // lists 7 images under 3 distinct pids (pid 1 five times). A duplicate
    // x-for key is what froze the message feed once already (message-flow-audit).
    key:         `${img.pid}-${img.savedAt}`,
    pid:         img.pid,
    url:         `/alarm/image/${num}/${img.pid}`,
    size_text:   fmtBytes(img.bytes),
    saved_text:  savedSec != null ? fmtAgo(savedSec, nowSec) : null,
    saved_stamp: savedSec != null ? fmtStamp(savedSec, { now: nowSec }) : null,
    addressable,
    // NO "test pattern" LABEL. services said pid 1 on !8cee336b is a test
    // pattern, and both units list pid 1 at exactly 7156 bytes, so a
    // `pid === 1 && bytes === 7156` heuristic looked safe. It was written, and
    // it was WRONG: !987ab80f's pid 1 decodes to a real photograph of
    // buildings and sky (verified by eye, 2026-07-31). Shipping it would have
    // stamped "not a capture" across a genuine image.
    //
    // Whether a stored image is a test frame is not something this side can
    // know. If pac-host ever publishes a flag we render it; until then we say
    // nothing, because saying nothing is the only honest option.
  };
}

// A finished transfer, kept because pac-host forgets it the instant it ends.
// This is an OBSERVATION, not a verdict: we record what the last poll saw and
// whether the bytes later appeared in the stored list. We do not diagnose why.
function shapeHistory(h, nowSec) {
  const endedSec = msToSec(h.endedAt);
  return {
    key:          `${h.pid}-${h.endedAt}`,
    pid:          h.pid,
    outcome:      h.outcome,                        // 'saved' | 'ended'
    chunks_text:  h.count != null
      ? `${fmtCount(h.received)} / ${fmtCount(h.count)} chunks`
      : `${fmtCount(h.received)} chunks, total unknown`,
    counts_text:  `${fmtCount(h.repairsSent ?? 0)} repairs · ${fmtCount(h.dupes ?? 0)} dupes`,
    ended_text:   endedSec != null ? fmtAgo(endedSec, nowSec) : null,
    ended_stamp:  endedSec != null ? fmtStamp(endedSec, { now: nowSec }) : null,
    duration_text: (h.startedAt && h.endedAt && h.endedAt > h.startedAt)
      ? fmtUptime(Math.floor((h.endedAt - h.startedAt) / 1000))
      : null,
  };
}

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

// A transfer that was in flight last poll and is gone this poll has ENDED.
// pac-host keeps no record of it, so if we do not capture it here it is lost —
// which is exactly why the page could show a week of failures as "idle".
function _recordEndings(num, seenNow, storedPids, nowMs) {
  const prev = _live[num] || {};
  for (const [pid, last] of Object.entries(prev)) {
    if (seenNow[pid]) continue;                       // still running
    const saved = storedPids.has(Number(pid));
    const rows  = _history[num] || (_history[num] = []);
    rows.unshift({
      pid:         Number(pid),
      received:    last.received ?? 0,
      count:       last.count ?? null,
      repairsSent: last.repairsSent ?? 0,
      dupes:       last.dupes ?? 0,
      startedAt:   last.startedAt ?? null,
      endedAt:     nowMs,
      // Only two claims we can honestly make: the bytes turned up in the store,
      // or the transfer stopped and they did not. NOT a diagnosis of why.
      outcome:     saved ? 'saved' : 'ended',
    });
    rows.length = Math.min(rows.length, HISTORY_MAX);
  }
  _live[num] = seenNow;
}

async function _poll() {
  if (!pacHost.isAvailable()) {
    if (Object.keys(_byNum).length) { _byNum = {}; _stored = {}; _push(); }
    return;
  }
  const nowMs   = Date.now();
  const nowSec  = Math.floor(nowMs / 1000);
  const next    = {};
  const stored  = {};
  for (const u of pacHost.connectMessage().units ?? []) {
    let progress, storedRes;
    try {
      // Both are LOCAL reads (~1.2 ms and ~1.5 ms). Neither touches the radio.
      [progress, storedRes] = await Promise.all([
        pacHost.getImagesProgress(u.id),
        pacHost.getStoredImages(u.id),
      ]);
    } catch (e) {
      // Keep last-known rather than blanking on a transient error — a blank
      // reads as "idle", which is a different and wrong statement.
      next[u.num]   = _byNum[u.num] ?? null;
      stored[u.num] = _stored[u.num] ?? new Set();
      log.warn('alarm-images', `image poll failed for ${u.id}: ${e.message}`);
      continue;
    }
    const transfers = Array.isArray(progress?.transfers) ? progress.transfers : [];
    const images    = Array.isArray(storedRes?.images)   ? storedRes.images   : [];

    // The allowlist that keeps alarm-image-api.js from ever asking pac-host for
    // an unstored pid — which does not 404, it hangs (measured: >45 s).
    const pidSet = new Set(images.map(i => Number(i.pid)).filter(Number.isFinite));
    stored[u.num] = pidSet;

    const seenNow = {};
    for (const t of transfers) if (t?.pid != null) seenNow[t.pid] = t;
    _recordEndings(u.num, seenNow, pidSet, nowMs);

    // pac-host returns newest first; the first row for a pid is the only one
    // GET /images/<t>/<pid> can return.
    const pidSeen = new Set();
    const shapedImages = images.map((img) => {
      const already = pidSeen.has(img.pid);
      pidSeen.add(img.pid);
      return shapeImage(img, u.num, nowSec, already);
    });

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
      images: shapedImages,
      // [] is a real answer: that unit has sent nothing yet. !18a01fc4 is
      // genuinely empty right now, and that must not render as an error.
      images_empty_text: shapedImages.length ? null : 'no images stored for this unit yet',
      history: (_history[u.num] || []).map(h => shapeHistory(h, nowSec)),
      // Said plainly rather than implied: we can only report what we watched.
      history_note: 'Attempts observed while node-dash was running. Earlier transfers are not recorded.',
    };
  }
  _stored = stored;
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
