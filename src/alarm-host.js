// The ONE boundary between node-dash and the mt-alarm bridge on :8790.
// Replaces pac-host.js, whose service was stopped under pm2 at 09:35Z on
// 2026-08-12 and will not return on a reboot. Spec: docs/modules/alarm-host.md.
//
// Everything bridge-shaped lives in this file. No other module branches on the
// bridge's types, fields, or message shapes — they call the small surface
// exported here. That was true of pac-host.js and is the only reason this
// migration is one module rather than fourteen.
//
// WHY NOT bridge-*.js: src/bridge-events.js is already mesh-gw's event bridge —
// a different host, a different thing, and older. Two unrelated "bridges" in one
// src/ is worse than the stale name it replaces.
//
// THE WS MESSAGE TYPES ARE DELIBERATELY UNCHANGED (`pac_host_status`,
// `pac_host_queues`, `pac_host_align`). They are the browser's contract, and
// renaming them is a Domain 2 change — this task is Domain 1 only. They are
// stale names describing a live shape, which is the lesser of the two wrongs
// available here.

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { log } from './log.js';
import { fmtAgo } from './format.js';
import { dashMode } from './dash-mode.js';
import { numToNodeId, nodeIdToNum } from './utils.js';

// NOT `BRIDGE_URL` — that name is TAKEN. It is mesh-gw's bridge
// (http://localhost:8001), set in ecosystem.config.cjs and read by bridge.js,
// mesh-send.js, imap-receiver.js and index.js. Using it here silently pointed
// this module at mesh-gw and reported `unreachable (bridge 404)` on the first
// poll after the cutover — the same collision this file's name avoids, walked
// into through the environment instead.
const ALARM_HOST_URL = process.env.ALARM_HOST_URL || 'http://127.0.0.1:8790';
// THERE IS NO POLL INTERVAL IN THIS FILE ANY MORE, AND THAT IS THE POINT.
//
// Peter, 2026-08-13: "GET/HTTP is FORBIDDEN FOR LIVE DATA. NO EXCEPTIONS ...
// the ONLY data that can use POST/GET is for things like form submission."
//
// This module was written 2026-08-12 with SIX pollers — health 30 s, queues 5 s,
// align 2 s, obs 60 s, obs-table 60 s, tx 5 s — against a bridge that was
// advertising `ws /events` the entire time. plugins named that socket in their
// very first message and it was read past; pac-host's polling shape was carried
// over wholesale instead. plugins then deleted seven GET routes on the same rule
// at 07:02Z, and four of them were ones this file polled.
//
// device's own test, api.js:13: "if a caller would have to POLL to keep up, it
// belongs on the WS."
//
// The only GETs left are one-shot snapshots taken at connect. They answer "what
// is true right now" once, and the socket keeps them true afterwards.
const WS_URL = (process.env.ALARM_HOST_URL || 'http://127.0.0.1:8790')
  .replace(/^http/, 'ws');
const RECONNECT_MS = 5000;

// READ FROM THE WIRE, NEVER CHOSEN AND NEVER HARD-CODED. `feedTickMs` is on the
// /health body — it is device's `--feed-tick-ms` operator setting, so a literal
// here would go stale the moment Peter changes it. Both peers warned about this
// independently (device #13, plugins #36).
//
// null means one of two things, and they are handled identically on purpose:
// not learnt yet, or THE TICK CLOCK IS OFF. plugins: "null means the clock is OFF,
// which is a real state and must not be defaulted to 10000: that would claim a
// guarantee that is not running." While null, the silence check is INERT and only
// ping/pong is load-bearing.
let _feedTickMs = null;
// 3 missed ticks, per device's instruction to use a MULTIPLE and never the bare
// value: one tick is always in flight, so a threshold of exactly feedTickMs reads
// real gaps of 10000 and 10001 ms as failures. 1x fires on scheduling jitter, 2x
// on a GC pause, 3x is beyond any plausible pause and still bounds staleness at
// three ticks — against the garage's 900 s beat that is 3% of a cycle, versus the
// 30+ minutes actually observed on 2026-08-13.
const MISSED_TICKS = 3;
/** Probe cadence: one per guaranteed tick once we know it. Before we do, reuse
 *  RECONNECT_MS rather than invent a number — while the tick contract is unknown,
 *  bounding discovery of a dead socket to the same interval we would take to
 *  rebuild one is the only ratio available that is not a guess. */
function pingMs()    { return _feedTickMs ?? RECONNECT_MS; }
/** null while the tick clock is unknown or off — the caller must then not judge
 *  silence at all. */
function silenceMs() { return _feedTickMs == null ? null : _feedTickMs * MISSED_TICKS; }
export const events = new EventEmitter();

let _lastStatus = null; // null until the first push arrives
let _units = [];        // mapped unit view-models, one per DECLARED unit (present or not)
let _sections = null;   // the bridge's own section map, forwarded verbatim — never synthesised
let _queues = {};       // unit num -> queue ledger array
let _obs = {};          // unit !hex id -> observation rows (oldest-first)
let _tx = null;         // last send per unit, from the `send` event
let _counters = null;   // bridge counters, from /plugin/dash/live
let _declared = [];     // unit ids the bridge DECLARES — from the /health FEED
let _heardIds = [];     // unit ids the bridge has HEARD — from the /health FEED
let _state = {};        // !id -> the full unit body, REBUILT on every /state push
let _servedAt = null;   // /state's own serve instant — proof the bridge is still
                        // BUILDING bodies, not merely holding a socket open
