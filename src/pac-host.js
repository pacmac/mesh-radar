// Detects and monitors the optional external "pac-host" service (mt-transport's
// custom/alarm backend — docs/modules/pac-host.md). Absence is normal: a
// machine with no pac-host running boots and serves every page identically.
//
// Everything pac-host-shaped lives in this file. No other module branches on
// pac-host's types, fields, or message shapes — they call the small surface
// exported here.

import { EventEmitter } from 'events';
import { log } from './log.js';
import { fmtAgo } from './format.js';
import { dashMode } from './dash-mode.js';

const PAC_HOST_URL = process.env.PAC_HOST_URL || 'http://127.0.0.1:8787/v1';
const HEALTH_POLL_MS = 30000;
const QUEUE_POLL_MS = 5000;
const ALIGN_POLL_MS = 2000; // faster than the queue poll — burst progress (~30s) should feel live

export const events = new EventEmitter();

let _timer = null;
let _queueTimer = null;
let _alignTimer = null;
let _lastStatus = null; // null until the first poll resolves
let _units = [];        // pac-host's own alarm-device roster (GET /mesh/devices) — already scoped to ours, no downstream filter needed
let _queues = {};       // unit num -> queue ledger array, kept fresh by _pollQueues so the browser never fetches this itself
let _alignModel = null; // last pushed align view-model (GET /mesh/align), null until first poll
let _alignPrevMode = null; // dash mode saved when we forced PASV for an align session; null when not holding it

function _statusesEqual(a, b) {
  return a.status === b.status
    && a.available === b.available
    && JSON.stringify(a.modules) === JSON.stringify(b.modules)
    && JSON.stringify(a.units) === JSON.stringify(b.units);
}

async function _poll() {
  let result;
  try {
    const res = await fetch(`${PAC_HOST_URL}/health`);
    if (!res.ok) {
      result = { available: false, status: 'unreachable', modules: [], lastCheckedMs: Date.now(), error: `health ${res.status}` };
    } else {
      const body = await res.json();
      const status = ['ready', 'degraded', 'down'].includes(body.status) ? body.status : 'unreachable';
      result = {
        available: status === 'ready' || status === 'degraded',
        status,
        modules: Array.isArray(body.modules) ? body.modules : [],
        lastCheckedMs: Date.now(),
        error: null,
      };
    }
  } catch (e) {
    result = { available: false, status: 'unreachable', modules: [], lastCheckedMs: Date.now(), error: e.message };
  }

  // Unit roster: GET /mesh/devices (task control-devices-endpoint, 2026-07-25;
  // superseded the earlier GET /mesh/nodes + user.role===200 filter, since
  // /devices IS already "ours only" — no downstream filtering needed anywhere).
  // Includes present:false units (declared but not currently in the gateway
  // roster, e.g. asleep since our last restart) — callers must render these,
  // not drop them (mt-transport, xsession [devices-live]). Fetched in the same
  // poll cycle (not on page load — BROWSER_CONTRACT: page data is WS-only, and
  // connectMessage() already replays on connect / pushes on change).
  if (result.available) {
    try {
      const devices = await _call('/mesh/devices');
      _units = Array.isArray(devices) ? devices : [];
    } catch (e) {
      log.warn('pac-host', `device roster fetch failed: ${e.message}`);
      _units = [];
    }
  } else {
    _units = [];
  }
  result.units = _units;

  const changed = !_lastStatus || !_statusesEqual(_lastStatus, result);
  _lastStatus = result;
  if (changed) {
    log.info('pac-host', `status: ${result.status}${result.error ? ` (${result.error})` : ''}, ${_units.length} unit(s)`);
    events.emit('change');
  }
}

