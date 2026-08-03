// callout — the public "did you hear me?" broadcast, and every guard that
// keeps it from becoming a nuisance.
//
// Peter, 2026-08-03: "a PUBLIC ping when we detect a remote node (strike while
// the iron is hot)... problem with this is frequency of send, we dont want to
// make ourselves unpopular or always keep sending the same message. select them
// randomly and ttl them."
//
// WHY THIS EXISTS. A traceroute proves a route. A broadcast that a human answers
// proves reach into the public mesh — MESH_REACH_SPEC §7 calls it the strongest
// evidence available, and the most expensive, because it spends social capital
// rather than airtime.
//
// IT SHIPS DISABLED. `callout.enabled` defaults false, so merging this transmits
// nothing. §10: "An autonomous prober transmitting on PRIMARY is a product
// decision Peter has taken, and is not licence for a session to send by hand."
// Turning it on is his action, not mine, and that is also why nothing here had
// to be proven by sending a real broadcast.
//
// §8 IS NOT ADVISORY: "An unattended process transmitting on a public channel
// shared with strangers is the one failure here that a commit cannot undo.
// Reputation on a local mesh is not recoverable."

import db, { getConfig } from './db.js';
import { sendMeshText } from './mesh-send.js';
import { haversine, bearing as bearingOf } from './utils.js';
import { defineHook } from './hooks.js';

const H = {
  sent: defineHook({
    name: 'callout-sent', scope: 'actuator',
    purpose: 'records a public callout going out, to whom, how far, and which wording was used',
  }),
  held: defineHook({
    name: 'callout-withheld', scope: 'actuator',
    purpose: 'records a callout that a guard stopped, and names the guard — silence must be explainable',
  }),
  answered: defineHook({
    name: 'callout-answered', scope: 'actuator',
    purpose: 'a human replied to a callout — two-way contact at a known distance, the strongest reach evidence we can get',
  }),
};

// How long after a callout a text from that node counts as an answer. A person
// has to notice the message, read it and type — minutes to hours, not seconds.
// Beyond this it is a coincidence, not a reply, and calling it a reply would
// manufacture evidence.
const REPLY_WINDOW_H = 6;

// ── THE CEILING LIVES IN CODE ────────────────────────────────────────────────
// §8: "A hard ceiling on transmissions per day, enforced in the transmit path
// itself, which a config edit cannot raise to infinity and a bug cannot bypass."
// Config may only lower these. There is deliberately no way to raise them
// without a commit and a review.
const HARD_MAX_PER_DAY   = 12;
// THE DRY RUN CAUGHT THIS BEFORE ANYTHING WENT OUT. With the engine enabled, the
// furthest "recently heard" nodes were MLBR at 1681 km and HTF at 1003 km —
// MQTT-sourced entries whose self-reported positions are not RF evidence.
// Broadcasting "did you hear me at 1681km?" to the public channel would be
// humiliating and would prove nothing. Same 250 km plausibility ceiling that
// inferences.js applies; beyond it a position is not evidence.
const HARD_MAX_KM        = 250;
const HARD_MIN_COOLDOWN_DAYS = 3;    // per target, days not hours
const HARD_QUIET_FROM_H  = 22;       // local hours during which we never broadcast
const HARD_QUIET_TO_H    = 7;

// WIT, WITHIN LIMITS. Peter: "these programmed replies could also be a bit
// witty." On a channel full of strangers the tone that works is
// self-deprecating and invites an answer; the tone that does not is boastful,
// or a machine announcing itself. Every one of these states the distance and
// bearing (the measurement is the point), asks a real question (so a reply is
// natural), and would not embarrass us if a stranger screenshotted it.
//
// Kept short: a long broadcast is a bigger imposition on a shared band.
const DEFAULT_TEMPLATES = [
  { text: '@%short_name% — TA2 here, %km%km away on %az%°. Did any of that reach you?', ttl_days: 14 },
  { text: '@%short_name% waving from %km%km out, bearing %az%°. No reply needed, but it would make my day.', ttl_days: 21 },
  { text: '@%short_name% %km%km, %az%°. Testing how far this mesh really goes — shout back if you can hear me?', ttl_days: 21 },
  { text: '@%short_name% if you can read this from %km%km on %az%°, physics is being generous today.', ttl_days: 30 },
  { text: '@%short_name% long way for a few bytes — %km%km, bearing %az%°. Any chance that landed?', ttl_days: 30 },
];

