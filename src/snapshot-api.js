// ── Snapshot board — Domain 1 ────────────────────────────────────────────────
//
// One screen answering: how far can we get · what is new · are we productive ·
// is the machine working. Everything here is DERIVED IN NODE; the browser
// renders and computes nothing (BROWSER_CONTRACT).
//
// INCREMENT 1 of 6: the hero band only. Peter, 2026-08-05: "you need to start
// filling with live data and validate that the static and live data correlate.
// suggest you do not do this in 1 shot."
//
// EVERY FIGURE CARRIES ITS WINDOW. The static mockup shipped an ALL-TIME 189.1 km
// under a 7D badge — the true 7-day figure was 176.2 km, and the page mixed
// all-time, 30-day and today in one view. A number without its window stated is
// how that happens, so `window_days` is returned alongside the values and the
// browser prints what it is given.
//
// PLAUSIBILITY GATE. Distances are capped at reach.js's max_plausible_km (500).
// One bad GPS fix — MLBR at 1681 km — is how a single row silently governs a
// whole display; clusters.js and the radar already gate on it and so does this.

import { Router } from 'express';
import db, { getConfig } from './db.js';
import { getAllDeviceCfgs } from './device-config.js';
import { doorUsage, BROADCAST } from './reach.js';

const router = Router();

const R_EARTH = 6371.0088;
const rad = d => d * Math.PI / 180;

function home() {
  const lat = Number(getConfig('home.lat')), lon = Number(getConfig('home.lon'));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function km(h, lat, lon) {
  const p1 = rad(h.lat), p2 = rad(lat), dl = rad(lon - h.lon);
  const t = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(t));
}

