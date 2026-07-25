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