const DEFAULTS = {
  enabled:        false,   // §10 — Peter's switch, not mine
  channel:        0,       // PRIMARY. Explicit, never inferred. See below.
  min_km:         50,      // a callout to a neighbour proves nothing about reach
  max_per_day:    6,
  cooldown_days:  7,
  quiet_hours:    true,
  // "Strike while the iron is hot" — how recently we must have heard them ON AIR.
  heard_within_h: 2,
  templates:      DEFAULT_TEMPLATES,
};

export function calloutConfig() {
  const c = { ...DEFAULTS, ...(getConfig('callout', {}) || {}) };
  // Clamp TOWARDS safety only. A config that asks for more than the hard
  // ceiling gets the hard ceiling; one that asks for less gets what it asked.
  c.max_per_day   = Math.max(0, Math.min(Number(c.max_per_day) || 0, HARD_MAX_PER_DAY));
  c.cooldown_days = Math.max(HARD_MIN_COOLDOWN_DAYS, Number(c.cooldown_days) || HARD_MIN_COOLDOWN_DAYS);
  if (!Array.isArray(c.templates) || !c.templates.length) c.templates = DEFAULT_TEMPLATES;
  return c;
}

/** Fill the tokens.
 *
 *  An UNKNOWN token renders EMPTY, never as the literal `%token%`. A broadcast
 *  that goes out containing raw template syntax is worse than one missing a
 *  word — it tells the whole channel the sender is not paying attention.
 */