let _obsFrames = {};    // !id -> { at, json, decodeError, portnum } from beat/alarm
let _heard = {};        // !id -> { frames, decoded, lastFrameAt, ports } counted off the stream
let _alignModel = null; // last pushed align view-model, null until first poll
let _alignPrevMode = null; // dash mode saved when we forced PASV for an align session
let _schemaHash = null; // /health's schemaHash — logged on change so contract drift is visible

// -- gaps -------------------------------------------------------------------
// The bridge's `sections` map names, for every panel, whether anything can fill
// it and WHO OWNS the hole. A gap is served as its reason, never as absence:
// an empty array from getStoredImages is indistinguishable from "this unit has
// no images", and that conflation is the entire defect this file exists after.
//
// Six panels, two of which fill today. The other four have no route on the
// bridge at all, so we do not poll them — this morning's failure was 1568
// fetches against a dead port in eight seconds, and a gap is not a transient.

function _gapError(name) {
  const s = _sections?.[name];
  const why = s?.why ?? 'no route on the bridge';
  const owner = s?.owner ?? 'unknown';
  return Object.assign(
    new Error(`${name} unavailable: ${why} — ${owner}`),
    { status: 501, gap: name, owner, why },
  );
}

/** True when the bridge says this section has a source. Unknown sections are
 *  treated as gaps: a section the bridge stopped naming is not one we may
 *  assume still works. */
function _sectionOk(name) {
  return _sections?.[name]?.ok === true;
}

/** The bridge's section map, forwarded verbatim. NEVER synthesised here — if
 *  the bridge stops serving it this returns null and the browser says so,
 *  rather than this module inventing an optimistic map. */
export function sections() {
  return _sections;
}

// -- transport --------------------------------------------------------------
// Path-or-query is NOT uniform on this base URL (measured 2026-08-12 15:02Z,
// raised as [path-or-query-8790], open):
//
//   device core routes   PATH param.  GET /state/<!id> returns ONE unit.
//                                     GET /state?unit=<!id> returns 200 and
//                                     EVERY unit — the query is IGNORED, not
//                                     rejected. A client written to the query
//                                     form reads one unit's schedule as
//                                     another's, with a success code.
//   plugin routes        QUERY param. GET /dash/unit?unit=<!id> works;
//                                     /dash/unit/<!id> 404s.
//
// Each call site below therefore states which convention it is using. Until the
// item is answered this codes to the measurement, not to either party's prose.

async function _call(path, options) {
  const res = await fetch(`${ALARM_HOST_URL}${path}`, options);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch { /* non-JSON error body */ }
    throw Object.assign(new Error(`bridge ${res.status}${detail ? `: ${detail}` : ''}`), { status: res.status });
  }
  return res.json();
}

// -- unit mapping -----------------------------------------------------------
// The bridge speaks `!hex` ONLY — measured 2026-08-12, GET /dash unit keys are
// unit, heardAt, rssi, snr, radios, beat, win, and there is no node num
// anywhere on it. node-dash's core speaks node nums throughout. The conversion
// is mechanical (`!hex` IS the num in hex) and happens ONCE, here.
//
// Instants are ISO 8601 strings here; pac-host stamped epoch ms; this repo's
// convention is epoch SECONDS and fmtAgo() takes seconds. That conversion also
// happens once, here. Getting it wrong yields an age ~56000x too large, which
// is obvious, or a silently wrong rate, which is not.