// Keeps _queues fresh so the browser never has to ask for it (BROWSER_CONTRACT:
// page data is WS-only, replayed on connect + pushed on change — no on-demand
// GET, ever, regardless of how "interactive" the trigger looks from the UI
// side). Runs on its own faster interval than health/roster, since a queued
// request's state (queued -> trying -> done/sent/failed) is what the Control
// page actually needs to feel live. Polls every unit in _units — already
// scoped to ours by /mesh/devices, no further filtering needed. Includes
// present:false units too: the ledger is the butler's own service-side
// state, not a device round-trip, so it's available even while the unit
// sleeps.
async function _pollQueues() {
  if (!isAvailable()) { _queues = {}; return; }
  const next = {};
  for (const u of _units) {
    try {
      const ledger = await getQueue(u.id);
      // Timestamps are epoch ms (API.md §6.1 "The outbox"); fmtAgo wants epoch
      // seconds. Attached here, server-side, each poll cycle — a relative
      // "since" string must be pushed, not computed by the browser with a
      // timer (BROWSER_CONTRACT). Field renamed from enqueuedAt, task
      // ledger-field-rename, 2026-07-25 — mt-transport's ledger rewrite
      // (commit 975449e, xsession [request-ledger]).
      //
      // Live (unsettled: queued/trying) rows age from createdAt — how long
      // it has been waiting. Settled rows (done/failed/expired) age from
      // settledAt — when it actually finished — not createdAt, or a reply
      // that took 66 minutes to arrive reads as though it landed the moment
      // it was queued (task settled-age-wrong-timestamp, 2026-07-25,
      // mt-transport chat item, mcpp-chat mt-transport--node-dash#25).
      next[u.num] = Array.isArray(ledger)
        ? ledger.map(e => {
            const live = e.state === 'queued' || e.state === 'trying';
            const ts = live ? e.createdAt : (e.settledAt ?? e.createdAt);
            return { ...e, since: fmtAgo(Math.floor((ts ?? 0) / 1000)) };
          })
        : [];
    } catch (e) {
      log.warn('pac-host', `queue fetch failed for ${u.id}: ${e.message}`);
      next[u.num] = _queues[u.num] ?? []; // keep last-known rather than blank on a transient error
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(_queues);
  _queues = next;
  if (changed) events.emit('queuesChanged');
}

/** Ready-to-send WS message describing every commandable unit's queue. */
export function queuesMessage() {
  return { type: 'pac_host_queues', queues: _queues };
}

// Keeps the antenna-alignment view-model fresh via the documented polling
// fallback (GET /mesh/align) — SSE (mesh.align) is live on pac-host's side
// but node-dash has no SSE client yet (same deferral as the command ledger,
// task ledger-field-rename, 2026-07-25: a separate follow-up, not bundled
// here). Polls regardless of _units/isAvailable-per-unit, since align is a
// single session, not per-unit like the queue.
//
// PASV interlock (task yagi-align-rebuild, 2026-07-25): the OLD align-api.js
// forced dash mode to PASV for the session's duration so the Yagi would not
// auto-swing mid-burst, and restored the previous mode on stop. mt-transport
// no longer drives our rotator at all ("we do NOT drive the rotator,
// deliberately") and explicitly flagged this as ours alone to replicate:
// "If the Yagi moves during a burst, the readings are silently wrong rather
// than obviously broken, which is the worst kind of wrong." Reproduced here
// by watching the pushed model's `running` transition, the only signal we
// have now that a session is active.
async function _pollAlign() {
  if (!isAvailable()) { _alignModel = null; return; }
  let next;
  try {
    next = await _call('/mesh/align');
  } catch (e) {
    log.warn('pac-host', `align poll failed: ${e.message}`);
    return; // keep last-known model rather than blanking on a transient error
  }

  const wasRunning = !!_alignModel?.running;
  const nowRunning = !!next?.running;
  if (nowRunning && !wasRunning && _alignPrevMode == null) {
    _alignPrevMode = dashMode.value;
    dashMode.set(0); // force PASV — see comment above
    log.info('pac-host', `align session started, forced PASV (was ${_alignPrevMode})`);
  } else if (!nowRunning && wasRunning && _alignPrevMode != null) {
    dashMode.set(_alignPrevMode);
    log.info('pac-host', `align session ended, restored mode ${_alignPrevMode}`);
    _alignPrevMode = null;
  }

  const changed = JSON.stringify(next) !== JSON.stringify(_alignModel);
  _alignModel = next;
  if (changed) events.emit('alignChanged');
}

/** Ready-to-send WS message describing the current align view-model. */
export function alignMessage() {
  return { type: 'pac_host_align', model: _alignModel };
}

/** Begin polling. Idempotent — a second call is a no-op. Never blocks: the
 *  first poll runs asynchronously, so node-dash serves pages before it resolves. */
export function start() {
  if (_timer) return;
  _poll();
  _timer = setInterval(_poll, HEALTH_POLL_MS);
  _queueTimer = setInterval(_pollQueues, QUEUE_POLL_MS);
  _alignTimer = setInterval(_pollAlign, ALIGN_POLL_MS);
}

/** Stop polling and clear cached status (tests, shutdown). */
export function stop() {
  if (_timer) clearInterval(_timer);
  if (_queueTimer) clearInterval(_queueTimer);
  if (_alignTimer) clearInterval(_alignTimer);
  _timer = null;
  _queueTimer = null;
  _alignTimer = null;
  _lastStatus = null;
  _queues = {};
  _alignModel = null;
  _alignPrevMode = null;
}

export function isAvailable() {
  return !!_lastStatus?.available;
}

function _status() {
  return _lastStatus ?? { available: false, status: 'unreachable', modules: [], units: [], lastCheckedMs: null, error: null };
}

/** Ready-to-send WS message describing pac-host's current state. */
export function connectMessage() {
  return { type: 'pac_host_status', ..._status() };
}

/** The unit pac-host holds for a node num, or null if it holds none.
 *  Read-only view of the LAST POLL — never a fetch, so callers on a request
 *  path (node-status's reachability section) cost nothing and cannot block.
 *  Staleness is bounded by HEALTH_POLL_MS and is why `change` hints
 *  node_status (see ws-relay). */
export function unitForNum(num) {
  return _units.find(u => Number(u.num) === Number(num)) ?? null;
}

/** Node nums of every unit pac-host holds, present or not. Used to hint
 *  node_status when the roster changes — a sleeping unit's reachability facts
 *  must keep refreshing precisely BECAUSE no packet is arriving from it. */
export function unitNums() {
  return _units.map(u => Number(u.num)).filter(Number.isFinite);
}

async function _call(path, options) {
  const res = await fetch(`${PAC_HOST_URL}${path}`, options);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch { /* non-JSON error body */ }
    throw Object.assign(new Error(`pac-host ${res.status}${detail ? `: ${detail}` : ''}`), { status: res.status });
  }
  return res.json();
}

/** Queue a command for a pac-host unit. Pure passthrough — no verb validation,
 *  no mesh mechanics; pac-host owns what a verb means (API.md §6.1). Throws
 *  on any non-2xx, including 504 (unit asleep/out of range, not a bug). */
export async function queueCommand({ unit, verb, args }) {
  return _call('/mesh/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit, verb, ...(args !== undefined ? { args } : {}) }),
  });
}

