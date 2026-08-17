// aim — decide where to point, and point it. Spec:
// docs/modules/radio-resolve-and-aim.md.
//
// EXTRACTED FROM traceroute.js 2026-08-17, task `traceroute-calls-resolve-and-aim`.
// Peter: "aim, resolve and traceroute are 3 functions that may be called
// independently as well as in the case of traceroute dependently. traceroute
// should call and not duplicate what the other functions provide."
//
// There was no aim module. traceroute WAS the aim module: ~210 lines deciding
// the target, resolving bearings, reading rotator config, calling point(),
// running the retry loop and clamping the shared-rotator hold. All of it moved
// here, comments and evidence intact — those measurements are why this is a
// MOVE and not a rewrite.
//
// TWO ENTRY POINTS, DELIBERATELY SPLIT:
//   decideAim()  pure policy over stored evidence. Touches no hardware, so it
//                is testable without moving a rotator that is shared with the
//                garage alarm.
//   aimAt()      the ONLY caller of rotator.point() in this path.
//
// THE HOLD CEILING IS NO LONGER HERE. It moved into rotator.js, where Peter said
// it belonged — the ruling was quoted inside traceroute.js all along
// (2026-08-04): "that is an issue with the node-dash pointer code and not really
// traceroute. traceroute calls the pointer code, it is the one that needs
// fixing." Enforcing it in the caller left every other caller of point()
// unclamped.

import { stmts, getConfig } from './db.js';
import { discoveryConfig } from './config-api.js';
import { rotator } from './rotator.js';
import { doorAim } from './doors.js';
import { provenDoors } from './node-kind.js';
import { EventEmitter } from 'events';

const log = {
  warn: (...a) => console.log('[aim] warn:', ...a),
};

/** Aim events, for anything that wants to animate the beam.
 *
 *  Peter, 2026-08-04, on what these are for: "the beauty and refinement of the
 *  radar is it actually animates the whole traceroute, the antenna aiming, the
 *  target node". They were emitted by traceroute and consumed by ws-relay; both
 *  ends were removed with the traceroute surface, so nothing subscribes today.
 *  They stay because the aiming is what the animation was OF, and this is now
 *  the module that knows when it happens. */
export const aimEvents = new EventEmitter();

/** Bearing from home to a node. Moved verbatim from traceroute.js:71.
 *
 *  Deliberately separate from doorAim: pointing at the endpoint is a DIFFERENT
 *  and usually worse choice, and the two must never quietly substitute for one
 *  another.
 *
 *  THE BUG THIS CARRIES A SCAR FROM: it was written `nodeList.get?.(num)`, and
 *  `nodeList.get` DOES NOT EXIST — the class has getters `homePos`, `nodes`,
 *  `ownDeviceNodes` and no `get(num)` method. The optional call swallowed that
 *  silently, evaluating to undefined every single time, so this returned null on
 *  every call and `aim: 'endpoint'` could NEVER aim. Verified 2026-08-04 by
 *  dispatching on the yagi with aim=endpoint and getting aim_mode='none'.
 *
 *  It reads the same source doors.js uses (the `nodes` table) so the two aim
 *  modes cannot silently disagree about where a node is. */
export function bearingToNode(num) {
  const n = stmts.getNodeByNum.get(num) ?? null;
  const lat = n?.lat;
  const lon = n?.lon;
  if (!lat || !lon) return null;
  const h = { lat: getConfig('home.lat'), lon: getConfig('home.lon') };
  if (h.lat == null || h.lon == null) return null;
  const r = Math.PI / 180;
  const y = Math.sin((lon - h.lon) * r) * Math.cos(lat * r);
  const x = Math.cos(h.lat * r) * Math.sin(lat * r)
          - Math.sin(h.lat * r) * Math.cos(lat * r) * Math.cos((lon - h.lon) * r);
  return Math.round((Math.atan2(y, x) / r + 360) % 360);
}