// THE UNIT OBJECT CARRIES EPOCH MILLISECONDS, NOT SECONDS.
//
// That is pac-host's contract and every consumer assumes it: alarm-sections
// calls msToSec(u.beat), msToSec(u.windowMs), msToSec(u.nextWake) and divides
// exactly once itself. Handing it seconds makes it divide a second time.
//
// Measured cost of getting this wrong: nextWake 1755012899 became 1755012 —
// 1970-01-21 — which is always in the past, so "Next window" read `overdue`
// permanently while the bridge's own /state said contact.overdue false. `beat`
// and `windowMs` looked right throughout, because the bridge serves those as
// plain ms durations and they were never double-converted. A units bug that is
// wrong on one field and right on two beside it is the hard kind to see.
function _isoToMs(iso) {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// Fields with NO SOURCE on the bridge today. Rendered as a stated absence
// naming the bridge — never derived from a near-enough substitute. `awake`
// computed from nextWakeAt would be node-dash deciding a fact the bridge did
// not state, which is no more honest here than it would be in the browser.
const NO_SOURCE = 'not served by the bridge';

function _mapUnit(id, state, present, tx) {
  const sched = state?.schedule ?? {};
  const link = state?.link ?? {};
  const meas = state?.measured ?? {};

  return {
    id,
    num: nodeIdToNum(id),
    present,

    // Schedule, with provenance. contact.basis IS the old beatSource flag, and
    // measured.beat.errorMs is the drift that flag was a proxy for. Serving the
    // declared number alone would render a promise the unit did not make: on
    // !987ab80f, declared 60000 against a measured mean of 62862 and a worst
    // late wake of 189622.
    beat:        sched.beat ?? null,
    beatSource:  state?.contact?.basis ?? null,
    beatMeasured: meas.beat
      ? { meanMs: meas.beat.meanMs, errorMs: meas.beat.errorMs, n: meas.beat.n }
      : null,
    windowMs:     sched.win ?? null,
    windowSource: state?.aim?.source ?? null,
    // nextWindowField prints this beneath the countdown. Unmapped it rendered a
    // bare time with no statement of where the schedule came from, which is the
    // thing that distinguishes a promise from a measurement.
    wakeSource:   state?.aim?.source ?? null,

    nextWake:    _isoToMs(state?.aim?.nextWakeAt),
    nextWakeMs:  state?.comms?.nextWakeMs ?? null,
    overdue:     state?.contact?.overdue ?? null,
    missed:      state?.contact?.missed ?? null,

    heardAt: _isoToMs(link.heardAt),
    rssi:    link.rssi ?? null,
    snr:     link.snr ?? null,
    radios:  Array.isArray(link.radios) ? link.radios : [],

    wakesSeen:     meas.beat?.contacts ?? null,
    lateWakes:     meas.lateWakes?.n ?? null,
    lateWakeWorstMs: meas.lateWakes?.worstMs ?? null,

    // TX radio — served by GET /tx since 2026-08-12. The `id` shape is what
    // resolveDeviceLabel() downstream expects; `state` becomes the qualifier
    // line. A unit with nothing sent yet carries the bridge's own `why` rather
    // than a blank, so "not sent to yet" never reads as "we do not know".
    txRadio: tx?.radio
      ? { id: tx.radio, addr: tx.radio, state: tx.channel != null ? `ch ${tx.channel}` : null }
      : null,
    txRadioSource: tx?.radio ? null : (tx?.why ?? NO_SOURCE),
    txAt:   _isoToMs(tx?.at),
    txText: tx?.text ?? null,

    // No source. Stated, not computed. See docs/modules/alarm-host.md field map.
    // `acks` losing its source is ALSO what breaks alarm-sections.js:102,
    // independently of services' outcome-vocabulary change — both causes land
    // on the same field.
    awake:          null, awakeSource:   NO_SOURCE,
    acks:           null, acksSource:    NO_SOURCE,
    wakesExpected:  null,

    // The bridge holds no names. Resolved downstream via node-label.js, the
    // same as any other node — an alarm unit is not a special case for naming.
    name: null,
    shortName: null,
  };
}

// -- WS-fed state; the pollers that used to fill these are gone ------------
//
// THERE IS NO CHANGE-GATE HERE AND THERE MUST NEVER BE ONE AGAIN.
//
// `_statusesEqual` used to compare each incoming body against the last and drop
// it when they matched. That is re-broadcast special-casing, and Peter's rule is
// that there is no such thing to special-case: "they should be treated just like
// every other packet received. They are NOT partial packets."
//
// It is also precisely why the page froze. On /plugin/dash/live the only field
// that moves between pushes is `at`, which the comparison did not even look at —
// so it answered "nothing changed" every 10 s, forever, and nothing reached the
// browser between 900 s beats. A packet arrives; we take it and we push. Always.

/** Ready-to-send WS message describing every commandable unit's queue. */
export function queuesMessage() {
  return { type: 'pac_host_queues', queues: _queues, gap: _sectionOk('outbox') ? null : _sections?.outbox ?? null };
}

/** Cached observation rows for a unit's `!hex` id. The coulomb SERIES has no
 *  source (section `obs`, plugins, unbuilt) — callers must consult sections()
 *  rather than reading emptiness as a measurement. */
export function obsForUnit(unitId) {
  return _obs[unitId] ?? [];
}

/** Antenna-alignment view-model.
 *
 *  GAP TODAY — the align routes have no home on the bridge and ownership is
 *  PARKED (Peter, 2026-08-12, task park-align-ownership).
 *
 *  THE PASV INTERLOCK BELOW SURVIVES REGARDLESS OF WHERE OWNERSHIP LANDS, and
 *  is kept wired rather than deleted. It is node-dash's own machinery: nothing
 *  outside this repo knows dash modes exist. It forces PASV for a session's
 *  duration so the Yagi will not auto-swing mid-burst, and restores the
 *  previous mode on stop. mt-transport flagged it as ours alone to replicate:
 *  "If the Yagi moves during a burst, the readings are silently wrong rather
 *  than obviously broken, which is the worst kind of wrong." */
// NOT ON A TIMER. Align has no source at all today — the section is a gap and
// ownership is parked — so there is nothing to subscribe to and nothing to
// poll. This is kept as a pure state-transition handler so that whoever ends up
// owning align wires it to a feed and the interlock works unchanged. It is
// never called from a clock.
export function applyAlignModel(next) {
  if (!_sectionOk('align')) { _alignModel = null; return; }

  const wasRunning = !!_alignModel?.running;
  const nowRunning = !!next?.running;
  if (nowRunning && !wasRunning && _alignPrevMode == null) {
    _alignPrevMode = dashMode.value;
    dashMode.set(0); // force PASV — see comment above
    log.info('alarm-host', `align session started, forced PASV (was ${_alignPrevMode})`);
  } else if (!nowRunning && wasRunning && _alignPrevMode != null) {
    dashMode.set(_alignPrevMode);
    log.info('alarm-host', `align session ended, restored mode ${_alignPrevMode}`);
    _alignPrevMode = null;
  }

  const changed = JSON.stringify(next) !== JSON.stringify(_alignModel);
  _alignModel = next;
  if (changed) events.emit('alignChanged');
}

/** Ready-to-send WS message describing the current align view-model. */
export function alignMessage() {
  return { type: 'pac_host_align', model: _alignModel, gap: _sectionOk('align') ? null : _sections?.align ?? null };
}

// -- handlers ----------------------------------------------------------------

/** plugins' view model, pushed. { at, bridge, units[], counters }. */
function _onDashLive(msg) {
  if (!Array.isArray(msg?.units)) return;
  _counters = msg.counters ?? null;
  const heard = new Set(msg.units.map(u => u.unit));
  const next = [];
  for (const id of (_declared.length ? _declared : msg.units.map(u => u.unit))) {
    const live = msg.units.find(u => u.unit === id) ?? null;
    // _state[id] is the one-shot snapshot: schedule, contact, aim, measured.
    // The live message carries the fast-moving half; merge rather than replace,
    // or every push would erase beatSource and nextWake.
    next.push(_mapUnit(id, _mergeState(_state[id], live), heard.has(id), _tx?.units?.[id] ?? null));
  }
  _units = next;
  _lastStatus = { available: msg?.bridge?.ok !== false, status: msg?.bridge?.ok === false ? 'degraded' : 'ready',
                  startedAt: _isoToMs(msg?.bridge?.startedAt), lastCheckedMs: Date.now(),
                  servedAt: _servedAt, error: null, units: _units, sections: _sections };
  events.emit('change');
}

/** device's CORE state feed: every unit keyed by `!hex`, plus the bridge's own
 *  `servedAt`. ONE socket for the whole roster, not one per unit.
 *
 *  THIS IS THE FEED THE PAGE'S TIME-SENSITIVE FACTS COME FROM, and it was being
 *  read as a one-shot GET at connect until 2026-08-13 — so `contact.overdueBy`,
 *  `contact.missed`, `dueAt` and every `measured.*` figure were frozen at the
 *  instant the socket opened. device, [events-is-not-a-state-feed]: "use /events
 *  to learn that something HAPPENED; use a feed to learn what is TRUE. Only the
 *  second kind rebuilds." The body is a function, re-invoked per push, so
 *  `contact` is computed from the current clock every time.
 *
 *  The magnitude of a lapse EXISTS ONLY HERE. `overdue` fires as an event once
 *  per lapse by design — device: "six hours of silence is one event, not 360" —
 *  so the event stream gives one edge and never says it got worse. "Silent for
 *  three beats and counting" is unavailable from events at any price. */
function _onState(msg) {
  if (!msg || typeof msg !== 'object') return;
  _servedAt = _isoToMs(msg.servedAt);
  for (const [id, body] of Object.entries(msg)) {
    if (id === 'servedAt') continue;
    _state[id] = body;
  }
  // Re-map from the refreshed bodies so `unitForNum`/`connectMessage` carry the
  // new contact and measured figures rather than the ones mapped at connect.
  _units = _units.map(u => _mapUnit(u.id, _state[u.id] ?? null, u.present, _tx?.units?.[u.id] ?? null));
  if (_lastStatus) _lastStatus = { ..._lastStatus, units: _units, servedAt: _servedAt };
  events.emit('change');
}

/** device's CORE health feed. Carries the DECLARED roster, what has been HEARD,
 *  the schema hash, and `feedTickMs` — the one number this module must never
 *  invent. Was a one-shot GET until 2026-08-13. */
function _onHealth(msg) {
  if (!msg || typeof msg !== 'object') return;
  _declared = Array.isArray(msg.units) ? msg.units : _declared;
  _heardIds = Array.isArray(msg.heard) ? msg.heard : _heardIds;
  if (msg.feedTickMs !== _feedTickMs) {
    log.info('alarm-host', `feedTickMs ${_feedTickMs ?? '(unknown)'} -> ${msg.feedTickMs ?? 'null (tick clock OFF)'}`);
    _feedTickMs = msg.feedTickMs ?? null;
  }
  if (msg.schemaHash && msg.schemaHash !== _schemaHash) {
    log.info('alarm-host', `bridge schemaHash ${_schemaHash ?? '(none)'} -> ${msg.schemaHash}`);
    _schemaHash = msg.schemaHash;
  }
}

/** Fold the live half of a unit into its snapshot. */
function _mergeState(snap, live) {
  if (!live) return snap;
  return {
    ...(snap || {}),
    schedule: { ...(snap?.schedule || {}), beat: live.beat, win: live.win },
    link: { ...(snap?.link || {}), heardAt: live.heardAt, rssi: live.rssi, snr: live.snr,
            radios: live.radios },
  };
}

/** device's event stream. One JSON event per message, in publish order. */
function _onBridgeEvent(ev) {
  const unit = ev?.unit;
  if (!unit) return;

  switch (ev.type) {
    // THE RUNTIME PARAMS. frame.json IS the parameters — already through
    // device's decoder once, which is the only decode in the system. Reading a
    // field off it is not decoding and never was (plugins, 2026-08-13).
    case 'beat':
    case 'alarm': {
      const f = ev.frame;
      if (!f) break;
      const prev = _obsFrames[unit];
      // A FRAME THAT FAILED TO DECODE MUST NOT ERASE THE VALUES WE ALREADY HAVE.
      //
      // BNCH emits both `alarm` frames (which decode, json present) and `beat`
      // frames (which on this firmware carry json:null plus a decodeError).
      // Overwriting blindly meant the panel showed 18 fields for one second and
      // then "nothing received" for the rest of the minute — measured, and the
      // reason this comment exists.
      //
      // The parameters are the LAST SUCCESSFUL decode; a later failure is a
      // fault to report beside them, not a reason to forget what the device
      // already told us.
      _obsFrames[unit] = {
        at:          f.json ? (f.at ?? ev.at) : (prev?.at ?? null),
        json:        f.json ?? prev?.json ?? null,
        jsonAt:      f.json ? (f.at ?? ev.at) : (prev?.jsonAt ?? null),
        decodeError: f.decodeError ?? null,
        portnum:     f.portnum ?? prev?.portnum ?? null,
      };
      _bumpHeard(unit, f.decodeError ? 0 : 1);
      events.emit('change');
      break;
    }
    // TX radio, verbatim off the event that already carried it.
    case 'send':
      _tx = _tx || { units: {} };
      _tx.units[unit] = { radio: ev.radio ?? null, channel: ev.channel ?? null,
                          at: ev.at ?? null, text: ev.text ?? null };
      events.emit('change');
      break;
    // Contact EDGES. The values are NOT taken from here: an `overdue` event fires
    // ONCE per lapse by design (device: "six hours of silence is one event, not
    // 360"), so it marks the transition and can never say the lapse got worse.
    // The magnitude — overdueBy, missed, dueAt — is rebuilt on every /state push
    // and is read from there.
    //
    // These two cases previously wrote a `_contact` map that NOTHING READ (ledger
    // B106) while `_mapUnit` took the same fields from a connect-time snapshot.
    // Both halves were wrong. The edge is still news, so it still pushes.
    case 'overdue':
    case 'returned':
      events.emit('change');
      break;
    case 'witness':
      _bumpHeard(unit, 0);
      break;
  }
}

/** Frame accounting per unit, so the Runtime params panel can say "heard N,
 *  decoded M" without any of it being a guess. Counted from the stream itself. */
function _bumpHeard(unit, decoded) {
  const h = _heard[unit] || (_heard[unit] = { frames: 0, decoded: 0, lastFrameAt: null, ports: [] });
  h.frames += 1;
  h.decoded += decoded;
  h.lastFrameAt = new Date().toISOString();
}

// -- the two sockets ---------------------------------------------------------

/** Connect one socket, resubscribing forever. `onOpen` runs on every (re)connect
 *  because a reconnect means we missed events and the snapshot must be retaken —
 *  a socket that comes back without re-priming shows the state it had when it
 *  dropped, indefinitely, with no indication anything was missed. */
function _socket(path, onMessage, onOpen) {
  let ws = null, timer = null, closed = false, watchdog = null;
  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`${WS_URL}${path}`);

    // -- liveness -----------------------------------------------------------
    // WITHOUT THIS, A DEAD SOCKET IS INVISIBLE. A TCP connection that dies with
    // no FIN — a restarted peer, an expiring NAT entry, a dropped route — emits
    // neither 'close' nor 'error', so the reconnect below never fires and the
    // page freezes with no end. On 2026-08-13 that showed the garage last heard
    // 39 minutes ago when it had been heard 10.6 minutes ago; two beats were
    // missed, the first of them BEFORE the bridge restarted, so the restart was
    // not the cause. Spec: docs/modules/alarm-socket-watchdog.md.
    let lastMsgAt = Date.now();
    let awaitingPong = false;
    // DELIBERATELY SEPARATE. A pong clears only the pong flag; it must NOT touch
    // lastMsgAt, or a peer that answers pings while publishing nothing looks
    // healthy forever — which is the exact fault this watchdog exists to catch,
    // and the `ws` library auto-answers pings at the protocol layer, so that
    // peer is the common case rather than a hypothetical.
    const sawMessage = () => { lastMsgAt = Date.now(); awaitingPong = false; };
    const sawPong    = () => { awaitingPong = false; };

    // RE-ARMED EACH TIME rather than a fixed setInterval, because the period is
    // read from the wire: feedTickMs arrives on the /health feed AFTER this
    // socket is already up, and a captured interval would keep probing at the
    // bootstrap cadence for the life of the connection.
    const probe = () => {
      const silentMs = Date.now() - lastMsgAt;
      const limit = silenceMs();
      // BOTH checks, because they catch different faults: a pong proves the
      // CONNECTION is alive but says nothing about data flowing, and the
      // silence check catches an attached socket whose peer stopped publishing.
      // `limit` is null while the tick clock is unknown or OFF — then silence
      // proves nothing and only the pong is load-bearing. Judging silence
      // against a guessed interval would report false stalls on a bridge that
      // is behaving exactly as configured.
      if ((limit != null && silentMs > limit) || awaitingPong) {
        log.warn('alarm-host',
          `${path} STALLED — no traffic for ${Math.round(silentMs / 1000)}s` +
          `${limit != null ? ` (limit ${Math.round(limit / 1000)}s = ${MISSED_TICKS} ticks)` : ' (no tick clock)'}` +
          `${awaitingPong ? ' and no pong' : ''}; terminating to force a reconnect`);
        awaitingPong = false;
        try { ws.terminate(); } catch { /* already gone */ }
        return;   // terminate synthesises 'close'; that path reconnects and re-primes
      }
      awaitingPong = true;
      try { ws.ping(); } catch { /* the close handler will pick it up */ }
      watchdog = setTimeout(probe, pingMs());
    };
    watchdog = setTimeout(probe, pingMs());

    ws.on('pong', sawPong);

    ws.on('open', () => { log.info('alarm-host', `${path} connected`); sawMessage(); onOpen?.(); });
    ws.on('message', buf => {
      sawMessage();   // ANY frame proves attachment, `tick` included — that is its purpose
      let msg; try { msg = JSON.parse(buf); } catch { return; }
      try { onMessage(msg); }
      // A throw in a handler must not take the socket down with it. The stream
      // is the only live source now, so an unhandled shape would otherwise end
      // every panel at once.
      catch (e) { log.warn('alarm-host', `${path} handler failed: ${e.message}`); }
    });
    ws.on('close', () => {
      clearTimeout(watchdog); watchdog = null;   // or every reconnect adds another
      if (closed) return;
      log.warn('alarm-host', `${path} closed — reconnecting in ${RECONNECT_MS}ms`);
      timer = setTimeout(connect, RECONNECT_MS);
    });
    ws.on('error', err => {
      const bits = [err?.code, err?.syscall, err?.message].filter(Boolean);
      log.warn('alarm-host', `${path} error: ${bits.join(' · ') || String(err)}`);
    });
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(watchdog);   // a stopped socket must not keep probing
    try { ws?.close(); } catch {}
  };
}

