// ALARM PLUGIN — node_status sections. NOT CORE.
//
// Peter, 2026-07-29: "node-dash exists with or without the alarm. alarm is
// addative, it changes nothing about node communications, stats, messages …
// the alarm is a plugin … alarm related code is supposed to be self contained
// and not mixed in with core."
//
// This file exists because commit 1f8842b put all of the below INSIDE
// src/node-status.js, a core module that builds node_status for ANY node in the
// mesh. That gave core a hard `pac-host` import and 164 lines of alarm logic,
// which is exactly what reference/alarm-integration/INVENTORY.md forbids:
// "code must not be copied back into shared dashboard modules."
//
// The contract now runs one way only:
//   core  →  registerNodeSection(fn)     — knows nothing about what fn is for
//   here  →  reads pac-host, returns a section or null
// A null contributes nothing, so "the plugin is absent" and "the plugin has
// nothing to say about this node" are the same code path. Delete this file and
// its one import in index.js and node-dash is unchanged.
//
// Everything below was MOVED VERBATIM from node-status.js. The payload must be
// byte-identical, and the only way to be sure of that is to change nothing.
//
// See docs/PLUGIN_BOUNDARY_SPEC.md and docs/REACHABILITY_SPEC.md.

import { stmts } from './db.js';
import {
  fmtRssi, fmtSnr, fmtUptime, fmtAgo, fmtUntil, fmtCount,
} from './format.js';
import { field, compact, registerNodeSection } from './node-status.js';
import { unitForNum, obsForUnit, sections,
         obsTableForUnit, obsTableSchema } from './alarm-host.js';
import { resolveDeviceLabel } from './node-label.js';
import { coulombModel } from './coulomb.js';
import { log } from './log.js';

// ─── Reachability ────────────────────────────────────────────────────────────
//
// The ONE section not sourced from our own SQLite. pac-host owns every fact
// here; we render them and add nothing (docs/REACHABILITY_SPEC.md). Present
// only when pac-host holds a unit for this num — absent for every other node,
// per the existing rule that a section appears only if it has data.
//
// JOINED HERE, NOT IN THE BROWSER. pac-host's roster reaches the browser on a
// different WS message (pac_host_status); merging the two client-side to decide
// what a tile says would be the browser deciding, and would create a second code
// path for one displayed value — exactly what the node_status RPC exists to
// prevent.
//
// EVERY FIELD STATES ITS KIND AND ITS AGE, OR STATES THAT IT HAS NEITHER. The
// counter-example is on this same page: the Hops tile renders a value verified
// on 14 Jul at live-data weight. Several fields below carry NO age because
// pac-host does not record when they were established — under the mechanical
// <field>At convention an absent sibling is detectable, so they render undated
// rather than borrowing another field's instant or being stamped with now().

// pac-host instants are epoch MILLISECONDS; fmtAgo/fmtUntil/fmtStamp take epoch
// SECONDS. The divide happens once, here, at the boundary. Missing it is silent
// and produces a plausible wrong answer — it has cost this repo a day before.
const msToSec = ms =>
  (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) ? Math.floor(ms / 1000) : null;

const WAKE_SOURCE_TEXT = {
  'always-listening': 'never sleeps — a command goes now',
  'device':           'schedule reported by the device',
  'measured':         'schedule derived from observed wakes',
  'unknown':          'never measured, never reported',
};

// The four states are NOT equally strong, and the page must not flatten them.
// A config claim is not evidence that anything reached the unit — the argument
// that got services to split this field (their commit 35b274a).
const AWAKE_SOURCE_TEXT = {
  'heard':         'heard inside its window',
  'device-stated': 'device says sleep is off — not proof we reached it',
  'inferred':      'inferred from silence',
  'unknown':       'never heard',
};

// pac-host names radios by !hex or BLE MAC; every other surface in this app
// says OMNI / YAGI. resolveDeviceLabel is that SSOT — user alias first, then
// short_name, then an honest fallback — and it takes either form, so the same
// radio cannot be called two different things on two parts of one page.