export function renderTemplate(text, vars) {
  return String(text)
    .replace(/%(\w+)%/g, (_, k) => (vars[k] == null ? '' : String(vars[k])))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Which templates this node has not heard recently.
 *
 *  The TTL is per (node, template): the same node never hears the same sentence
 *  twice inside its window, which is what stops us sounding like a machine on a
 *  loop. A different node may hear it tomorrow — the TTL is about repetition to
 *  ONE listener, not about retiring the wording globally.
 */
export function eligibleTemplates(num, templates, now = Math.floor(Date.now() / 1000)) {
  const rows = db.prepare(
    `SELECT template_hash, MAX(ts) ts FROM callout_log WHERE num = ? GROUP BY template_hash`).all(num);
  const last = new Map(rows.map(r => [r.template_hash, Number(r.ts)]));
  return templates.filter((t) => {
    const seen = last.get(hashTemplate(t.text));
    if (!seen) return true;
    const ttl = Math.max(1, Number(t.ttl_days) || 14) * 86400;
    return (now - seen) > ttl;
  });
}

// Hash the WORDING, not the index. Editing the template list must not make the
// engine think a node has never heard a sentence it heard yesterday, and
// reordering the array must not silently reset every TTL.
export function hashTemplate(text) {
  let h = 5381;
  const s = String(text);
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

let _inFlight = false;

/** Decide whether this node gets a callout, and say WHY NOT when it does not.
 *
 *  Returns { ok, reason, text?, template? }. Every rejection names its guard —
 *  a prober that goes quiet without saying why is the failure this whole
 *  project keeps rediscovering.
 */
export function evaluate(node, { now = Math.floor(Date.now() / 1000), home } = {}) {
  const c = calloutConfig();
  if (!c.enabled)        return { ok: false, reason: 'disabled' };
  if (_inFlight)         return { ok: false, reason: 'a callout is already in flight' };
  if (!home)             return { ok: false, reason: 'we cannot place ourselves' };
  if (!node?.lat || node.lat === 0) return { ok: false, reason: 'target has no position' };

  if (c.quiet_hours) {
    const h = new Date(now * 1000).getHours();
    const quiet = HARD_QUIET_FROM_H > HARD_QUIET_TO_H
      ? (h >= HARD_QUIET_FROM_H || h < HARD_QUIET_TO_H)
      : (h >= HARD_QUIET_FROM_H && h < HARD_QUIET_TO_H);
    if (quiet) return { ok: false, reason: `quiet hours (${HARD_QUIET_FROM_H}:00-${HARD_QUIET_TO_H}:00)` };
  }

  const km = haversine(home.lat, home.lon, node.lat, node.lon);
  if (km < c.min_km) return { ok: false, reason: `${km.toFixed(1)}km is nearer than the ${c.min_km}km floor` };
  if (km > HARD_MAX_KM) {
    return { ok: false, reason: `${km.toFixed(0)}km exceeds the ${HARD_MAX_KM}km plausibility ceiling — position is not evidence` };
  }

  // HEARD BY RADIO, NOT VIA MQTT. "Strike while the iron is hot" means we just
  // heard them ON AIR; a node we only know through an MQTT bridge cannot hear a
  // LoRa broadcast from us, so calling out to it spends public airtime on
  // someone who is not listening. transport_mechanism is captured per packet
  // (relay_observation), so this is checkable rather than assumed.
  const heardOnAir = db.prepare(
    `SELECT COUNT(*) n FROM relay_observation
      WHERE from_num = ? AND transport = 'TRANSPORT_LORA' AND ts > ?`)
    .get(node.num, now - c.heard_within_h * 3600).n;
  if (!heardOnAir) {
    return { ok: false, reason: `not heard on LoRa in the last ${c.heard_within_h}h — iron is cold` };
  }

  const sentToday = db.prepare(
    `SELECT COUNT(*) n FROM callout_log WHERE ts > ?`).get(now - 86400).n;
  if (sentToday >= c.max_per_day) {
    return { ok: false, reason: `daily ceiling reached (${sentToday}/${c.max_per_day})` };
  }

  const lastToNode = db.prepare(
    `SELECT MAX(ts) ts FROM callout_log WHERE num = ?`).get(node.num)?.ts ?? null;
  if (lastToNode && (now - Number(lastToNode)) < c.cooldown_days * 86400) {
    const d = ((now - Number(lastToNode)) / 86400).toFixed(1);
    return { ok: false, reason: `called ${d}d ago, cooldown is ${c.cooldown_days}d` };
  }

  const pool = eligibleTemplates(node.num, c.templates, now);
  if (!pool.length) return { ok: false, reason: 'every wording is inside its TTL for this node' };

  // Random, not round-robin: a predictable rotation is still a pattern a
  // listener can notice.
  const template = pool[Math.floor(Math.random() * pool.length)];
  const text = renderTemplate(template.text, {
    short_name: node.short_name || node.long_name || '?',
    long_name:  node.long_name || node.short_name || '?',
    km:         Math.round(km),
    az:         Math.round(bearingOf(home.lat, home.lon, node.lat, node.lon)),
    hops:       node.hops_away ?? '',
  });
  return { ok: true, reason: 'clear', text, template, km: Math.round(km) };
}

/** Send it, or explain the silence. `dryRun` proves the whole path without
 *  transmitting, which is how this was verified — see the task notes. */
export async function callout(node, { home, gatewayNodeId, dryRun = false } = {}) {
  const c = calloutConfig();
  const verdict = evaluate(node, { home });
  if (!verdict.ok) {
    H.held.emit({
      summary: `no callout to ${node?.short_name || node?.num} — ${verdict.reason}`,
      detail: { num: node?.num, reason: verdict.reason },
    });
    return verdict;
  }
  if (dryRun) return { ...verdict, dryRun: true };

  _inFlight = true;
  try {
    // channel is passed EXPLICITLY. PRIMARY is the point of a public callout,
    // but no code path here may choose a channel by omission.
    const res = await sendMeshText({
      gatewayNodeId, text: verdict.text, channel: c.channel, category: 'callout',
    });
    db.prepare(`INSERT INTO callout_log (ts, num, template_hash, text, packet_id)
                VALUES (?, ?, ?, ?, ?)`)
      .run(Math.floor(Date.now() / 1000), node.num, hashTemplate(verdict.template.text),
           verdict.text, res?.id ?? null);
    H.sent.emit({
      severity: 'notice',
      summary: `called out to ${node.short_name || node.num} at ${verdict.km}km — "${verdict.text}"`,
      detail: { num: node.num, km: verdict.km, channel: c.channel, text: verdict.text },
    });
    return { ...verdict, sent: true };
  } finally {
    _inFlight = false;
  }
}


/** THE REPLY IS THE EVIDENCE.
 *
 *  Peter, 2026-08-03: "we send a PUBLIC broadcast targeting the node with
 *  '@xxxx' and we then see if we get anything back from that node in a text
 *  message that indicates we heard each other. that will also be used as data,
 *  and a guaranteed 2 way hit."
 *
 *  A callout on its own proves only that we transmitted. A TEXT BACK from that
 *  node proves the packet arrived, a human read it, and their answer travelled
 *  the whole way home — TWO-WAY contact at a known distance. MESH_REACH_SPEC §7
 *  ranks that above any traceroute, because a traceroute can be answered by
 *  firmware while nobody is there.
 *
 *  Call this from the inbound text path with any received message. It is a
 *  no-op unless that sender has an unanswered callout inside the window, so it
 *  is safe to call on every message.
 *
 *  Deliberately NOT parsing the reply for meaning. §10: "Not a chatbot." The
 *  fact of a reply is the datum; its wording is recorded, never interpreted.
 */
export function noteInboundText({ from_num, text, ts = Math.floor(Date.now() / 1000) }, { home } = {}) {
  if (!from_num || !text) return null;
  const row = db.prepare(
    `SELECT id, ts, num, text FROM callout_log
      WHERE num = ? AND replied_ts IS NULL AND ts > ?
      ORDER BY ts DESC LIMIT 1`).get(from_num, ts - REPLY_WINDOW_H * 3600);
  if (!row) return null;

  // Distance recorded AT REPLY TIME, from the node's position as we hold it now.
  // Null when we cannot place them — a two-way contact we cannot measure is
  // still a two-way contact, and writing 0 would claim a measurement.
  let km = null;
  const n = db.prepare('SELECT lat, lon, short_name, long_name FROM nodes WHERE num = ?').get(from_num);
  if (home && n?.lat && n.lat !== 0) km = Math.round(haversine(home.lat, home.lon, n.lat, n.lon) * 10) / 10;

  db.prepare('UPDATE callout_log SET replied_ts = ?, reply_text = ?, reply_km = ? WHERE id = ?')
    .run(ts, String(text).slice(0, 400), km, row.id);

  const mins = Math.max(0, Math.round((ts - Number(row.ts)) / 60));
  H.answered.emit({
    severity: 'notice',
    summary: `${n?.short_name || from_num} ANSWERED our callout after ${mins} min`
      + (km == null ? ' (position unknown, distance unmeasurable)' : ` — two-way at ${km} km`)
      + ` — "${String(text).slice(0, 80)}"`,
    detail: { num: from_num, km, minutes: mins, sent: row.text, reply: String(text).slice(0, 400) },
  });
  return { id: row.id, km, minutes: mins };
}

/** Callouts still waiting, and what they achieved. Used by the board. */
export function calloutStats(days = 30) {
  const from = Math.floor(Date.now() / 1000) - days * 86400;
  const r = db.prepare(
    `SELECT COUNT(*) sent, SUM(replied_ts IS NOT NULL) answered, MAX(reply_km) best_km
       FROM callout_log WHERE ts > ?`).get(from);
  return {
    sent: r.sent || 0,
    answered: r.answered || 0,
    best_two_way_km: r.best_km ?? null,
    pct: r.sent ? Math.round((100 * (r.answered || 0)) / r.sent) : null,
  };
}