// ── decideAim(to, radio) ─────────────────────────────────────────────────────
//
// THE DECISION THE REWORK WAS FOR. Peter, 2026-08-05: "right now traceroute
// still points at eps".
//
// WHY AIMING AT THE ENDPOINT IS WRONG. Measured over 2726 completed traces: the
// first hop is inside the endpoint's 35 degree beam only 12.9% of the time, and
// more than 135 degrees away — behind the antenna — 53.4% of the time. Mean
// separation 102.6 degrees. We transmit to the DOOR, not to the destination, so
// the destination's bearing is the wrong thing to point at.
//
// THE RULE, in evidence order:
//
//   1. Known route, door FAR      -> aim at the door. It is the node our
//                                    transmission actually has to reach, and it
//                                    is far enough for gain to matter.
//   2. Known route, door CLOSE    -> try to BYPASS it: aim at hop 2, if we
//                                    provably reach hop 2 directly and it is
//                                    better aligned to the endpoint. Reaching it
//                                    removes a hop permanently. Measured: 155
//                                    such cases. PJ1 alone has 44 — endpoint
//                                    62deg/3km, hop1 T4 at 274deg, hop2 WLCD at
//                                    62deg/3km.
//   3. Known route, door close,
//      no bypass candidate        -> do not rotate. The door is inside omni
//                                    reach and the beam is theatre.
//   4. No known route             -> aim at the endpoint. NOT to follow a route
//                                    — there isn't one — but as a bet on DIRECT
//                                    contact, which is the only thing that
//                                    creates a new door.
//
//   3b. Known route, door close, NO bypass, but WE TRANSMIT ON THE ROTATOR
//                                 -> aim at the door anyway.
//
// Rule 3 said "do not rotate, the beam is theatre". That was true while the OMNI
// transmitted. Once disc.tx became the rotator (2026-08-05, event_log 4242) it
// stopped meaning "we radiate omnidirectionally anyway" and started meaning
// "fire a 35 degree beam wherever somebody else left the antenna".
//
// Measured over the 24 h after the flip: 303 YAGI attempts at aim_mode=none,
// 7.9% answered, and those shots covered 246 DISTINCT azimuths spanning
// 0.85-359.98 degrees. The beam was not stale-but-constant, it was scattered
// across the whole circle — the active tracker and the scanner move it for their
// own reasons and traceroute never reclaimed it.
//
// Every branch records its own mode, so the row says which rule fired.
//
// TAKES A RESOLVED RADIO BUNDLE, not a device string. `radio.steerable` replaces
// the local `_txIsRotator()` MAC comparison that used to live in traceroute —
// which had its own scar: a node_id-vs-MAC compare is always false, and it once
// reported "not on the rotator" about the rotator itself.
export function decideAim(to, radio) {
  const none = { az: null, aimTarget: null, mode: 'none' };
  let route = null;
  try { route = JSON.parse(stmts.latestRouteTo.get(to)?.route ?? 'null'); } catch { /* no route */ }

  // 4. Nothing known: bet on a direct contact.
  if (!Array.isArray(route) || !route.length) {
    const b = bearingToNode(to);
    return b == null ? none : { az: b, aimTarget: to, mode: 'endpoint' };
  }

  const d = doorAim(to);
  // 1. The door is far enough that the beam buys something.
  if (d && d.az != null && d.needsBeam) return { az: d.az, aimTarget: d.door, mode: 'door' };

  // 2. The door is close. Can we skip it?
  const hop2 = route[1];
  if (hop2 != null && hop2 !== 0xffffffff && provenDoors().has(Number(hop2))) {
    const b2 = bearingToNode(hop2), be = bearingToNode(to);
    if (b2 != null && be != null) {
      const sep = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
      const b1 = d?.az;
      // Only worth it if hop2 points nearer the endpoint than the door does —
      // otherwise we are just aiming somewhere else for no reason.
      if (b1 == null || sep(b2, be) < sep(b1, be)) {
        return { az: b2, aimTarget: hop2, mode: 'bypass' };
      }
    }
  }
  // 3b. Close door, no bypass — but if WE are the ones radiating through the
  // yagi, "don't rotate" points a 35 degree beam at nothing. Aim at the door.
  // Gated on whether the transmitting radio can be steered at all: moving an
  // antenna we are not transmitting through is exactly the theatre rule 3
  // correctly refused.
  if (radio?.steerable) {
    if (d && d.az != null) return { az: d.az, aimTarget: d.door, mode: 'door_near' };
    // No door bearing resolves — fall back to the endpoint for the same reason
    // rule 4 does: a deliberate bearing beats an arbitrary one.
    const b = bearingToNode(to);
    if (b != null) return { az: b, aimTarget: to, mode: 'endpoint_near' };
  }

  // 3. Close door, no bypass, and we are not on the rotator: do not spend the beam.
  return none;
}