let _closers = [];

/** THE ONLY GET LEFT, and it is the one route on the bridge that REFUSES a socket
 *  upgrade — measured 2026-08-13: `ws /dash/sections` -> 404, while /health,
 *  /state, /stats, /events and /plugin/dash/live all open.
 *
 *  It is plugins' route. Raised with them as [sections-refuses-socket-upgrade];
 *  either it becomes a feed or they confirm it is static by design, and this
 *  comment records their answer. It is NOT worked around here, and it must never
 *  acquire a timer to "refresh" it.
 *
 *  Re-run on every RECONNECT, because a reconnect means we were detached and the
 *  gap map may have moved while we were not listening.
 *
 *    GET /dash/sections  which panels can be filled and who owns each gap. */
async function _primeSections() {
  try { _sections = (await _call('/dash/sections'))?.sections ?? null; }
  catch (e) { log.warn('alarm-host', `sections snapshot failed: ${e.message}`); _sections = null; }
  events.emit('change');
}

/** Subscribe. Idempotent — a second call is a no-op. Never blocks. */
export function start() {
  if (_closers.length) return;

  // CORE health: the DECLARED roster, what has been HEARD, schemaHash, and
  // feedTickMs. `present` is declared-vs-heard and lives here and nowhere else —
  // a declared unit that has gone quiet must still render, or the roster shrinks
  // instead of showing a unit in trouble.
  _closers.push(_socket('/health', _onHealth));

  // CORE state, ONE socket for every unit. The rebuilt bodies: schedule,
  // contact.*, aim.nextWakeAt, measured.*, and servedAt. This is the feed that
  // answers "when was it last heard, and is its beat on schedule" — the
  // questions Peter has been having to ask an agent because the page could not
  // answer them.
  _closers.push(_socket('/state', _onState));

  // plugins' aggregated view model: bridge, units, counters. Pushed on every
  // bridge event, so `heardAt`/`rssi`/`beat` are current without asking.
  _closers.push(_socket('/plugin/dash/live', _onDashLive));

  // device's own EVENT stream — witness / beat / alarm / send / overdue /
  // returned. It says what HAPPENED; it is not a state feed and must never be
  // read as one. The runtime params and the TX radio come from here: /obs and
  // /tx were DELETED rather than moved, because both were re-serving what these
  // events already carry, and a plugin in the middle is a second surface that
  // can only drift.
  _closers.push(_socket('/events', _onBridgeEvent, _primeSections));
}

