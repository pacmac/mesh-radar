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
const HEALTH_POLL_MS = 30000;
const QUEUE_POLL_MS = 5000;
const ALIGN_POLL_MS = 2000; // faster than the queue poll — burst progress (~30s) should feel live
// The device reports observations on a ~900 s beat, so 60 s is already 15x
// faster than the data can change. Anything quicker polls for samples that
// cannot exist yet. See _pollObs.
const OBS_POLL_MS = 60000;
const OBS_POLL_LIMIT = 200;

export const events = new EventEmitter();

let _timer = null;
let _queueTimer = null;
let _alignTimer = null;
let _obsTimer = null;
let _obsTableTimer = null;
let _txTimer = null;
let _lastStatus = null; // null until the first poll resolves
let _units = [];        // mapped unit view-models, one per DECLARED unit (present or not)
let _sections = null;   // the bridge's own section map, forwarded verbatim — never synthesised
let _queues = {};       // unit num -> queue ledger array
let _obs = {};          // unit !hex id -> observation rows (oldest-first)
let _obsTable = null;   // GET /obs — the runtime-params table, estate-wide, one call
let _tx = null;         // GET /tx — last send per unit (radio, channel, at, text)
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

// -- polling ----------------------------------------------------------------

function _statusesEqual(a, b) {
  return a.status === b.status
    && a.available === b.available
    && JSON.stringify(a.sections) === JSON.stringify(b.sections)
    && JSON.stringify(a.units) === JSON.stringify(b.units);
}

/** Health, sections and the unit roster in one cycle.
 *
 *  `present` comes from /health, which returns `units` (DECLARED) and `heard`
 *  as separate arrays. /dash's summary carries no such flag. A present:false
 *  unit MUST be rendered, never dropped: a unit silent for a day disappearing
 *  from the list shows a shrinking roster instead of a unit in trouble, and
 *  silence is the exact thing the panel exists to display.
 *
 *  `startedAt` also comes from /health. /dash serves it as null with a stated
 *  reason (plugins' own known bug — the value is unreachable from a plugin).
 *  Reading /health is not a workaround for a peer's defect; it is reading the
 *  authoritative source. */
async function _poll() {
  let result;
  let health = null;
  try {
    health = await _call('/health');
    result = {
      available: health?.ok === true,
      status: health?.ok === true ? 'ready' : 'degraded',
      startedAt: _isoToMs(health?.startedAt),
      lastCheckedMs: Date.now(),
      error: null,
    };
  } catch (e) {
    result = { available: false, status: 'unreachable', startedAt: null, lastCheckedMs: Date.now(), error: e.message };
  }

  if (health?.schemaHash && health.schemaHash !== _schemaHash) {
    // Contract drift becomes visible instead of being discovered as a shape bug.
    log.info('alarm-host', `bridge schemaHash ${_schemaHash ?? '(none)'} -> ${health.schemaHash}`);
    _schemaHash = health.schemaHash;
  }

  if (result.available) {
    try {
      const dash = await _call('/dash'); // plugin route, no params
      _sections = dash?.sections ?? null;
    } catch (e) {
      log.warn('alarm-host', `dash fetch failed: ${e.message}`);
      _sections = null;
    }

    // /tx is read BEFORE the units are mapped, not beside them. It has its own
    // faster timer, but on the FIRST cycle that timer has not run yet, so
    // _mapUnit would stamp every unit's txRadioSource with the generic "not
    // served by the bridge" instead of the bridge's real reason ("nothing has
    // been sent to this unit since this plugin started") — and it would say so
    // for a full 30 s. Same shape as the obs-prime no-op this file already
    // carries a comment about: a prime that runs beside the thing it depends on
    // is a prime that has not run.
    await _pollTx();

    const declared = Array.isArray(health?.units) ? health.units : [];
    const heard = new Set(Array.isArray(health?.heard) ? health.heard : []);
    const next = [];
    for (const id of declared) {
      let state = null;
      try {
        // DEVICE CORE ROUTE — path param. The query form returns every unit
        // with a 200; see the transport note above.
        state = await _call(`/state/${encodeURIComponent(id)}`);
      } catch (e) {
        log.warn('alarm-host', `state fetch failed for ${id}: ${e.message}`);
      }
      next.push(_mapUnit(id, state, heard.has(id), _tx?.units?.[id] ?? null));
    }
    _units = next;
  } else {
    _units = [];
    _sections = null;
  }
  result.units = _units;
  result.sections = _sections;

  const changed = !_lastStatus || !_statusesEqual(_lastStatus, result);
  _lastStatus = result;
  if (changed) {
    log.info('alarm-host', `status: ${result.status}${result.error ? ` (${result.error})` : ''}, ${_units.length} unit(s)`);
    events.emit('change');
  }
}