/** Point the beam and WAIT FOR IT TO GET THERE.
 *
 *  Returns { settled, azActual }. Never throws: a rotator that will not move
 *  must not stop the caller, it must be recorded as unaimed.
 *
 *  @param radio  a resolved bundle from resolve.js. Must be `steerable`.
 *  @param az     degrees.
 *  @param opts   hold_ms / settle_ms / patience_ms / aim_retries overrides. */
export async function aimAt(radio, az, opts = {}) {
  if (!radio?.steerable || az == null) return { settled: false, azActual: null };

  const d = discoveryConfig();
  let settled = false, azActual = null;

  try {
    // point(), NOT move(). Peter, 2026-08-04: "remember that the pointer has a
    // hold and handshakes when it is moving."
    //
    // point() IS that handshake — are you free, move now, maybe hold; if it is
    // busy it says so and waits out the other holder's window. move() fires and
    // forgets, so the first version of this polled status on a timer and could
    // still transmit mid-slew. It also HOLDS the beam through the reply, which is
    // the whole reason the antenna is pointed in the first place.
    //
    // THE ROTATOR IS SHARED, AND IT TELLS YOU SO. Peter, 2026-08-04: "the rotator
    // is also being used by a different app, every 15 minutes it might point and
    // hold the rotator for up to 15 seconds, but the pointer will tell you that if
    // you know how to ask." Waiting out a neighbour's hold is the rotator's own
    // policy and its default — this asks, it does not dictate.
    //
    // NO INVENTED NUMBERS. Peter, 2026-08-04: "stop setting arbitrary timings and
    // stop hard coding timings ... what is the basis for your 5 second
    // calculation, why not use 2 days instead of 5 seconds ... they are simply
    // just a random number you pick. STOP DOING THAT."
    //
    //   hold      discovery.hold_sec         the operator's answer to "how long
    //                                        may we hold a SHARED beam"
    //   timeoutMs discovery.aim_timeout_sec  the existing budget for an aim
    //   patience  NOT PASSED — the rotator honours the hold it was told about
    //
    // THE CEILING IS NOT APPLIED HERE ANY MORE. rotator.point() clamps it, so it
    // binds every caller and not just this one.
    const holdMs = opts.hold_ms ?? (Number(d.hold_sec) > 0 ? Number(d.hold_sec) * 1000 : undefined);
    const aimMs  = opts.settle_ms ?? (Number(d.aim_timeout_sec) > 0 ? Number(d.aim_timeout_sec) * 1000 : undefined);

    let r = await rotator.point(az, {
      by: 'aim',
      ...(holdMs !== undefined ? { hold: holdMs } : {}),
      ...(aimMs  !== undefined ? { timeoutMs: aimMs } : {}),
      ...(opts.patience_ms !== undefined ? { patienceMs: opts.patience_ms } : {}),
    });
    settled = !!(r && r.ok && !r.busy);
    if (r && r.az != null && Number.isFinite(Number(r.az))) azActual = Number(r.az);

    // ASK IT A SECOND TIME IF IT LANDED OUTSIDE THE BEAM. Peter, 2026-08-04:
    // "if it's so far out you can ask it a second time. this issue is resolved in
    // v5 but you have to make do with what you have for now."
    //
    // Measured on the first five door aims: the v4 either lands within 0-2 degrees
    // or misses by 112-140. A miss leaves a 9 dBi beam pointing at nothing, which
    // is WORSE than not aiming.
    //
    // Then measured over seven aims with deliberately long slews:
    //   first attempt inside the 35 deg beam:  2/7   (29%)
    //   after one re-issue:                    6/7   (86%)
    // The one that still missed was a 121->351 slew: it stopped at 276, and the
    // re-issue overshot to 59.
    //
    // So the count is a KNOB with those numbers as its basis
    // (`discovery.aim_retries`), never a literal, and the tolerance is HALF THE
    // CONFIGURED BEAMWIDTH — from device config, and null means "cannot judge, do
    // not retry". It stops the moment the aim is inside the half-beam, so a good
    // first move costs nothing extra.
    const half  = radio.beam_deg != null ? radio.beam_deg / 2 : null;
    const errOf = (got) => Math.abs(((Number(got) - az + 540) % 360) - 180);
    const maxRetries = Number.isFinite(Number(d.aim_retries)) ? Number(d.aim_retries) : 0;
    for (let i = 0; i < maxRetries; i++) {
      if (half == null || !r || r.az == null || r.busy || errOf(r.az) <= half) break;
      r = await rotator.point(az, {
        by: 'aim',
        ...(holdMs !== undefined ? { hold: holdMs } : {}),
        ...(aimMs  !== undefined ? { timeoutMs: aimMs } : {}),
      });
      if (r && r.az != null) { settled = !!(r.ok && !r.busy) && errOf(r.az) <= half; azActual = Number(r.az); }
    }
    // WHERE IT SAYS IT GOT TO. Peter, 2026-08-04: "the yagi rotates at about
    // 60rpm, point and settle should never take more than about 1.5 seconds, but
    // the point is, the pointer will tell you when it has reached, you do not have
    // to guess." point() waits for the rotator's `done` handshake and that message
    // carries the arrived azimuth, captured HERE at the moment of arrival.
  } catch (e) {
    log.warn(`point failed — recording unaimed: ${e?.message ?? e}`);
  }
  return { settled, azActual };
}