/** Close every socket and clear cached state (tests, shutdown).
 *
 *  THIS FUNCTION USED TO THROW. Its first statement assigned to `_obsTable`, a
 *  variable declared nowhere in this module — and an ES module is strict mode, so
 *  that is a ReferenceError, not an implicit global. Every line below it was
 *  unreachable. It survived because nothing in src/ calls stop() today (ledger
 *  B105); it would have fired the first time a test or a shutdown path did.
 *
 *  The intent was plainly to clear the obs table, which is held in `_obsFrames`
 *  and `_heard` — so that is what it now clears. */
export function stop() {
  for (const close of _closers) close();
  _closers = [];
  _obsFrames = {};
  _heard = {};
  _tx = null;
  _lastStatus = null;
  _units = [];
  _sections = null;
  _queues = {};
  _alignModel = null;
  _alignPrevMode = null;
  _obs = {};
  // The feeds' own state. _feedTickMs returns to null rather than to a number:
  // after stop() we have not read it from the wire, and pretending otherwise
  // would arm a silence threshold against a value nobody served.
  _state = {};
  _servedAt = null;
  _declared = [];
  _heardIds = [];
  _feedTickMs = null;
  _schemaHash = null;
}

export function isAvailable() {
  return !!_lastStatus?.available;
}

