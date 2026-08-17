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
// doorAim (doors.js) and provenDoors (node-kind.js) are no longer imported: both
// served the two rules retired 2026-08-18 when the target reduced to
// node-or-relay. doors.js is untouched and still used elsewhere.
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
// REDUCED TO TWO BRANCHES 2026-08-18, on Peter's instruction: "aims the antenna
// EITHER at the node or it's relay node." Spec: docs/modules/traceroute-flow.md.
//
//   relayed          -> aim at the relay (route[0])          mode 'relay'
//   direct/unknown   -> aim at the node itself               mode 'node'
//
// TWO RULES WERE RETIRED TO GET HERE, and their measurements are recorded so
// re-adding either is an informed choice rather than a rediscovery:
//
//   BYPASS — when the relay was close and hop 2 was a proven direct contact
//   better aligned to the endpoint, aim past the relay at hop 2. 155 measured
//   cases; PJ1 alone had 44 (endpoint 62deg/3km, hop1 T4 at 274deg, hop2 WLCD at
//   62deg/3km). Reaching hop 2 directly removes a hop permanently.
//
//   DO-NOT-ROTATE — when the relay was inside omni reach, spend no movement.
//   That rule was correct while the OMNI transmitted and became wrong once the
//   rotator did: it stopped meaning "we radiate omnidirectionally anyway" and
//   started meaning "fire a 35 degree beam wherever somebody else left the
//   antenna". Measured over the 24 h after that flip: 303 YAGI attempts at
//   aim_mode='none', 7.9% answered, covering 246 DISTINCT azimuths spanning
//   0.85-359.98 degrees.
//
// That second measurement is also why traceroute.run() now REFUSES to dispatch
// on an unconfirmed aim rather than transmitting unaimed.
//
// Every branch records its own mode, so the row says which rule fired.
//
// TAKES A RESOLVED RADIO BUNDLE, not a device string — `radio.steerable` replaced
// a local MAC comparison that once reported "not on the rotator" about the
// rotator itself.
export function decideAim(to, radio) {
  const none = { az: null, aimTarget: null, mode: 'none' };
  let route = null;
  try { route = JSON.parse(stmts.latestRouteTo.get(to)?.route ?? 'null'); } catch { /* no route */ }

  const relay = Array.isArray(route) && route.length ? route[0] : null;

  // RELAYED: aim at the relay. It is the node our transmission actually has to
  // reach, and the measurement above is why this is not the endpoint.
  if (relay != null && relay !== 0xffffffff) {
    const b = bearingToNode(relay);
    if (b != null) return { az: b, aimTarget: relay, mode: 'relay' };
    // The relay's position is unknown, so its bearing cannot be computed. Fall
    // through to the node rather than refusing: a deliberate bearing beats none.
  }

  // DIRECT, or no route known: aim at the node itself. With no route this is not
  // following a path — there isn't one — it is a bet on DIRECT contact, which is
  // the only thing that creates a new relay.
  const b = bearingToNode(to);
  return b == null ? none : { az: b, aimTarget: to, mode: 'node' };
}

/** Point the beam and WAIT FOR IT TO GET THERE.
 *
 *  Returns { settled, azActual }. Never throws: a rotator that will not move
 *  must not stop the caller, it must be recorded as unaimed.
 *
 *  @param radio  a resolved bundle from resolve.js. Must be `steerable`.
 *  @param az     degrees.
 *  @param opts   hold_ms / settle_ms / patience_ms / aim_retries overrides. */