/** Decide, then point, and return the provenance that goes on a stored row.
 *
 *  This is the one call a dispatcher makes. Returns
 *  { mode, target, az, az_actual, beam_deg, settled } and never throws.
 *
 *  @param want  'auto' | 'door' | 'endpoint' | 'none' | a number (degrees). */
export async function resolveAim(to, want, radio, opts = {}) {
  const beam_deg = radio?.beam_deg ?? null;
  const unaimed  = (note) => ({ mode: 'none', target: null, az: null, beam_deg, settled: false, ...(note ? { note } : {}) });

  if (!want || want === 'none') return unaimed();

  let az = null, aimTarget = null, mode = 'none';
  if (typeof want === 'number')  { az = want; mode = 'endpoint'; }
  else if (want === 'auto')      ({ az, aimTarget, mode } = decideAim(to, radio));
  else if (want === 'door')      { const d = doorAim(to); if (d?.az != null) { az = d.az; aimTarget = d.door; mode = 'door'; } }
  else if (want === 'endpoint')  { const b = bearingToNode(to); if (b != null) { az = b; aimTarget = to; mode = 'endpoint'; } }

  if (az == null) return unaimed();

  // ONLY A STEERABLE RADIO CAN BE AIMED. Recorded as 'none' rather than
  // pretending, so the row is honest about what actually happened. This is a
  // field read on the resolved bundle — the old code did a MAC comparison here
  // and got it wrong (see decideAim's note).
  if (!radio?.steerable) return unaimed('radio is not on a rotator');

  aimEvents.emit('aiming', { to, az, via: aimTarget, mode });
  const { settled, azActual } = await aimAt(radio, az, opts);
  aimEvents.emit('aimed', { to, az, az_actual: azActual, via: aimTarget, mode, settled });
  return { mode, target: aimTarget, az, az_actual: azActual, beam_deg, settled };
}