// acks is a SINGLE object summarising the most recent request of ANY verb —
// which is what "can we reach it" asks. NULL means NEVER COMMANDED, and renders
// as unknown, never as failure: Peter must be able to tell "not yet asked" from
// "asked and got nothing" at a glance.
function deliveryField(acks, acksSource) {
  // "NEVER COMMANDED" AND "NO SOURCE FOR THE COUNTS" ARE DIFFERENT FACTS and
  // must not print the same string. Since pac-host was retired the bridge serves
  // no per-unit ack counts at all (`/stats` is estate-wide), so `acks` is null
  // for every unit — including ones that HAVE been commanded. Rendering "not yet
  // asked" for those is a false statement about the estate, not a blank.
  if (!acks && acksSource) {
    return field('Delivery', 'unavailable', 'unavailable', null, acksSource);
  }
  if (!acks) {
    return field('Delivery', 'never', 'not yet asked', null,
                 'no command has been sent to this unit');
  }
  const { verb, sends = 0, transmitted = 0, notSent = 0, unknownSent = 0,
          delivered = 0, settledAt } = acks;

  // FIVE numbers, never one boolean. `sends` counts POSTs mesh-gw ACCEPTED, not
  // transmissions: 15 of GARG's 131 sends in one day never left the radio and
  // every one was counted as a send (services, 2026-07-29). A single success
  // flag would have shown a green tick through the whole of 2026-07-28, while
  // every send was being refused.
  //
  // `delivered` IS A LEGACY VALUE AND NO LONGER REACHABLE FOR NEW ROWS.
  // "Radio reported delivery" is want_ack, and services' issue 118 removed every
  // `to:` from the command path when DMs were retired — so no command can
  // produce a delivery report at all. Measured across their whole ledger
  // 2026-08-09: all 24 `delivered` rows predate 118; none since. Their published
  // vocabulary is now answered / unanswered / not sent / still trying, and
  // node-dash acked that change.
  //
  // The branch is KEPT rather than deleted because the value still exists on
  // historical rows and this field renders history. Deleting it would make old
  // rows fall through to 'sent, no ack', silently restating a stronger claim
  // than the row supports. It is labelled instead.
  let text, legacy = false;
  if (delivered   > 0) { text = 'delivered'; legacy = true; }
  else if (transmitted > 0) text = 'sent, no ack';
  else if (notSent     > 0) text = 'refused';
  else if (unknownSent > 0) text = 'sent, status unknown';
  else                      text = 'queued';

  const bits = [];
  if (legacy) bits.push('legacy verdict — no longer producible');
  if (verb) bits.push(verb);
  // Only stated when it disagrees — "1/1 left the radio" is noise, and the gap
  // is the whole point.
  if (sends > 0 && transmitted < sends) bits.push(`${transmitted}/${sends} left the radio`);
  const ago = fmtAgo(msToSec(settledAt));
  if (ago) bits.push(ago);

  return field('Delivery', text, text, null, bits.join(' · ') || null);
}

// nextWake:null has TWO meanings and wakeSource is what tells them apart.
// "always-listening" means send NOW; "unknown" means we have no idea. Treating
// them the same is a real bug — it is why the field exists.
function nextWindowField(u) {
  if (u.wakeSource === 'always-listening') {
    return field('Next window', 'always', 'always listening', null,
                 WAKE_SOURCE_TEXT['always-listening']);
  }
  const until = fmtUntil(msToSec(u.nextWake));
  if (until) {
    return field('Next window', u.nextWake, until, null, WAKE_SOURCE_TEXT[u.wakeSource] ?? null);
  }
  return field('Next window', 'unknown', 'unknown', null,
               WAKE_SOURCE_TEXT[u.wakeSource] ?? 'no schedule measured or reported');
}