/** Fetch one unit's queue ledger — the receipt-polling primitive. */
export async function getQueue(unit) {
  return _call(`/mesh/queue/${encodeURIComponent(unit)}`);
}

// -- pac-host's image routes, and what each one costs -----------------------
// Only the two LOCAL reads below are safe on anything a page depends on.
// Measured 2026-07-31 against the running service:
//
//   /mesh/images/<t>/progress     local, ~1.2 ms          <- safe, polled
//   /mesh/images/<t>/stored       local, ~1.5 ms          <- safe, polled
//   /mesh/images/<t>/<pid>        ~3 ms WHEN STORED       <- safe ONLY then
//   /mesh/images/<t>/<pid>        no response in 45 s when the pid is a valid
//                                 uint16 that is NOT stored — it leaves the
//                                 store path entirely (no `served from store`
//                                 log line) and does not come back
//   /mesh/images/<t>/<pid>?refresh=1   radio: minutes, and a wake window
//   /mesh/images/<t>              radio round-trip
//
// An earlier version of this comment said both non-progress image routes were
// always radio round-trips. services' 160a4a1 (2026-07-30) made `/<pid>` serve
// from disk when the bytes are already held, so that is now only half true —
// corrected here rather than left to mislead (bug ledger B46).

/** In-flight image transfers for a unit. LOCAL READ, no radio.
 *
 *  `transfers: []` means IDLE — 200 and nothing in flight. It is not an error
 *  and not "unknown" (services, xsession [ui-gaps-control-images]). */
