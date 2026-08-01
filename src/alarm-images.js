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
let _storedIds = {};      // num -> Set of stored image ids (the by-id route's allowlist)
let _device = {};         // num -> what the DEVICE says it holds, from a user-initiated check
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

/** Is this a stored image id for this unit? Allowlist for the by-id byte route. */
export function isStoredId(num, id) {
  return _storedIds[num] instanceof Set && _storedIds[num].has(Number(id));
}

/** Is this the pid the DEVICE told us it is holding? Fetchable, but only via
 *  the server-side fetch action — never as an <img src>, because a pid we do
 *  not already hold runs the full radio pull and takes minutes. */
export function isDevicePid(num, pid) {
  return Number(_device[num]?.pid) === Number(pid);
}

/** Record what the device says it is holding. Called by the user-initiated
 *  check in `alarm-image-api.js` — NEVER from a timer (see pac-host's
 *  getDeviceImage). */
export function setDeviceImage(num, info) {
  _device[num] = info && Number.isFinite(Number(info.pid)) ? { ...info, at: Date.now() } : null;
  _poll();
}

// A stored row shaped for display. Every string is built here.
function shapeImage(img, num, nowSec, onDevice) {
  const savedSec = msToSec(img.savedAt);
  return {
    // NOT keyed on pid: a pid is a uint16 and recycles, and !987ab80f currently
    // lists 7 images under 3 distinct pids (pid 1 five times). A duplicate
    // x-for key is what froze the message feed once already (message-flow-audit).
    key:         `${img.pid}-${img.savedAt}`,
    id:          img.id ?? null,
    pid:         img.pid,
    // ID-ADDRESSED, not pid-addressed. pid is a recycling uint16 and is not
    // unique in a unit's list (!987ab80f: 7 rows, 3 distinct pids), so
    // /images/<t>/<pid> can only ever return the NEWEST row for a pid and four
    // of GARG's images were listable but unreachable. services' by-id route
    // (measured 200 in 1.6 ms) fixes that; pid remains only as a fallback for
    // any row the store has not given an id.
    url:         img.id != null ? `/alarm/image/${num}/by-id/${img.id}` : `/alarm/image/${num}/${img.pid}`,
    size_text:   fmtBytes(img.bytes),
    saved_text:  savedSec != null ? fmtAgo(savedSec, nowSec) : null,
    saved_stamp: savedSec != null ? fmtStamp(savedSec, { now: nowSec }) : null,
    // Can this one be RE-PULLED over the air? Only if the device still holds
    // that pid. The device holds ONE payload and a new capture replaces it, so
    // every other row will answer ENOIMG — measured, and now permanently
    // visible in services' /history (pid 50108 ENOIMG twice, pid 18137 EXFER
    // 3/0). Offering a re-download button for those would be seven buttons
    // that cannot work.
    on_device:   onDevice,
    fetch_text:  onDevice ? 'still on the device — can be downloaded again'
                          : 'not on the device any more — view only',
    // pid 1 is the device's EMBEDDED TEST IMAGE, and this is the firmware
    // contract rather than a guess:
    //   main.cpp:489             TEST_IMAGE_PID = 1
    //   include/test_image.h:22  TEST_IMAGE_LEN = 7156
    //   main.cpp:521             camPidFromCrc() excludes 0 and TEST_IMAGE_PID
    // pid 1 is RESERVED — a real capture can never be assigned it.
    //
    // This label was written, then removed on 2026-07-31 because the image
    // "decodes to a real photograph of buildings", then restored when the
    // firmware was actually read. It IS a real photograph — used as embedded
    // test data. Appearance was never the test, and reasoning from it got the
    // wrong answer and briefly contradicted services, who were right.
    note: (img.pid === 1 && img.bytes === 7156) ? 'device test image, not a capture' : null,
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
    outcome:      h.outcome,                        // 'complete' | 'partial' | 'ended'
    // Said in words, because the badge alone cannot carry it: a partial attempt
    // for an image we already hold is a very different event from one that lost
    // the only copy, and both used to render as "saved".
    outcome_text: h.outcome === 'complete' ? 'received in full'
                : h.outcome === 'partial'  ? 'incomplete — image already held from an earlier transfer'
                                           : 'incomplete — image not held',
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
//
// KEYED BY pid + startedAt, NOT pid. A pid gets re-transferred: pac-host
// auto-adopts any push it sees, so seconds after a successful transfer saves,
// a SECOND transfer for the same pid can begin. Keying on pid alone meant the
// new one occupied the old one's slot, the real ending was never recorded, and
// the row that eventually appeared carried the *re-pull's* numbers.
//
// Measured 2026-07-31: pid 18137 completed 11/11 (1 repair, 10 dupes) and
// saved at 09:52:59Z; pac-host auto-adopted the same pid at 09:53:00Z and that
// second attempt EXFER'd at 3/0 chunks. The page showed "3 chunks, total
// unknown · 0 repairs · 0 dupes" for what the operator had just watched
// succeed. Peter: "it says total unknown".
function _recordEndings(num, seenNow, storedPids, nowMs) {
  const prev = _live[num] || {};
  for (const [key, last] of Object.entries(prev)) {
    if (seenNow[key]) continue;                       // still running
    const pid      = Number(last.pid);
    const received = last.received ?? 0;
    const count    = last.count ?? null;
    // Did THIS transfer get everything it was told to expect? That is a fact
    // about this attempt. Whether the bytes exist at all is a separate fact —
    // an earlier attempt may already have delivered them — and conflating the
    // two is what made an aborted 3-chunk re-pull report "saved".
    const complete = count != null && count > 0 && received >= count;
    const held     = storedPids.has(pid);
    const rows     = _history[num] || (_history[num] = []);
    rows.unshift({
      pid,
      received,
      count,
      repairsSent: last.repairsSent ?? 0,
      dupes:       last.dupes ?? 0,
      startedAt:   last.startedAt ?? null,
      endedAt:     nowMs,
      // Three honest states, and none of them is a diagnosis of WHY:
      //   complete — this attempt received every chunk of its manifest
      //   partial  — it did not, but the image is in the store from elsewhere
      //   ended    — it did not, and we do not hold the image
      outcome:     complete ? 'complete' : (held ? 'partial' : 'ended'),
      held,
    });
    rows.length = Math.min(rows.length, HISTORY_MAX);
  }
  _live[num] = seenNow;
}

async function _poll() {
  if (!pacHost.isAvailable()) {
    if (Object.keys(_byNum).length) { _byNum = {}; _stored = {}; _storedIds = {}; _push(); }
    return;
  }
  const nowMs   = Date.now();
  const nowSec  = Math.floor(nowMs / 1000);
  const next     = {};
  const stored   = {};
  const storedIds = {};
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
    // Separate allowlist for the id-addressed byte route.
    storedIds[u.num] = new Set(images.map(i => Number(i.id)).filter(Number.isFinite));

    // Keyed pid+startedAt so a re-adopted transfer of an already-delivered pid
    // is a DIFFERENT entry, not the same one continuing. See _recordEndings.
    const seenNow = {};
    for (const t of transfers) {
      if (t?.pid == null) continue;
      seenNow[`${t.pid}-${t.startedAt ?? 0}`] = t;
    }
    _recordEndings(u.num, seenNow, pidSet, nowMs);

    // pac-host returns newest first; the first row for a pid is the only one
    // GET /images/<t>/<pid> can return.
    const devicePid = Number(_device[u.num]?.pid);
    const shapedImages = images.map(img => shapeImage(img, u.num, nowSec, Number(img.pid) === devicePid));

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
      // What the DEVICE is holding, from the last user-initiated check.
      // Deliberately NOT a list: the device holds ONE payload and a new publish
      // replaces it — measured, and confirmed by services (xsession #64), which
      // is why there is no dropdown here. `held` means the bytes are already in
      // /stored, in which case there is nothing to fetch.
      device: (() => {
        const d = _device[u.num];
        if (!d || !Number.isFinite(Number(d.pid))) return null;
        const pid  = Number(d.pid);
        const held = pidSet.has(pid);
        const at   = msToSec(d.at);
        return {
          pid,
          held,
          ready:        d.ready === true,
          chunks_text:  Number.isFinite(Number(d.chunks)) ? `${fmtCount(d.chunks)} chunks` : null,
          // Never presented as live: this came from one radio call at a moment
          // in time, and the device can publish a new payload at any point.
          checked_text: at != null ? `checked ${fmtAgo(at, nowSec)}` : null,
          status_text:  held
            ? 'already downloaded'
            : (d.ready === true ? 'not yet downloaded' : 'not ready to send'),
          fetchable:    !held && d.ready === true,
        };
      })(),
      device_hint: _device[u.num] ? null : 'Ask the device what it is holding — one radio call, a few seconds.',
      history: (_history[u.num] || []).map(h => shapeHistory(h, nowSec)),
      // Said plainly rather than implied: we can only report what we watched.
      history_note: 'Attempts observed while node-dash was running. Earlier transfers are not recorded.',
    };
  }
  _stored = stored;
  _storedIds = storedIds;
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