// null and 0 mean DIFFERENT things and must not print the same string.
//   null — a category statement: an always-listening unit does not wake, so
//          there is no denominator and no percentage exists to compute. The old
//          110% came from counting telemetry transmissions against expected
//          wakes, comparing two different things. Render nothing at all.
//   0    — a real denominator that happens to be zero: nothing expected yet.
// Dividing by either is a defect, so neither path computes a percentage.
function wakeReliabilityField(u) {
  const exp  = u.wakesExpected;
  if (exp == null) return null;
  const seen  = u.wakesSeen ?? 0;
  const since = fmtAgo(msToSec(u.wakesSince));
  if (exp === 0) {
    return field('Wake reliability', seen, `${seen} seen`, null,
                 since ? `none expected yet · since ${since}` : 'none expected in this window yet');
  }
  return field('Wake reliability', seen, `${seen} of ${exp}`, null,
               since ? `since ${since}` : null);
}

// perRadio is passed in rather than re-queried: the header's Signal tile is
// computed from the SAME array, which is what makes header and section agree by
// construction instead of by convention.
function buildReachabilitySection(num, perRadio) {
  const u = unitForNum(num);
  if (!u) return null;

  const fields = compact([
    deliveryField(u.acks, u.acksSource),
    nextWindowField(u),
    // No age: pac-host does not record when beat was established. Priority-one
    // on our ask to them, because nextWake is computed FROM beat — a stale beat
    // yields a confidently wrong countdown, which is worse than no answer.
    field('Beat', u.beat, fmtUptime(msToSec(u.beat)), null,
          u.beatSource ? `${u.beatSource}-reported` : null),
    field('Window', u.windowMs, fmtUptime(msToSec(u.windowMs)), null,
          // Published rather than omitted even when merely assumed: a blank is
          // indistinguishable from "we never asked", so an assumed value that
          // SAYS it is assumed is strictly more information than nothing.
          u.windowMsSource ?? u.windowSource ?? null),
    wakeReliabilityField(u),
    field('Awake', u.awake == null ? 'unknown' : u.awake,
          u.awake == null ? 'unknown' : (u.awake ? 'yes' : 'no'), null,
          // Falls back to the raw source string when it is not one of the known
          // keys. Since the bridge replaced pac-host it carries no awake field
          // at all, and the honest qualifier is "not served by the bridge" —
          // a bare "unknown" with no reason beneath it reads as a measurement
          // that failed rather than a fact nobody publishes.
          AWAKE_SOURCE_TEXT[u.awakeSource] ?? u.awakeSource ?? null),
    // Served by GET /tx since 2026-08-12. When nothing has been sent to this
    // unit the bridge gives a `why` rather than silence, and the row says that
    // instead of disappearing — "nothing sent yet" and "we cannot tell" are
    // different facts and an absent row conflates them.
    u.txRadio
      ? field('TX radio', u.txRadio.id,
              resolveDeviceLabel(u.txRadio.addr || u.txRadio.id) || u.txRadio.id,
              u.txAt ?? null,
              u.txRadio.state ? String(u.txRadio.state).toLowerCase() : null)
      : field('TX radio', 'none', 'nothing sent yet', null, u.txRadioSource ?? null),
    // OUR signal_history, not pac-host's radios{}. services conceded per-radio
    // rssi/snr to us (xsession [data-ownership-3categories]): "we retain a
    // per-radio model internally because it drives RADIO SELECTION — that is a
    // mesh decision, not a display one. It is not published for rendering and it
    // is not a competing answer to yours." Rendering theirs added a third source
    // to a page that already had two too many, and it covers only the alarm
    // units. These are the same rows the header's Signal tile is computed from.
    ...perRadio.map(r => {
      const text = compact([fmtRssi(r.rssi), fmtSnr(r.snr)]).join(' · ');
      return field(`Heard by ${resolveDeviceLabel(r.rx_device)}`, text || null, text || null,
                   r.ts, `direct ${fmtAgo(r.ts)}`);
    }),
  ]);

  if (!fields.length) return null;
  return { id: 'reachability', kind: 'value_grid', title: 'Reachability', fields };
}

// Self-registration. `ctx` carries CORE data already computed by
// buildNodeStatus — perRadio comes from stmts.latestDirectPerRadio and is the
// SAME array the header's Signal tile is built from. Re-querying it here would
// turn the header↔section agreement (cc2e55f) back into a coincidence.
registerNodeSection((num, ctx) => buildReachabilitySection(num, ctx.perRadio));