export async function getImagesProgress(unit) {
  return _call(`/mesh/images/${encodeURIComponent(unit)}/progress`);
}

/** Images pac-host already holds on disk for a unit. LOCAL READ, no radio —
 *  measured 1.5 ms (services, 160a4a1).
 *
 *  → { target, images: [{ node, unit, pid, bytes, savedAt }] }, newest first.
 *  `savedAt` is epoch MILLISECONDS. `unit` is canonical; `node` is the raw
 *  directory key and is inconsistent even within one list (`!987ab80f` on one
 *  row, `b80f` on the next) — bind to `unit`.
 *
 *  `images: []` is a real answer: that unit has sent nothing yet. Not an error. */
export async function getStoredImages(unit) {
  return _call(`/mesh/images/${encodeURIComponent(unit)}/stored`);
}

/** What the device is CURRENTLY HOLDING — one payload, not a list.
 *
 *  RADIO ROUND-TRIP. pac-host implements this as a real `push stat` command to
 *  the device and a real reply, every call, with no caching (services, xsession
 *  #64). Measured 4.30 s against the bench unit.
 *
 *  → { pid, state, chunks, crc, proto, fw, ready }
 *
 *  **NEVER call this on a timer.** services, asked directly: *"Airtime on that
 *  link is the scarcest thing in this project, the deployed unit listens ~8 s in
 *  every 900, and a background poller would compete with real commands for the
 *  same windows."* It is user-initiated only. If a cadence is ever needed,
 *  services own the polling and publish the result with an age — we do not start
 *  a poller here.
 *
 *  An earlier note in this file called this route unusable after a 25 s timeout
 *  on 2026-07-29. That measurement is stale. */
export async function getDeviceImage(unit, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${PAC_HOST_URL}/mesh/images/${encodeURIComponent(unit)}`,
                            { signal: ac.signal });
    if (!res.ok) throw Object.assign(new Error(`pac-host ${res.status}`), { status: res.status });
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`device did not answer in ${timeoutMs}ms`), { status: 504 });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The BYTES of one stored image, as a Buffer.
 *
 *  CALLERS MUST HAVE ALREADY ESTABLISHED THAT THIS PID IS STORED. Asking for a
 *  valid-range pid that is not held does not 404 — it leaves the store path and
 *  hangs (measured: no response in 45 s). `alarm-image-api.js` gates every call
 *  against the last-polled stored list for exactly this reason.
 *
 *  The timeout is the backstop for the remaining race: a pid can be evicted
 *  between the poll that published it and the request that asks for it. Bounded
 *  failure beats a hung socket.
 *
 *  The plain form is hard-coded. `?refresh=1` forces the radio path — minutes,
 *  plus a wake window — and must never be reachable from a page. */
export async function getImageBytes(unit, pid, { timeoutMs = 5000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${PAC_HOST_URL}/mesh/images/${encodeURIComponent(unit)}/${encodeURIComponent(pid)}`,
      { signal: ac.signal },
    );
    if (!res.ok) {
      throw Object.assign(new Error(`pac-host ${res.status}`), { status: res.status });
    }
    return {
      buf:  Buffer.from(await res.arrayBuffer()),
      type: res.headers.get('content-type') || 'image/jpeg',
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`pac-host did not answer in ${timeoutMs}ms`), { status: 504 });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Open/retarget an align session and fire one burst. Pure passthrough —
 *  target/n are raw node-dash-originated input (the browser's only
 *  originated values for this feature, per the archived app-align.md
 *  invariant carried forward). Throws 409 if a burst is already active. */
export async function alignPing({ target, n }) {
  return _call('/mesh/align/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, ...(n !== undefined ? { n } : {}) }),
  });
}

/** End the current align session. */
export async function alignStop() {
  return _call('/mesh/align/stop', { method: 'POST' });
}

/** Set the server-persisted reply-wait window (5-120s). */
export async function alignConfig({ replyWindowSec }) {
  return _call('/mesh/align/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyWindowSec }),
  });
}