function _status() {
  return _lastStatus ?? {
    available: false, status: 'unreachable', units: [], sections: null,
    startedAt: null, lastCheckedMs: null, servedAt: null, error: null,
  };
}

/** The instant the bridge last BUILT a state body, from `/state`'s own servedAt.
 *
 *  THIS IS THE ANSWER TO "IS WHAT I AM LOOKING AT STALE?", and it is a different
 *  question from "is the socket open". An attached socket served by a wedged
 *  process passes every liveness check and serves nothing — device named that
 *  case explicitly when they shipped the field. A page that cannot say "my link
 *  to the bridge is stale" makes a healthy device look dead.
 *
 *  Epoch ms, or null before the first /state push. The AGE of it is not computed
 *  here: whoever renders it serves the string, and the browser calculates
 *  nothing. */
export function servedAt() {
  return _servedAt;
}

/** Ready-to-send WS message describing the bridge's current state.
 *  Type string unchanged — see the header note on Domain 2. */
export function connectMessage() {
  return { type: 'pac_host_status', ..._status() };
}

/** The unit the bridge holds for a node num, or null if it holds none.
 *  Read-only view of the LAST POLL — never a fetch, so callers on a request
 *  path (node-status's reachability section) cost nothing and cannot block.
 *  Staleness is bounded by HEALTH_POLL_MS and is why `change` hints
 *  node_status (see ws-relay). */