// ─── Charge counter ──────────────────────────────────────────────────────────
//
// Peter, 2026-08-08, having found the Stats pane and then opened the node page:
// "this page also shows node stats. it shows stats that are available for every
// node as well as our enhanced data." This is the enhanced half, for the units
// that have a gauge.
//
// THE DERIVATION IS NOT REPEATED HERE. It calls coulombModel() — the same pure
// function the Stats pane's WS RPC ends up in. Two copies of a subtraction, a
// grst refusal and a set of state rules would drift apart silently and the two
// pages would then disagree about the same unit, which is worse than the
// feature missing.
//
// It reads pac-host's POLLED cache rather than fetching, because
// buildNodeStatus is synchronous and a provider cannot await.
function buildCoulombSection(num) {
  const unit = unitForNum(num);
  if (!unit) return null;                    // not a pac-host unit — silent, as reachability is

  // A STATED GAP IS NOT AN UNKNOWN, so it is rendered rather than hidden.
  //
  // The rule below — absent rather than empty — was written when the ambiguity
  // was real: "no gauge" and "fitted but nothing recorded yet" were
  // indistinguishable, so any row would have been a claim we could not support.
  //
  // That is no longer the situation. Since pac-host was retired (2026-08-12) the
  // bridge NAMES why the series is missing and WHO OWNS the hole — "no series
  // store; the record plugin is unbuilt — plugins". That is a fact, not a
  // shrug, and hiding it reproduces the exact failure of that morning: the
  // coulomb feature vanished from the page and looked identical to a unit that
  // simply has no gauge. Peter asked for this counter BECAUSE it was invisible.
  const obsGap = sections()?.obs;
  if (obsGap && obsGap.ok !== true) {
    return {
      // EVERY section needs an `id`. The browser keys its section list on it,
      // so two sections without one collide and only ONE renders — silently,
      // and whichever loses is simply absent. Charge shipped without an id and
      // looked fine while it was the only such section; adding Runtime params
      // made it disappear instead of making both appear.
      id: 'charge',
      title: 'Charge',
      kind: 'value_grid',
      fields: compact([
        // raw is 'unavailable', NOT null: field() drops a null raw by design
        // ("an absent value is absent, not a placeholder"), which would render
        // the heading with an empty body — worse than either showing the reason
        // or omitting the section. Same shape as the 'refused' row below.
        field('Charge count', 'unavailable', 'unavailable', null,
              `${obsGap.why ?? 'no route on the bridge'} — ${obsGap.owner ?? 'unknown'}`),
      ]),
    };
  }

  const rows = obsForUnit(unit.id);
  // ABSENT, NOT EMPTY — and this branch still stands for the case it was
  // written for: the series store EXISTS and this unit has nothing in it.
  // "No gauge" and "fitted but nothing recorded yet" remain different facts
  // that nothing upstream distinguishes yet (services offered the flag;
  // xsession #89/#90). Rendering a "we don't know" row on every node page would
  // be noise, and rendering "not fitted" would be a claim I cannot support.
  // The Control > Stats pane is where that distinction is spelled out.
  if (!rows.length) return null;

  let m;
  try { m = coulombModel(unit.id, rows); }
  catch (e) {                                 // ascending-order assertion tripped
    log.warn('alarm-sections', `coulomb model failed for ${unit.id}: ${e.message}`);
    return null;
  }
  if (m.state !== 'has_samples') return null;

  // field(label, raw, text, ts, desc) — `raw` is the machine value, `text` what
  // is printed, `ts` makes the age live, `desc` is the qualifier beneath.
  const fields = compact([
    field('Charge count', m.latest.n, String(m.latest.n), m.latest.at, m.latest.ago),
    m.current?.refused
      // The refusal is SHOWN, not swallowed. Omitting the row would read as "no
      // rate available"; the truth is "the counter reset inside this span, so
      // any rate across it would be invented".
      ? field('Derived current', 'refused', m.current.refused_reason, null, null)
      : field('Derived current', m.current?.value_text, m.current?.value_text,
              null, m.current?.span_text),
  ]);
  if (!fields.length) return null;
  return { id: 'charge', kind: 'value_grid', title: 'Charge counter', fields };
}

