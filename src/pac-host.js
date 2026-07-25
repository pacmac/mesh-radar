// Detects and monitors the optional external "pac-host" service (mt-transport's
// custom/alarm backend — docs/modules/pac-host.md). Absence is normal: a
// machine with no pac-host running boots and serves every page identically.
//
// Everything pac-host-shaped lives in this file. No other module branches on
// pac-host's types, fields, or message shapes — they call the small surface
// exported here.

import { EventEmitter } from 'events';
import { log } from './log.js';

const PAC_HOST_URL = process.env.PAC_HOST_URL || 'http://127.0.0.1:8787/v1';
const HEALTH_POLL_MS = 30000;

export const events = new EventEmitter();

let _timer = null;
let _lastStatus = null; // null until the first poll resolves
let _units = [];        // pac-host's own unit roster — only meaningful data source for "which nodes are commandable"

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

  // Unit roster: only pac-host knows which nodes it can command. Fetched in the
  // same poll cycle (not on page load — BROWSER_CONTRACT: page data is WS-only,
  // and connectMessage() already replays on connect / pushes on change).
  if (result.available) {
    try {
      const nodes = await _call('/mesh/nodes');
      _units = Array.isArray(nodes) ? nodes : [];
    } catch (e) {
      log.warn('pac-host', `unit roster fetch failed: ${e.message}`);
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

/** Begin polling. Idempotent — a second call is a no-op. Never blocks: the
 *  first poll runs asynchronously, so node-dash serves pages before it resolves. */
export function start() {
  if (_timer) return;
  _poll();
  _timer = setInterval(_poll, HEALTH_POLL_MS);
}

/** Stop polling and clear cached status (tests, shutdown). */
export function stop() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _lastStatus = null;
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