export function unitForNum(num) {
  return _units.find(u => Number(u.num) === Number(num)) ?? null;
}

/** Node nums of every unit the bridge holds, present or not. Used to hint
 *  node_status when the roster changes — a sleeping unit's reachability facts
 *  must keep refreshing precisely BECAUSE no packet is arriving from it. */
export function unitNums() {
  return _units.map(u => Number(u.num)).filter(Number.isFinite);
}

// -- commands ---------------------------------------------------------------

/** Queue a command for a unit. Pure passthrough — no verb validation, no mesh
 *  mechanics; the bridge owns what a verb means.
 *
 *  QUEUING IS NOT DELIVERY. This returns on ACCEPTANCE. Whether it reached the
 *  unit is answered by the unit's state and by the reply event, never by this
 *  response — the device is deaf roughly 99% of the time (8 s of listening per
 *  wake), so a command genuinely does sit and wait (plugins, 2026-08-12). */
export async function queueCommand({ unit, verb, args }) {
  return _call('/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit, verb, ...(args !== undefined ? { args } : {}) }),
  });
}

// -- gap-bound surface ------------------------------------------------------
// Every export below has NO ROUTE on the bridge today. Each throws a stated
// reason carrying the section's owner and why. None returns empty, null, or a
// faked shape: an empty array from getStoredImages is indistinguishable from
// "this unit has no images", and that conflation is the defect this file was
// written after. When a gap closes upstream the section flips to ok and these
// start working with no deploy here.

/** One unit's queue ledger — the receipt-polling primitive. Section `outbox`. */
export async function getQueue(unit) {
  if (!_sectionOk('outbox')) throw _gapError('outbox');
  return _call(`/queue/${encodeURIComponent(unit)}`);
}

/** THE RUNTIME-PARAMS TABLE. `GET /obs` — NOT the coulomb series.
 *
 *  Two different things share the word `obs` and conflating them would put a
 *  "no data" message on a panel that has data, or vice versa:
 *
 *    THE TABLE   what is this device saying right now — latest value per wire
 *                key, driven by device/schema/frames.json, the SSOT the
 *                firmware's MtSchema.h is generated from. Needs no store, so it
 *                shipped 2026-08-12 while `record` is still unbuilt.
 *    THE SERIES  how has this number moved. Needs the store. Still a gap, and
 *                the same payload carries `series: null` + `seriesWhy` saying so
 *                deliberately, so it cannot be mistaken for the table.
 *
 *  FOUR ROW STATES, and the difference between them is the whole point:
 *
 *    arrived                     value, ty, label, at
 *    declared `must`, absent     A DEFECT — also named in missingMust
 *    declared `opt`, absent      normal, still listed; an absent optional is information
 *    arrived, UNDECLARED         THE FINDING — firmware sends what the schema does not know
 *
 *  An undeclared key is served with `value: null, withheld: true` — the KEY is
 *  the finding, the VALUE of an unvetted field is the risk. plugins' reason:
 *  classify() maps TELEMETRY/POSITION/NODEINFO all to `beat`, so a position
 *  payload arrives on the same event class, and lat/lon lives in there. None of
 *  the 18 declared fields is positional, so the safe set and the useful set are
 *  the same set. Do not render a withheld value; render the key.
 *
 *  BUILT FROM THE `beat` AND `alarm` EVENTS, NOT FROM A ROUTE. plugins deleted
 *  GET /obs at 07:02Z rather than moving it, because it was re-serving what
 *  those events already carry: `frame.json` IS the runtime parameters, already
 *  through device's decoder once. A plugin in the middle of that is a second
 *  surface over our own feed which can only drift.
 *
 *  Read-only view of what the socket has delivered — `buildNodeStatus` is
 *  SYNCHRONOUS and cannot await. */
export function obsTableForUnit(unitId) {
  const f = _obsFrames[unitId];
  const h = _heard[unitId];
  if (!f && !h) return null;
  const json = f?.json ?? null;
  return {
    // The instant of the last SUCCESSFUL decode, not of the last frame — a
    // value's age is when it was read, not when something else arrived.
    at: f?.jsonAt ?? f?.at ?? null,
    // Every key the device actually sent, as key/value. The field set changes
    // when firmware changes, so nothing here is hand-picked.
    fields: json
      ? Object.entries(json).map(([key, value]) => ({
          key, value, state: 'arrived', label: null, req: null, withheld: false,
        }))
      : [],
    missingMust: [],
    heard: h ? {
      frames: h.frames,
      decoded: h.decoded,
      lastFrameAt: h.lastFrameAt,
      ports: f?.portnum != null ? [{ port: String(f.portnum), ours: true, frames: h.frames,
                                     decoded: h.decoded, errors: h.frames - h.decoded,
                                     lastError: f?.decodeError ?? null }] : [],
      // The bridge's own sentence, verbatim — this is where GARG's
      // "built against 0xbaf7, this butler loaded 0xd339" arrives.
      why: f?.decodeError ?? null,
    } : null,
  };
}