/** Window in days. 0 means all-time, matching config-api's WINDOW_DAYS vocabulary. */
export function windowDays() {
  const n = Number(getConfig('observatory.window_days', 30));
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

function sinceTs(days) {
  return days > 0 ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
}

/** How far did we get — derived from WHAT WE HEARD, which is the whole record.
 *
 *  RECEIVE IS THE ONLY SOURCE OF TRUTH. Peter, 2026-08-05: *"active means
 *  transmit, passive means receive. if transmit was successful then receive will
 *  reflect it. no ambiguity at all."*
 *
 *  A successful transmit IS a reception — the reply arrives and the node lands in
 *  `nodes`. So transmitting cannot produce a node we have not heard, and reach
 *  derived from traceroute is a strict SUBSET of reach derived from reception.
 *  Measured: 115 traceroute-confirmed nodes, 113 of them also heard, **0** never
 *  heard, and 851 heard that traceroute never confirmed. That 0 is not a finding
 *  about the discovery engine; it is a tautology.
 *
 *  The previous version of this function derived everything from
 *  `traceroute_history` and therefore served 189.1 km while `nodes` already held
 *  285.8 km at zero hops. It reported LESS than the truth we already had, which
 *  is the one thing the model forbids: *"passive data is the ONLY real truth. it
 *  can be increased by active but can never be less than."*
 *
 *  HOPS ARE NOT A FILTER. The goal is distance — *"how far can we get"* — so a
 *  node heard at seven hops still counts as reach. Hops survive only as a QUALITY
 *  RANKING: 100 km direct beats 100 km through seven relays, expressed as
 *  `km_per_hop`. Served, so the browser ranks nothing itself.
 */
export function frontier(days = windowDays()) {
  const h = home();
  const maxKm = Number(getConfig('reach', {})?.max_plausible_km ?? 500);
  const empty = { window_days: days, furthest_km: null, furthest_node: null,
                  heard: 0, confirmed: 0, best_quality: null, scale_max_km: maxKm };
  if (!h) return { ...empty, ready: false, reason: 'no home position' };

  // THE FLOOR: everything we have heard. `hops` may be null — unknown hop count
  // is not zero hops, and it must not flatter the quality ranking.
  const rows = db.prepare(`
    SELECT n.num, n.short_name, n.lat, n.lon, n.hops, n.last_heard, n.rf_last_heard
      FROM nodes n
     WHERE n.lat IS NOT NULL AND n.lat != 0
       AND n.last_heard IS NOT NULL AND n.last_heard > ?`).all(sinceTs(days));

  // Traceroute CONFIRMS; it never establishes. Used only to mark which of the
  // heard nodes we have also completed a round trip with.
  const confirmed = new Set(
    db.prepare(`SELECT DISTINCT to_num FROM traceroute_history
                 WHERE status = 'ok' AND ts > ?`).all(sinceTs(days)).map(r => r.to_num));

  // WHAT CARRIED IT. This endpoint used to tell the browser that RF and MQTT
  // could not be told apart, citing `packet-provenance-capture` as unlanded. It
  // HAD landed — `relay_observation.transport` holds 132,674 rows. That was the
  // fourth absence asserted in this codebase without reading the schema, after
  // nodeinfo.first_heard, clusters.created_at and alert_rules.last_sent, and no
  // test caught any of them because nothing is wrong with code that renders a
  // false caveat.
  //
  // Same window as everything else above: a provenance flag from a different
  // period would be exactly the mixed-window defect this file exists to prevent.
  const loraNodes = new Set(
    db.prepare(`SELECT DISTINCT from_num FROM relay_observation
                 WHERE transport = 'TRANSPORT_LORA' AND ts > ?`).all(sinceTs(days))
      .map(r => r.from_num));

  // THE EVIDENCE EPOCH, and it matters more than the flag. relay_observation
  // begins 2026-08-03 07:39 — it does not reach back over the history `nodes`
  // holds. So `lora: false` means "NO PROVENANCE RECORDED", never "arrived by
  // MQTT". All-time: 590 heard, 261 with a LoRa row, 329 without — and every one
  // of those 329 has ZERO relay_observation rows of ANY transport, not internal
  // ones. Reading absence as MQTT would replace the false caveat this change
  // removes with a fresh one pointing the other way.
  //
  // Same class as `direct-gate-epoch` (signal_history before 27 Jul): a column
  // that started recording partway through needs its start date served beside
  // it, or every consumer silently treats "not yet recorded" as "measured false".
  const provenanceSince =
    db.prepare('SELECT MIN(ts) t FROM relay_observation').get()?.t ?? null;

  let far = null, farNode = null, best = null, bestNode = null;
  let farLora = null, farLoraNode = null;
  let heard = 0, confirmedHeard = 0, beyondScale = 0, heardLora = 0;
  // THE RULER'S TICKS, one per heard node. Previously a typed array of
  // positions, which meant the density — the entire point of the instrument —
  // was invented. Served as distances; the browser only maps them to a scale.
  const ticks = [];

  for (const r of rows) {
    const d = km(h, r.lat, r.lon);
    if (!(d <= maxKm)) { beyondScale++; continue; }
    heard++;
    if (confirmed.has(r.num)) confirmedHeard++;
    if (far == null || d > far) { far = d; farNode = r.short_name; }
    const lora = loraNodes.has(r.num);
    if (lora) {
      heardLora++;
      if (farLora == null || d > farLora) { farLora = d; farLoraNode = r.short_name; }
    }
    ticks.push({ km: Math.round(d * 10) / 10, hops: r.hops ?? null,
                 direct: r.hops === 0, confirmed: confirmed.has(r.num), lora });
    // Quality: distance per leg. hops=0 means one leg (us -> them), so +1.
    if (r.hops != null && r.hops >= 0) {
      const q = d / (r.hops + 1);
      if (best == null || q > best) { best = q; bestNode = r.short_name; }
    }
  }

  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  return {
    ready: true,
    window_days: days,
    furthest_km: r1(far), furthest_node: farNode,
    heard, confirmed: confirmedHeard,
    best_quality_km_per_hop: r1(best), best_quality_node: bestNode,
    // PROVENANCE, not a second reach figure. `furthest_lora_km` <= `furthest_km`
    // by construction: it is the same set filtered, never a longer distance.
    // NOT YET RENDERED — serving it is Domain 1, putting it on the board is
    // Domain 2 (`snapshot-lora-provenance-card`). Serving an unrendered figure
    // is how charts.heard_km hid; this one is deliberate and tracked.
    heard_lora: heardLora,
    furthest_lora_km: r1(farLora), furthest_lora_node: farLoraNode,
    // Served so no consumer can read `lora: false` as MQTT. `lora_covers_window`
    // is false whenever the requested window starts before provenance recording
    // did — which today is true of every window longer than 3 days, and of the
    // all-time window permanently.
    provenance_since: provenanceSince,
    lora_covers_window: provenanceSince != null && (days !== 0) && sinceTs(days) >= provenanceSince,
    // NOT a plausibility gate, and not a claim that the excluded rows are junk.
    // It bounds the DISPLAY SCALE. The furthest excluded rows cluster coherently
    // in real places — six nodes in Galicia at ~1020-1067 km, Lisbon, Tenerife,
    // and MLBR in Poland, which this file previously libelled as a bad GPS fix.
    // Random corrupt coordinates do not cluster geographically.
    scale_max_km: maxKm, beyond_scale: beyondScale,
    // Sorted so the browser never re-orders served data.
    ticks: ticks.sort((a, b) => a.km - b.km),
    // The old ending — "nothing here separates an RF path from an MQTT-carried
    // one … so distance alone does not prove radio reach" — was FALSE, and the
    // replacement is deliberately narrower rather than its opposite. LoRa on the
    // last hop is what the column actually proves.
    caveat: 'Derived from receptions — every node here reached us, so it is alive and '
          + 'reachable. `confirmed` counts those a traceroute also round-tripped; that '
          + 'adds confidence, never distance. Hops rank quality (km_per_hop), they do '
          + 'not gate reach. Nodes beyond scale_max_km are excluded from the SCALE, not '
          + 'judged invalid. `lora` means relay_observation recorded TRANSPORT_LORA for '
          + 'that node in this window, which proves the FINAL hop into our gateway was '
          + 'radio — not that the whole path was, since a packet can be MQTT-bridged '
          + 'into the mesh elsewhere and re-transmitted locally. `lora` false means NO '
          + 'PROVENANCE RECORDED, never MQTT: recording began at provenance_since, and '
          + 'when lora_covers_window is false the window reaches back before it.',
  };
}

/** Distance bands + the doors carrying us, both from the SAME window.
 *  Bands come from receptions (the record); doors are the first hop of completed
 *  traceroutes, which is the only place door identity exists. */
export function distribution(days = windowDays()) {
  const h = home();
  const maxKm = Number(getConfig('reach', {})?.max_plausible_km ?? 500);
  if (!h) return { ready: false, reason: 'no home position', window_days: days };
  const since = sinceTs(days);

  const EDGES = [10, 25, 50, 100, Infinity];
  const LABEL = ['0-10 km', '10-25', '25-50', '50-100', '100+'];
  const bands = LABEL.map(label => ({ label, count: 0 }));

  for (const n of db.prepare(`
      SELECT lat, lon FROM nodes
       WHERE lat IS NOT NULL AND lat != 0 AND last_heard IS NOT NULL AND last_heard > ?`).all(since)) {
    const d = km(h, n.lat, n.lon);
    if (!(d <= maxKm)) continue;
    bands[EDGES.findIndex(e => d < e)].count++;
  }

  // Every door, not a truncated list — an earlier version of the CARD dropped
  // rows to fix a layout problem, which is deleting data to fix a CSS bug.
  //
  // The query used to live here, inline, and was the third copy of it. It omitted
  // the broadcast exclusion the other two had, so this feed published 0xFFFFFFFF
  // as the fourth-busiest relay in the mesh. Door identity belongs to reach.js.
  const doors = doorUsage({ since });

  const maxBand = Math.max(1, ...bands.map(b => b.count));
  const maxUses = Math.max(1, ...doors.map(d => d.uses));
  return {
    ready: true, window_days: days,
    bands: bands.map(b => ({ ...b, pct: Math.round(100 * b.count / maxBand) })),
    doors: doors.map(d => ({ ...d, pct: Math.round(100 * d.uses / maxUses) })),
    doors_total: doors.length,
  };
}

/** New ground: what this window discovered that we did not have before it.
 *
 *  first_heard lives on **nodeinfo**, not `nodes`. The board previously rendered
 *  "no first_heard column" because I checked one table and declared an absence —
 *  there are 1104 rows of it. */
export function newGround(days = windowDays()) {
  const h = home();
  const maxKm = Number(getConfig('reach', {})?.max_plausible_km ?? 500);
  const since = sinceTs(days);
  const one = (sql, ...a) => db.prepare(sql).get(...a)?.n ?? 0;

  const firstHeard = days > 0
    ? one('SELECT COUNT(*) n FROM nodeinfo WHERE first_heard > ?', since)
    : one('SELECT COUNT(*) n FROM nodeinfo WHERE first_heard IS NOT NULL');

  // A door is "new" when its FIRST EVER appearance falls inside the window.
  //
  // `num != BROADCAST` for the same reason doorUsage() excludes it: 0xFFFFFFFF is
  // not a node. This counted it, and was wrong on the all-time window only —
  // the broadcast first appeared in route[0] on 2026-06-25, before every bounded
  // window — which is exactly the kind of defect that survives, because five of
  // the six windows agree with a check that makes the same mistake.
  const newDoors = one(`
    WITH d AS (SELECT json_extract(route,'$[0]') num, MIN(ts) first_seen
                 FROM traceroute_history
                WHERE status='ok' AND json_array_length(route)>0 GROUP BY 1)
    SELECT COUNT(*) n FROM d WHERE num IS NOT NULL AND num != ? AND first_seen > ?`,
    BROADCAST, since);

  // Same rule for contacts: first ever completed traceroute to that node.
  const firstContacts = one(`
    WITH c AS (SELECT to_num, MIN(ts) first_ok FROM traceroute_history
                WHERE status='ok' GROUP BY 1)
    SELECT COUNT(*) n FROM c WHERE first_ok > ?`, since);

  // Furthest node whose FIRST reception is inside the window — new ground, not
  // simply the furthest thing heard again.
  let furthestNew = null, furthestNewNode = null;
  if (h) {
    for (const r of db.prepare(`
        SELECT i.first_heard, n.short_name, n.lat, n.lon
          FROM nodeinfo i JOIN nodes n ON n.num = i.num
         WHERE i.first_heard > ? AND n.lat IS NOT NULL AND n.lat != 0`).all(since)) {
      const d = km(h, r.lat, r.lon);
      if (d <= maxKm && (furthestNew == null || d > furthestNew)) {
        furthestNew = d; furthestNewNode = r.short_name;
      }
    }
  }

  return {
    ready: true, window_days: days,
    first_heard: firstHeard,
    new_doors: newDoors,
    first_contacts: firstContacts,
    furthest_new_km: furthestNew == null ? null : Math.round(furthestNew * 10) / 10,
    furthest_new_node: furthestNewNode,
    // `clusters.created_at` EXISTS. This previously served null with the reason
    // "cluster anchors carry no creation timestamp" — I asserted an absence
    // without reading the schema, the same error as claiming `nodes` had no
    // first_heard when nodeinfo has 1104 rows of it. Twice in one session.
    new_clusters: one('SELECT COUNT(*) n FROM clusters WHERE created_at > ?', since),
    clusters_total: one('SELECT COUNT(*) n FROM clusters'),
    // WHEN they appeared, so a figure that is identical across every window
    // explains itself. All 52 came from one auto-seed run, so every window that
    // reaches back past it legitimately reports 52 — which looks exactly like a
    // hard-coded value unless the date is shown. Peter: "why is 52 new clusters
    // shown for every date range. that is impossible?" It is not, but a number
    // nobody can distinguish from a fake is a defect regardless.
    clusters_seeded_at: db.prepare('SELECT MAX(created_at) t FROM clusters').get()?.t ?? null,
    clusters_sources: db.prepare('SELECT source, COUNT(*) n FROM clusters GROUP BY 1')
                        .all().map(r => `${r.n} ${r.source}`).join(', '),
  };
}

/** Are we productive: attempts, answers, and the daily series behind them. */
export function productivity(days = windowDays()) {
  const since = sinceTs(days);
  const tot = db.prepare(`
    SELECT COUNT(*) attempts, SUM(status='ok') ok, COUNT(DISTINCT to_num) targets
      FROM traceroute_history WHERE ts > ?`).get(since);
  const daily = db.prepare(`
    SELECT date(ts,'unixepoch') day, COUNT(*) attempts, SUM(status='ok') ok
      FROM traceroute_history WHERE ts > ? GROUP BY 1 ORDER BY 1`)
    .all(days > 0 ? since : Math.floor(Date.now() / 1000) - 30 * 86400);
  const rate = tot.attempts ? Math.round(1000 * tot.ok / tot.attempts) / 10 : null;
  return {
    ready: true, window_days: days,
    attempts: tot.attempts, answered: tot.ok ?? 0, targets: tot.targets, rate_pct: rate,
    daily: daily.map(d => ({ ...d, rate_pct: d.attempts ? Math.round(1000 * d.ok / d.attempts) / 10 : null })),
  };
}

/** Is the machine working — ONLY what we can actually observe.
 *
 *  The card previously showed six invented rows: "sent 11:38", "v4 · 20° · free",
 *  "within budget", "204 of 387". Every one was typed. A health panel that
 *  fabricates health is worse than no panel, because its whole job is to be
 *  believed — and the alerts path was dead for an unknown period today while
 *  nothing on any screen said so.
 *
 *  Anything not measurable is returned with `value: null` and a `reason`. The
 *  card renders the reason rather than inventing a reassuring string. */
export function health() {
  const rows = [];
  const add = (label, value, reason = null, tone = null) => rows.push({ label, value, reason, tone });

  // Radios: from stored device config — label, and whether a fixed position is set.
  try {
    const cfgs = getAllDeviceCfgs?.() ?? {};
    const names = Object.values(cfgs).map(c => c?.label).filter(Boolean);
    add('Radios', names.length ? names.join(' + ') : null,
        names.length ? null : 'no devices configured');
  } catch { add('Radios', null, 'device config unavailable'); }

  // Rotator: node-dash no longer selects or connects to a rotator directly —
  // mesh-gw's aim plugin commands it (2026-09-03, task
  // rotator-command-via-meshgw-aim). 'rotator_active' (the old v4/v5 target
  // switch) has no successor; there is nothing to display here any more.
  //
  // Live azimuth: aim-client.js's status() would answer this, but it is
  // async and board()/health() are a synchronous composition chain called
  // from a WS push handler — making the whole chain async to add one
  // incidental health-panel line is out of scope for this pass. Honestly
  // unmeasurable from here rather than fabricated or silently dropped.
  add('Rotator', null, 'no longer selected here — commanded via mesh-gw aim');
  add('Live azimuth', null, 'requires an async fetch — not available from this synchronous panel');

  // Callout transmitter: a real, checkable safety state.
  const co = getConfig('callout', {}) || {};
  add('Public callouts', co.enabled ? 'ENABLED' : 'off', null, co.enabled ? 'warning' : null);

  // Alerts: we can prove configuration, not delivery. Saying "sent 11:38" without
  // a stored send log is exactly the invention this endpoint exists to stop.
  const smtp = getConfig('alerts.smtp_host', '');
  add('Alert email', smtp ? `configured · port ${getConfig('alerts.smtp_port', '?')}` : null,
      smtp ? null : 'no SMTP host set');
  // alert_rules.last_sent EXISTS. "no send log is stored" was wrong — the third
  // absence I asserted in one session without reading the schema.
  const last = db.prepare('SELECT MAX(last_sent) t FROM alert_rules').get()?.t;
  const lastType = last ? db.prepare('SELECT type FROM alert_rules WHERE last_sent = ?').get(last)?.type : null;
  add('Last alert sent', last
        ? `${new Date(last * 1000).toISOString().slice(11,16)} · ${lastType}`
        : null,
      last ? null : 'no alert has ever been sent');

  const total = db.prepare('SELECT COUNT(*) n FROM nodes').get()?.n ?? 0;
  add('Nodes known', String(total));

  return { ready: true, rows,
           caveat: 'Rows with a reason are NOT measurable today. They are reported as '
                 + 'unknown rather than filled with a plausible value.' };
}

// THE FIVE GET ROUTES ARE GONE — /snapshot/health, /distribution, /new-ground,
// /productivity, /frontier. Every one served LIVE DATA over HTTP, which is
// forbidden (Peter, 2026-08-13: "no HTTP GETS for live data, ws feeds for
// everything except static data / forms").
//
// The board now arrives as one `snapshot` message on the socket — see board()
// below and the RPC in ws-relay.js. They are DELETED rather than deprecated: a
// route left standing is a route something reaches for, and the page contract
// test was already reading one of them, testing a path the page no longer used.

/** THE WHOLE BOARD FOR ONE WINDOW, in a single object.
 *
 *  Peter, 2026-08-13: "no HTTP GETS for live data, ws feeds for everything
 *  except static data / forms."
 *
 *  The board was five browser GETs — frontier, distribution, new-ground,
 *  productivity, health — fired on page load and again on every window change.
 *  That is live data over GET, and it is forbidden.
 *
 *  ONE call rather than five, because they are one screen: five separate
 *  replies can arrive interleaved with a window change and paint a board whose
 *  bands disagree about which window they are describing. `days` is echoed back
 *  so the browser can drop a reply for a window it is no longer showing —
 *  which is not a decision, it is addressing.
 *
 *  `health` is not window-scoped and is included anyway: it belongs to the same
 *  screen, and a second round trip to fetch it would reintroduce the split this
 *  removes. */
export function board(days = windowDays()) {
  const d = Number.isFinite(Number(days)) && Number(days) >= 0 ? Number(days) : windowDays();
  return {
    days: d,
    frontier:     frontier(d),
    distribution: distribution(d),
    new_ground:   newGround(d),
    productivity: productivity(d),
    health:       health(),
  };
}

export default router;
