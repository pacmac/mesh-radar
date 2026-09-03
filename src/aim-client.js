import { EventEmitter } from 'events';
import { defineHook } from './hooks.js';

// Internal pub/sub for events that are about the BEAM but are not rotator
// commands themselves — active-tracker's 'point_target'/'signal_update',
// relayed to the browser by ws-relay.js. rotator.js was an EventEmitter and
// callers used it for this too; this is that role, ported, not a wire event
// from the rotator (mesh-gw's aim plugin has no live push — see below).
export const events = new EventEmitter();

// Every rotator command goes through mesh-gw's `aim` plugin now — "no consumer
// has exclusive access to the rotator... it will always be commanded here via
// aim" (docs/gw/modules/aim_plugin.md). This replaces rotator.js's direct v4/v5
// WebSocket client entirely: mesh-gw resolves which mast, which dialect, and
// does the handshake itself (docs/gw/modules/radio_rotator_config.md). node-dash
// no longer knows a rotator's host, port or firmware version — it names a
// bearing or a node, never a radio. Migration: docs/modules/rotator.md, task
// `rotator-command-via-meshgw-aim`, 2026-09-03.

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8001';

// How long after a reported hold lapses before asking again — same reasoning
// and same value as the module this replaces: asking at exactly the instant a
// hold clears races mesh-gw/the firmware releasing the lock, and losing that
// race costs another full round trip.
const HOLD_LAPSE_MARGIN_MS = 250;

// A SWEEP MUST NOT DROWN THE DECISION TRACE. Announce only a MATERIAL change of
// aim, or a change of who is asking — ported unchanged from rotator.js.
const BEAM_MIN_DEG = 5;
const BEAM_QUIET_MS = 30_000;

// EVERY BEAM COMMAND ANNOUNCES ITSELF, AT THE ONE PLACE THEY ALL PASS THROUGH.
// Ported unchanged from rotator.js — the hook, not the transport, is what
// matters here.
const BEAM = defineHook({
  name: 'beam-command', scope: 'actuator',
  purpose: 'records every command that moves the antenna, and which subsystem asked for it',
});

let _lastBeam = { az: null, by: null, at: 0 };

function announce(az, by) {
  const now = Date.now();
  let drift = _lastBeam.az == null ? Infinity : Math.abs(az - _lastBeam.az);
  if (drift > 180) drift = 360 - drift;
  if (drift >= BEAM_MIN_DEG || by !== _lastBeam.by || (now - _lastBeam.at) > BEAM_QUIET_MS) {
    const from = _lastBeam.az == null ? null : Math.round(_lastBeam.az);
    BEAM.emit({
      summary: `beam → ${Math.round(az)}° (${by})` + (from == null ? '' : ` — was ${from}°`),
      detail: { az, from, by },
    });
    _lastBeam = { az, by, at: now };
  }
}

async function pointOnce(target, { timeoutMs, hold, by, ret }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_URL}/plugins/aim/point`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bearing_deg: target,
        by,
        ...(hold > 0 ? { hold_ms: hold } : {}),
        ...(ret !== undefined ? { return: ret } : {}),
      }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, az: null, err: body?.why ?? body?.detail ?? `HTTP ${res.status}` };
    }
    return {
      ok: body.ok !== false && !body.busy,
      az: body.az ?? null,
      busy: !!body.busy,
      // mesh-gw computes this directly on a busy answer — no separate status
      // fetch needed to learn how long the current holder has the beam for.
      retryInMs: body.retry_in_ms ?? null,
      err: body.why ?? null,
    };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, timeout: true, az: null };
    return { ok: false, az: null, err: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Point the beam and resolve when mesh-gw's aim plugin says it is there.
 *
 *  Same contract as rotator.js's `point()` — every existing caller keeps its
 *  logic unchanged, only the import moves:
 *
 *    point(az)                       ask; if held, come straight back with
 *                                    retryInMs — the caller decides
 *    point(az, { hold })             aim, then hold the beam for `hold` ms
 *                                    (sent inline as hold_ms — aim's contract
 *                                    already takes it on the same call, unlike
 *                                    rotator.js's old two-step point-then-hold)
 *    point(az, { patienceMs: 5000 }) queue for a hold of up to 5 s, then retry
 *    point(az, { patienceMs: true }) queue however long mesh-gw says to
 *    point(az, { patienceMs: 0 })    never queue (the default)
 *
 *  No local hold ceiling: mesh-gw enforces its own (`LOCK_MAX_MS`, 60 s,
 *  clamped not refused — docs/gw/modules/radio_rotator_config.md). A second
 *  local ceiling would be exactly the two-copies-of-the-truth pattern already
 *  fixed elsewhere in this repo (device-config.js, 2026-09-03). */
export async function point(az, { timeoutMs = 60_000, hold = 0, patienceMs = true, by = 'mission', return: ret } = {}) {
  const target = Number(az);
  announce(target, by);
  const started = Date.now();
  let r = await pointOnce(target, { timeoutMs, hold, by, ret });

  // ARE YOU FREE? — no. How long? Wait it out if the caller's policy allows,
  // then ask exactly once more. One retry, never a loop — ported unchanged
  // from rotator.js's own negotiation.
  if (r.busy && patienceMs) {
    const ceiling = patienceMs === true ? Infinity : Number(patienceMs) || 0;
    const waitMs = Number(r.retryInMs) || 0;
    if (waitMs > 0 && waitMs <= ceiling) {
      await new Promise(res => setTimeout(res, waitMs + HOLD_LAPSE_MARGIN_MS));
      r = await pointOnce(target, { timeoutMs, hold, by, ret });
    }
  }

  const waitedMs = Date.now() - started;
  return { timeout: false, busy: false, err: null, ...r, waitedMs };
}

/** Fire-and-forget move — for continuous callers (tracking, scanning) that do
 *  not want to block on settle. Wraps point() with no patience, matching
 *  rotator.js's old move() contract: send and return immediately. Unlike the
 *  old direct-WS move(), the underlying HTTP call still runs to completion in
 *  the background (mesh-gw's point is synchronous per-call — there is no
 *  non-blocking primitive in aim), so a rapid caller may have more than one
 *  request in flight; the announce() latch above still de-dupes the AUDIT LOG,
 *  not the wire traffic. */
export function move(az, { by = 'unattributed' } = {}) {
  point(az, { by, patienceMs: 0 }).catch((e) => {
    console.error(`[aim-client] move by '${by}' failed: ${e?.message ?? e}`);
  });
}

/** Where was the dish at instant `at` (epoch seconds), default now.
 *  One-shot REST read — GET /plugins/aim/where, mesh-gw's own join of pointing
 *  history to a timestamp. Replaces reading rotator.status.az directly. */
export async function where(at) {
  const url = `${BRIDGE_URL}/plugins/aim/where${at != null ? `?at=${encodeURIComponent(at)}` : ''}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Current rotator status — one-shot REST read, GET /plugins/aim/status.
 *  No live push exists (docs/gw/modules/aim_plugin.md: "stop diagnosing the
 *  rotator... busy or done is the whole contract") — fetch on demand, never
 *  poll on a timer. */
export async function status() {
  try {
    const res = await fetch(`${BRIDGE_URL}/plugins/aim/status`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
