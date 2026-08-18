// traceroute-api — the ONE way to ask for a traceroute from outside the process.
// Spec: docs/modules/traceroute-flow.md.
//
// Peter, 2026-08-18: "you should be able to call this via post but no dashboard
// automation will be added for this yet." So: a route, and nothing that calls it
// on a schedule. Nothing in public/ posts here, deliberately.
//
// ── WHY THE PATH IS `/traceroute` AND NOT `/:nodeId/traceroute` ──────────────
//
// The old route was `POST /:nodeId/traceroute`, and deleting it on 2026-08-17
// did NOT stop dispatch — it made it UNMEDIATED. src/index.js registers
//
//     app.use(/^\/![0-9a-f]+/i, proxyToBridge);
//
// a catch-all that forwards any `/!hex/...` path straight to mesh-gw. With the
// handler gone the request stopped matching it and fell through to that proxy,
// so the browser's TRACE button kept transmitting with none of this module's
// guards and left NO ROW behind. Measured:
//
//     curl -X POST localhost:8000/%212687afb1/traceroute -d '{"to":646426545}'
//     -> HTTP 200
//
// A body-carrying `/traceroute` cannot collide with that regex, so this route
// can never silently become a proxy passthrough again.
//
// ── WHAT THIS ROUTE DOES NOT DO ─────────────────────────────────────────────
//
// It does not choose the radio, the bearing, or the rotator, and it does not
// schedule anything. It validates three arguments and calls traceroute.run(),
// which resolves, aims, waits for confirmation and dispatches.

import { Router } from 'express';
import { stmts } from './db.js';
import { traceroute } from './traceroute.js';
import { resolveRadio, RADIO_SPECS } from './resolve.js';
import { parseVia } from './aim.js';
import { nodeIdToNum } from './utils.js';

const router = Router();

/** POST /traceroute  { radio, node, timeout_ms }
 *
 *  radio      MAC | !hex | 'rotator' | 'non-rotator' | 'primary' | 'auto'
 *  node       !hex or a node num
 *  timeout_ms how long to wait for the reply — and, for a directional radio,
 *             how long the beam is held. Peter: "hold time ... which is the same
 *             as the timeout passed to traceroute."
 *
 *  Returns 200 with the result, or 4xx/5xx with a reason. It is deliberately
 *  SYNCHRONOUS to the caller: a traceroute that has not answered yet is not a
 *  result, and returning 202 would invite polling.
 */
router.post('/traceroute', async (req, res) => {
  const { radio = 'auto', node, timeout_ms, via_node, via_bearing } = req.body ?? {};

  // Node: accept `!hex` or a number, and reject anything else rather than
  // coercing. `Number('!da5af428')` is NaN and `Number(null)` is 0 — a 0 target
  // would be a broadcast, which is not a traceroute.
  const to = typeof node === 'string' && node.startsWith('!') ? nodeIdToNum(node) : Number(node);
  if (!Number.isFinite(to) || to <= 0) {
    return res.status(400).json({ error: 'node required — !hex or a node num' });
  }

  // TIMEOUT IS OPTIONAL. Peter, 2026-08-18: "if timeout is not set, then it
  // should have a default. that should be a config and not hard coded."
  // run() applies `traceroute.timeout_sec` when this is absent; a NEGATIVE or
  // non-numeric value is still refused, because that is a typo rather than an
  // omission and silently substituting a default would hide it.
  let timeoutMs;
  if (timeout_ms != null && timeout_ms !== '') {
    timeoutMs = Number(timeout_ms);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return res.status(400).json({ error: 'timeout_ms must be a positive number of milliseconds, or omitted to use traceroute.timeout_sec' });
    }
  }

  // Resolve here as well as inside run(), only so a bad radio is a 400 with the
  // vocabulary rather than a 500 with a stack. run() resolves again and that is
  // the one that counts — this is validation, not the decision.
  const resolved = resolveRadio(radio);
  if (!resolved) {
    return res.status(400).json({
      error: `no radio resolves for '${radio}'`,
      accepts: [...RADIO_SPECS, 'a MAC', 'a !hex node id'],
    });
  }

  // `via_node` / `via_bearing` — an AIM override, as two NAMED fields so nothing
  // has to guess which was meant. Parsed here so a bad one is a 400 now rather
  // than a refusal to dispatch three seconds later. Both set is a contradiction
  // and parseVia refuses it.
  const viaSpec = parseVia({ via_node, via_bearing });
  if (viaSpec?.error) return res.status(400).json({ error: viaSpec.error });

  // VIA ON AN OMNI IS IGNORED, AND SAID SO OUT LOUD. Peter: "this only applies
  // to directional antennas." The traceroute is still valid, so this is not an
  // error — but a caller who asked for a beam somewhere and got none must not
  // have to infer that from silence.
  const viaIgnored = viaSpec != null && !resolved.directional;

  try {
    const result = await traceroute.run(radio, to, timeoutMs, { via: viaSpec });
    return res.json({
      ok: true,
      radio: { label: resolved.label, node_id: resolved.node_id, beam_deg: resolved.beam_deg,
               directional: resolved.directional },
      ...(viaIgnored ? { via_ignored: `radio ${resolved.label} is omnidirectional (${resolved.beam_deg}°) — via only applies to a directional antenna` } : {}),
      result,
    });
  } catch (err) {
    // An unconfirmed aim, a cooldown, a timeout and a send failure all land
    // here. They are DIFFERENT outcomes and the caller is told which — a single
    // "failed" is what made a dead gateway and a quiet mesh look identical.
    const msg = err?.message ?? String(err);
    const status = /aim not confirmed/.test(msg) ? 409
                 : /cooldown/.test(msg)          ? 429
                 : /timeout/.test(msg)           ? 504
                 : 500;
    return res.status(status).json({ ok: false, error: msg });
  }
});

// GET /traceroute_history — READS. Restored 2026-08-18 alongside the POST,
// because a dispatch you cannot read back is not testable. It was dropped on
// 2026-08-17 under "keep the data, drop the reads" when nothing dispatched;
// something does now.
router.get('/traceroute_history', (req, res) => {
  const to_num = req.query.to_num ? parseInt(req.query.to_num) : null;
  const limit  = Math.min(parseInt(req.query.limit ?? 50), 500);
  try {
    const rows = stmts.queryTracerouteHistory.all({ to_num, limit });
    res.json(rows.map(r => ({
      ...r,
      route:           JSON.parse(r.route           || '[]'),
      route_back:      JSON.parse(r.route_back      || '[]'),
      snr_towards:     JSON.parse(r.snr_towards     || '[]'),
      snr_back:        JSON.parse(r.snr_back        || '[]'),
      relay_positions: JSON.parse(r.relay_positions || '{}'),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