/** Per-unit command ledger.
 *
 *  GAP TODAY — the bridge has no route listing commands sent and their outcome
 *  (section `outbox`, owner device). We do NOT poll a route that does not
 *  exist: this morning's failure was 1568 fetches against a dead port in eight
 *  seconds, and a gap is not a transient. The ledger stays empty and the panel
 *  renders the gap's stated reason. */
async function _pollQueues() {
  if (!isAvailable() || !_sectionOk('outbox')) { _queues = {}; return; }
  const next = {};
  for (const u of _units) {
    try {
      const ledger = await getQueue(u.id);
      // Live (unsettled: queued/trying) rows age from createdAt — how long it
      // has been waiting. Settled rows age from settledAt — when it actually
      // finished — not createdAt, or a reply that took 66 minutes to arrive
      // reads as though it landed the moment it was queued (task
      // settled-age-wrong-timestamp, 2026-07-25).
      next[u.num] = Array.isArray(ledger)
        ? ledger.map(e => {
            const live = e.state === 'queued' || e.state === 'trying';
            const ts = live ? e.createdAt : (e.settledAt ?? e.createdAt);
            return { ...e, since: fmtAgo(Math.floor((ts ?? 0) / 1000)) };
          })
        : [];
    } catch (e) {
      log.warn('alarm-host', `queue fetch failed for ${u.id}: ${e.message}`);
      next[u.num] = _queues[u.num] ?? []; // keep last-known rather than blank on a transient error
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(_queues);
  _queues = next;
  if (changed) events.emit('queuesChanged');
}

/** Ready-to-send WS message describing every commandable unit's queue. */
export function queuesMessage() {
  return { type: 'pac_host_queues', queues: _queues, gap: _sectionOk('outbox') ? null : _sections?.outbox ?? null };
}

/** Keep each unit's observation series warm.
 *
 *  WHY POLL AT ALL, when the Stats pane already fetches on demand: the node
 *  page contributes its coulomb section through `registerNodeSection`, and
 *  `buildNodeStatus` is SYNCHRONOUS — a provider cannot await a fetch. It needs
 *  the rows already in hand.
 *
 *  GAP TODAY — no series store exists on the bridge; the record plugin is
 *  unbuilt (section `obs`, owner plugins). The coulomb feature shipped
 *  2026-08-09 across b86b44e/40bbb17/1bfccea and has no data source until that
 *  lands. It renders the gap's reason, NOT an empty series: blanking would say
 *  "this unit has no gauge", which is a different and false claim. */
/** The runtime-params table. One call for the whole estate — the response is
 *  keyed by unit, so this does not scale with unit count.
 *
 *  NOT gated on the `obs` section. That entry describes the SERIES store, which
 *  is still unbuilt; the table shipped separately and answers today. Gating this
 *  on it would hide a working panel behind an unrelated gap.
 *
 *  A failed poll KEEPS THE LAST TABLE rather than blanking it — same rule as the
 *  queue and series polls. Blanking would read as "this device reports nothing",
 *  which is a claim about the firmware rather than about our connection. */
async function _pollObsTable() {
  if (!isAvailable()) { _obsTable = null; return; }
  try {
    const next = await getObsTable();
    const changed = JSON.stringify(next) !== JSON.stringify(_obsTable);
    _obsTable = next;
    if (changed) events.emit('change');
  } catch (e) {
    log.warn('alarm-host', `obs table fetch failed: ${e.message}`);
  }
}

/** Last send per unit — which radio transmitted to it, on what channel, when,
 *  and the command text.
 *
 *  plugins built this off the bridge's `before:send` hook, which already carries
 *  {unit, text, radio, channel} past them. It is the ONE of the four null fields
 *  that needed nobody's permission: the data was already flowing.
 *
 *  LATEST ONLY, overwritten, no history — as specified. A unit with nothing sent
 *  gets null WITH a `why` rather than being omitted, because an omitted entry
 *  reads as "no such unit" and there would be no way to tell the difference.
 *
 *  `text` is OUR command string, never a device payload, so nothing in it is
 *  withheld — unlike the obs table, where an undeclared value may carry position. */
async function _pollTx() {
  if (!isAvailable()) { _tx = null; return; }
  try {
    const next = await _call('/tx');
    const changed = JSON.stringify(next) !== JSON.stringify(_tx);
    _tx = next;
    if (changed) events.emit('change');
  } catch (e) {
    log.warn('alarm-host', `tx fetch failed: ${e.message}`);
  }
}

async function _pollObs() {
  if (!isAvailable() || !_sectionOk('obs')) { _obs = {}; return; }
  const next = {};
  for (const u of _units) {
    try {
      next[u.id] = await getObs(u.id, { limit: OBS_POLL_LIMIT }) || [];
    } catch (e) {
      log.warn('alarm-host', `obs fetch failed for ${u.id}: ${e.message}`);
      next[u.id] = _obs[u.id] ?? [];
    }
  }
  _obs = next;
}

/** Cached observation rows for a unit's `!hex` id, oldest-first as served.
 *  Empty array when never polled or genuinely empty — the CALLER decides what
 *  an empty series means, because "no gauge" and "no samples yet" are not the
 *  same fact and this layer cannot tell them apart. With `obs` a gap, callers
 *  must consult sections() rather than reading emptiness as a measurement. */
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
async function _pollAlign() {
  if (!isAvailable() || !_sectionOk('align')) { _alignModel = null; return; }
  let next;
  try {
    next = await _call('/align');
  } catch (e) {
    log.warn('alarm-host', `align poll failed: ${e.message}`);
    return; // keep last-known model rather than blanking on a transient error
  }

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

/** Begin polling. Idempotent — a second call is a no-op. Never blocks: the
 *  first poll runs asynchronously, so node-dash serves pages before it resolves. */
export function start() {
  if (_timer) return;
  // Held so the obs prime below can wait for the roster this resolves. Callers
  // still do not await start() — nothing else depends on the first poll.
  const _pollPromise = _poll();
  _timer = setInterval(_poll, HEALTH_POLL_MS);
  _queueTimer = setInterval(_pollQueues, QUEUE_POLL_MS);
  _alignTimer = setInterval(_pollAlign, ALIGN_POLL_MS);
  _obsTimer = setInterval(_pollObs, OBS_POLL_MS);
  _obsTableTimer = setInterval(_pollObsTable, OBS_POLL_MS);
  // /tx changes only when WE send, so it rides the queue cadence rather than
  // the slow obs one — a command's radio should appear while the page is still
  // being looked at.
  _txTimer = setInterval(_pollTx, QUEUE_POLL_MS);
  // Prime AFTER the first poll resolves, not beside it. `_poll()` above is
  // deliberately not awaited, so at this point `_lastStatus` is still null,
  // `isAvailable()` is false and a bare `_pollObs()` returns immediately having
  // done nothing — silently, because that early return has nothing to say.
  //
  // Measured on pac-host: the section was then absent for the first 60 s after
  // every restart. That is exactly the "a blank reads as no gauge" failure this
  // prime exists to prevent.
  _pollPromise.then(() => { _pollObs(); _pollObsTable(); _pollTx(); });
}

/** Stop polling and clear cached status (tests, shutdown). */
export function stop() {
  if (_timer) clearInterval(_timer);
  if (_queueTimer) clearInterval(_queueTimer);
  if (_alignTimer) clearInterval(_alignTimer);
  if (_obsTimer) clearInterval(_obsTimer);
  if (_obsTableTimer) clearInterval(_obsTableTimer);
  if (_txTimer) clearInterval(_txTimer);
  _timer = null;
  _queueTimer = null;
  _alignTimer = null;
  _obsTimer = null;
  _obsTableTimer = null;
  _txTimer = null;
  _obsTable = null;
  _tx = null;
  _lastStatus = null;
  _units = [];
  _sections = null;
  _queues = {};
  _alignModel = null;
  _alignPrevMode = null;
  _obs = {};
}

export function isAvailable() {
  return !!_lastStatus?.available;
}

function _status() {
  return _lastStatus ?? {
    available: false, status: 'unreachable', units: [], sections: null,
    startedAt: null, lastCheckedMs: null, error: null,
  };
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
 *  Estate-wide in one call — the response is keyed by unit. No per-unit fetch. */
export async function getObsTable() {
  return _call('/obs');
}

/** Cached runtime-params table for a unit's `!hex` id, or null before the first
 *  poll. Read-only view — `buildNodeStatus` is SYNCHRONOUS and cannot await. */
export function obsTableForUnit(unitId) {
  return _obsTable?.units?.[unitId] ?? null;
}

/** The table's schema block — { source, declared, why }. Rendered as-is when
 *  `declared` is 0, because it is the table honestly reporting itself broken. */
export function obsTableSchema() {
  return _obsTable?.schema ?? null;
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
  // MUST NOT fall through to GET /obs. That route is now the runtime-params
  // TABLE (getObsTable above), and it answers 200 — so a naive call here would
  // hand coulomb.js a table where it expects an ascending series of {at, n},
  // and the subtraction would run on whatever came out. The series has no
  // route; the bridge says so in the table's own payload.
  const why = _obsTable?.seriesWhy
    ?? 'no history store — the series needs `record`, which is unbuilt';
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