// THE RUNTIME PARAMS — what this device is actually saying, as key and value.
//
// Peter, 2026-08-12: *"this is a simple key/value list / table and allows me to
// see all of the runtime params on a device"* and *"make the table fit the
// data"*. So it is a value_grid like Reachability, not a full-width table: the
// rows are short pairs and the grid sizes to them. No card per field, and no
// curated field list — the set changes when firmware changes, so anything
// hand-picked here guarantees the NEWEST field is the one not shown.
//
// Every row keeps its declared state. An absent optional is listed, because an
// absent optional is information; an absent `must` is a DEFECT and says so; and
// a key the schema never declared is the finding worth surfacing most, because
// it means firmware is sending something nobody wrote down.
function buildObsSection(num) {
  const unit = unitForNum(num);
  if (!unit) return null;

  const table = obsTableForUnit(unit.id);
  const schema = obsTableSchema();

  const rows = Array.isArray(table?.fields) ? table.fields : [];
  const heard = table?.heard ?? null;

  // "NOT SENT" IS A CLAIM ABOUT THE DEVICE, AND WE CANNOT MAKE IT WHEN NOTHING
  // DECODED. GARG is heard every 60 s — 46 frames, port 260 among them — and
  // ZERO carried a decodable payload. Every field then reads
  // `declared-never-arrived`, and rendering that as "not sent" told Peter the
  // unit is silent about 30 parameters when the truth is that we cannot read
  // what it says. plugins state it exactly: "the fields below are the schema,
  // not observations".
  //
  // So when nothing decoded, the section reports the FAULT and the evidence for
  // it, and does not list thirty rows asserting anything about the firmware.
  // NOTHING HEARD IS NOT A DECODE FAULT — IT IS SILENCE, AND SILENCE IS DERIVED
  // FROM THE FRAME COUNT, NEVER ASSERTED.
  //
  // This branch previously ran on `decoded === 0` alone and printed "the unit is
  // transmitting" as a fixed string. A unit that had gone off the air therefore
  // rendered as a decode fault while the page insisted it was transmitting —
  // a hard-coded liveness claim, and exactly backwards on the one case that
  // matters. If there is no data, it is offline; the page must not decide
  // otherwise from a literal.
  //
  // frames > 0 && decoded === 0  -> heard but unreadable: a real decode fault
  // frames === 0                 -> not heard: say so, claim nothing else
  if (heard && heard.decoded === 0 && (heard.frames ?? 0) > 0) {
    // `ports` became an array of OBJECTS when plugins added per-port decode
    // errors (2026-08-12). It was an array of strings that morning. Handle both
    // rather than assume — the shape changed once today already and a `.join`
    // on objects renders "[object Object]" without erroring.
    const portList = Array.isArray(heard.ports) ? heard.ports : [];
    const portObjs = portList.filter(p => p && typeof p === 'object');
    const portNames = portList.map(p => (typeof p === 'object' ? p.port : p));
    const ourPorts = portObjs.filter(p => p.ours && p.lastError);
    return {
      id: 'obs_runtime',
      title: 'Runtime params',
      kind: 'value_grid',
      fields: compact([
        // THE BRIDGE'S OWN SENTENCE, VERBATIM AND FIRST. "the unit was built
        // against 0xbaf7, this butler loaded 0xd339" is something Peter can act
        // on; "25 fields undeclared" was not. Never paraphrased — the hashes are
        // the actionable part and a summary would drop them.
        ...ourPorts.map(p => field(
          'Decode error', 'error', 'schema mismatch',
          heard.lastFrameAt ? Date.parse(heard.lastFrameAt) : null,
          p.lastError)),
        field('Readable frames', 0, 'none', null,
              heard.why ?? 'no frame carried a decodable payload'),
        field('Frames heard', heard.frames ?? 0, String(heard.frames ?? 0),
              heard.lastFrameAt ? Date.parse(heard.lastFrameAt) : null,
              // Derived from the count above it, never asserted.
              `heard on air — unreadable, not silent`),
        // AN ERROR MEANS UNREADABLE; NO ERROR MEANS ABSENT. Different faults,
        // different people to chase, and they looked identical until plugins
        // split them 2026-08-12.
        field('Ports', portNames.join(','), portNames.join(' · ') || 'none', null,
              ourPorts.length
                ? `${ourPorts.length} of ours carrying frames — unreadable, not absent`
                : 'none of ours among them — the payload is absent, not unreadable'),
        field('Fields declared', rows.length, String(rows.length), null,
              'schema only — no value below has been observed'),
      ]),
    };
  }

  // NOT HEARD AT ALL. No frames means no observations, and every declared field
  // would otherwise render `not sent` — 30 statements about a firmware we have
  // heard nothing from. The unit's liveness is the frame count and nothing else;
  // this section does not compute an "offline" verdict of its own, it reports
  // that it has no frames and stops.
  if (heard && (heard.frames ?? 0) === 0) {
    return {
      id: 'obs_runtime',
      title: 'Runtime params',
      kind: 'value_grid',
      fields: compact([
        field('Frames heard', 0, 'none',
              heard.lastFrameAt ? Date.parse(heard.lastFrameAt) : null,
              heard.lastFrameAt
                ? 'nothing since the last frame below'
                : 'nothing has been heard from this unit'),
        field('Fields declared', rows.length, String(rows.length), null,
              'schema only — nothing has been observed to fill them'),
      ]),
    };
  }

  // A BROKEN SCHEMA DOES NOT MEAN NO ROWS, and suppressing the rows because the
  // schema is empty gets it exactly backwards. With `declared: 0` EVERY arrived
  // key classifies as undeclared — and an undeclared key is the finding plugins
  // built this table to surface: firmware is sending something nobody wrote
  // down. BNCH had 17 such keys while this section said "unavailable".
  //
  // So the schema's state is a ROW, not a gate. Only a table with nothing in it
  // at all falls back to the bare statement.
  const schemaRow = (schema && schema.declared === 0)
    ? field('schema', 'broken', `0 of 18 declared`, null,
            `${schema.why ?? 'no reason given'} — plugins. Every key below reads as undeclared until this loads.`)
    : null;

  if (!rows.length) {
    const why = schema?.why ?? 'the runtime table has not been read yet';
    return {
      id: 'obs_runtime',
      title: 'Runtime params',
      kind: 'value_grid',
      fields: compact([
        field('Fields', 'none', 'nothing received', null, `${why} — plugins`),
      ]),
    };
  }

  const fields = compact([schemaRow, ...rows.map(r => {
    // An undeclared key is served with value:null and withheld:true — the KEY is
    // the finding, the VALUE of an unvetted field is the risk (a POSITION
    // payload arrives on the same event class and carries lat/lon). Render the
    // key, never the value.
    if (r.withheld) {
      // When the schema is broken EVERY key is undeclared, so the per-row
      // explanation repeats 18 times and says nothing the schema row above has
      // not already said once. Once the schema loads, an undeclared key is rare
      // and genuinely worth spelling out on its own line.
      return field(r.key, 'undeclared', 'undeclared', null,
                   schemaRow ? null : 'firmware sends this; the schema does not declare it');
    }
    if (r.value == null) {
      return field(r.key, r.req === 'must' ? 'missing' : 'not sent',
                   r.req === 'must' ? 'missing' : 'not sent', null,
                   r.req === 'must'
                     ? `declared must — ${r.label ?? 'no label'}`
                     : (r.label ?? null));
    }
    return field(r.key, r.value, String(r.value), r.at ? Date.parse(r.at) : null,
                 r.label ?? null);
  })]);

  return fields.length
    ? { id: 'obs_runtime', title: 'Runtime params', kind: 'value_grid', fields }
    : null;
}

registerNodeSection(num => buildCoulombSection(num));
registerNodeSection(num => buildObsSection(num));