/** Schema provenance no longer arrives as a block — the events carry decoded
 *  values or a stated decodeError, and there is no separate declared-count to
 *  report. Returns null so the section renders what it has rather than a
 *  fabricated "0 of 18". */
export function obsTableSchema() {
  return null;
}

/** A unit's stored observation SERIES (the coulomb counters). Still a gap.
 *
 *  THIN ON PURPOSE. This file is a proxy and a poller; it does not know what
 *  `n` means. The subtraction, the verdicts and the display strings live in
 *  src/coulomb.js — putting them here would put business logic in the transport
 *  boundary. Same split as snapshot-api.js and node-status.js.
 *
 *  `unit` MUST be the `!hex` id; short names do not resolve. */
export async function getObs(unit, { field, since, until, limit } = {}) {
  // THE SERIES HAS NO SOURCE AND MUST NOT BE FAKED FROM THE STREAM.
  // `beat`/`alarm` carry the LATEST value per field, which is the table. A
  // history is a different thing: it needs the `record` plugin, which is
  // unbuilt. Accumulating events into a series here would produce a chart that
  // starts whenever node-dash last restarted and looks like a measurement.
  const why = 'no history store — the series needs `record`, which is unbuilt';
  throw Object.assign(new Error(`coulomb series unavailable: ${why} — plugins`),
                      { status: 501, gap: 'obs-series', owner: 'plugins', why });
}

/** In-flight image transfers for a unit. Section `images`. */
export async function getImagesProgress(unit) {
  if (!_sectionOk('images')) throw _gapError('images');
  return _call(`/images/progress?unit=${encodeURIComponent(unit)}`);
}

/** Images already held on disk for a unit. Section `images`. */
export async function getStoredImages(unit) {
  if (!_sectionOk('images')) throw _gapError('images');
  return _call(`/images/stored?unit=${encodeURIComponent(unit)}`);
}

/** What the device is CURRENTLY HOLDING — one payload, not a list.
 *
 *  RADIO ROUND-TRIP when it exists. NEVER call this on a timer: airtime is the
 *  scarcest thing in this project and the deployed unit listens ~8 s in every
 *  900. User-initiated only. */
export async function getDeviceImage(unit, { timeoutMs = 20000 } = {}) {
  if (!_sectionOk('images')) throw _gapError('images');
  return _withTimeout(`/images?unit=${encodeURIComponent(unit)}`, timeoutMs, true);
}

/** Bytes of one stored image BY ITS STABLE ID. Preferred over the pid form: an
 *  id names exactly one stored blob, whereas a pid recycles. Section `images`. */
export async function getImageById(unit, id, { timeoutMs = 5000 } = {}) {
  if (!_sectionOk('images')) throw _gapError('images');
  return _withTimeout(`/images/by-id?unit=${encodeURIComponent(unit)}&id=${encodeURIComponent(id)}`, timeoutMs);
}

/** The BYTES of one stored image. Section `images`.
 *
 *  `refresh` FORCES THE RADIO PATH and deliberately skips the store. Without
 *  it, a re-download of an image already held is answered from disk in
 *  milliseconds and never reaches the device — correct for VIEWING and a silent
 *  lie for RE-DOWNLOADING. Only ever set from a deliberate, confirmed user
 *  action: it costs minutes and a wake window. */
export async function getImageBytes(unit, pid, { timeoutMs = 5000, refresh = false } = {}) {
  if (!_sectionOk('images')) throw _gapError('images');
  const r = refresh ? '&refresh=1' : '';
  return _withTimeout(`/images/bytes?unit=${encodeURIComponent(unit)}&pid=${encodeURIComponent(pid)}${r}`, timeoutMs);
}

async function _withTimeout(path, timeoutMs, asJson = false) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${ALARM_HOST_URL}${path}`, { signal: ac.signal });
    if (!res.ok) throw Object.assign(new Error(`bridge ${res.status}`), { status: res.status });
    if (asJson) return res.json();
    return {
      buf:  Buffer.from(await res.arrayBuffer()),
      type: res.headers.get('content-type') || 'image/jpeg',
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error(`bridge did not answer in ${timeoutMs}ms`), { status: 504 });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Open/retarget an align session and fire one burst. Section `align`, and
 *  ownership is PARKED — see _pollAlign. */
export async function alignPing({ target, n }) {
  if (!_sectionOk('align')) throw _gapError('align');
  return _call('/align/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, ...(n !== undefined ? { n } : {}) }),
  });
}

/** End the current align session. Section `align`. */
export async function alignStop() {
  if (!_sectionOk('align')) throw _gapError('align');
  return _call('/align/stop', { method: 'POST' });
}

/** Set the server-persisted reply-wait window (5-120s). Section `align`. */
export async function alignConfig({ replyWindowSec }) {
  if (!_sectionOk('align')) throw _gapError('align');
  return _call('/align/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyWindowSec }),
  });
}

// numToNodeId is imported for callers that hand us a num; re-exported so the
// thirteen importers have one place to get both halves of the identity map.
export { numToNodeId, nodeIdToNum };