export async function aimAt(bearing, holdMs_, opts = {}) {
  // NULL IS NOT ZERO, AND ZERO IS DUE NORTH.
  //
  // `Number(null) === 0` and `Number('') === 0`, both finite — so a
  // Number.isFinite() guard alone accepts "no bearing" and points the antenna
  // north. Caught by tests/test_aim.mjs on the day this was written, and it is
  // the same coercion that would have put traffic on channel 0 (PRIMARY, the
  // public mesh) if indexFor() had been allowed to return 0 for an unresolved
  // role. Reject the absent value BEFORE coercing it.
  if (bearing == null || bearing === '') return { settled: false, azActual: null };
  const az = Number(bearing);
  if (!Number.isFinite(az)) return { settled: false, azActual: null };

  // WHICH ROTATOR. `aimAt(bearing, hold)` is Peter's signature, so this resolves
  // its own rotator rather than being told — unambiguous while exactly one is
  // connected. Verified 2026-08-18: connected v4, active_target v4; v5
  // (ws://192.168.10.195:81) is a CONFIGURED target and not live — Peter: "v5 is
  // NOT live ATM." When v5 returns this needs telling which, and resolve.js
  // already carries `rotatorId` for exactly that.
  //
  // opts.beam_deg is the TRANSMITTING antenna's beamwidth, used only as the
  // retry tolerance below. Null means "cannot judge, do not retry" — never a
  // guessed default, which would merge a 3-element and a 7-element yagi.
  const beam_deg = opts.beam_deg ?? null;

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
    // THE HOLD IS THE CALLER'S SECOND ARGUMENT. Peter, 2026-08-18: "aim accepts
    // min 2 args bearing and hold time (ms ???) which is the same as the timeout
    // passed to traceroute."
    //
    // That is a 4-6x longer hold than the `discovery.hold_sec` = 15 s it
    // replaces, on a rotator shared with the garage alarm — raised with Peter
    // before he gave the instruction, and recorded in
    // docs/modules/traceroute-flow.md rather than argued again here. The
    // backstop is unchanged and independent: rotator.point() clamps every caller
    // to its own HOLD_CEILING_MS, so no timeout however large becomes a lockout.
    //
    // Falls back to the config only when the caller passes nothing, which keeps
    // aimAt() usable on its own.
    const holdMs = Number.isFinite(Number(holdMs_)) && Number(holdMs_) > 0
      ? Number(holdMs_)
      : (Number(d.hold_sec) > 0 ? Number(d.hold_sec) * 1000 : undefined);
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
    const half  = beam_deg != null ? beam_deg / 2 : null;
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

/** Decide where to point for a TARGET NODE, point there, and return the
 *  provenance that goes on the stored row.
 *
 *  This is the one call traceroute makes, and it is the composition of the two
 *  functions above — decideAim() picks the bearing, aimAt() moves the beam. Both
 *  remain callable on their own, which is the whole point of the split.
 *
 *  Returns { mode, target, az, az_actual, beam_deg, settled } and NEVER THROWS:
 *  the caller decides what an unconfirmed aim means. traceroute.run() treats it
 *  as fatal; something else may not.
 *
 *  @param to       target node num
 *  @param radio    a resolved bundle from resolve.js
 *  @param holdMs   how long to hold the beam — traceroute passes its timeout */
export async function aimForNode(to, radio, holdMs, opts = {}) {
  const beam_deg = radio?.beam_deg ?? null;
  const unaimed  = (note) => ({ mode: 'none', target: null, az: null, beam_deg, settled: false, ...(note ? { note } : {}) });

  // ONLY A STEERABLE RADIO CAN BE AIMED. Recorded rather than pretended, so the
  // row is honest about what actually happened. A directional antenna that is
  // NOT on a rotator lands here — which is a real configuration resolve.js can
  // now express, and which the old code could not.
  if (!radio?.steerable) return unaimed('radio is not on a rotator');

  const { az, aimTarget, mode } = decideAim(to, radio);
  if (az == null) return unaimed('no bearing resolves for the node or its relay');

  aimEvents.emit('aiming', { to, az, via: aimTarget, mode });
  const { settled, azActual } = await aimAt(az, holdMs, { ...opts, beam_deg });
  aimEvents.emit('aimed', { to, az, az_actual: azActual, via: aimTarget, mode, settled });
  return { mode, target: aimTarget, az, az_actual: azActual, beam_deg, settled };
}
