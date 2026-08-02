// OBSERVATORY — WebSocket wiring. NOT CORE.
//
// Same shape and the same reason as alarm-ws.js: src/ws-relay.js serves the WS
// for every page and must not name a plugin. This file knows the observatory;
// core does not know this file. Delete it and its one import in index.js and
// core is unchanged.
//
// It is the THIRD file permitted to import observatory.js, and that is a
// deliberate decision rather than a boundary quietly slipping. The rule the
// test encodes is "CORE must not reach into the engine". This is a plugin — the
// engine's own WS wiring — exactly as alarm-ws.js is the alarm's. The allowlist
// names it explicitly so a fourth entry is again a visible choice.
//
// See docs/WS_PLUGIN_HOOKS_SPEC.md and docs/PLUGIN_BOUNDARY_SPEC.md.
import { events, recentObservations, facts, runInference } from './observatory.js';
import { registerWsWiring, registerConnectReplay } from './ws-relay.js';
import { resolveNodeLabel } from './node-label.js';
import { mqttDiscarded } from './observations.js';
import { missionRunner } from './mission-runner.js';
import { getConfig, getCachedGeocode, recentAimedTraceroutes, lastHeardMap, positionMap, listObsTargets,
         attemptsByDay, answerRateBySilence, answerRateByDistance } from './db.js';

// Read once: the map marks where we are, and the reach model already computes
// every distance from it. A page load must not re-read config.
const HOME = { lat: getConfig('home.lat'), lon: getConfig('home.lon') };

// How much history a freshly-connected page starts with. On a quiet channel a
// page that waits for the next packet looks broken for minutes, so it opens with
// the recent past already on screen and grows from there.
const REPLAY_LIMIT = 200;

/** One stored row as a WS message.
 *
 *  `data` is re-parsed rather than passed through as a string: the browser must
 *  not be handed JSON-inside-JSON to unpick. Parse failures yield null instead
 *  of throwing — a single malformed payload must not stop the feed.
 *
 *  BROWSER_CONTRACT: this is raw observation data, not display values. Anything
 *  the page needs FORMATTED (relative ages, labels) is a server-computed field
 *  and must be added here, never derived in the browser. */
function toMessage(row) {
  let data = null;
  try { data = row.data ? JSON.parse(row.data) : null; } catch { data = null; }
  return { id: row.id, ts: row.ts, kind: row.kind, entity: row.entity, source: row.source, data };
}

// Live pushes. Core hands us `broadcast`; we know the observatory, core does not
// know us.
registerWsWiring(({ broadcast }) => {
  events.on('observation', (row) => {
    // WRAPPED. This runs inside observe(), which runs inside handlePacket, which
    // is the hot path for every packet. A throw here — a dead socket, a JSON
    // problem — must not reach packet ingestion.
    try { broadcast({ type: 'observation', observation: toMessage(row) }); }
    catch (e) { console.error(`[observatory-ws] broadcast failed: ${e.message}`); }
  });
});

// Replayed to every new connection, newest first. An empty array is the same
// code path as "plugin not installed", so a page with no observations yet and a
// node-dash without the observatory behave identically.
registerConnectReplay(() => {
  try {
    return [
      {
        type: 'observations_replay',
        observations: recentObservations('reception', REPLAY_LIMIT).map(toMessage),
      },
      { type: 'relay_usage', relays: relayUsage() },
      { type: 'reach_model', reach: reachModel() },
      { type: 'mesh_links', links: meshLinks() },
      { type: 'missions', missions: missions() },
      { type: 'mission_activity', activity: missionRunner.state() },
      { type: 'charts', charts: charts() },
    ];
  } catch (e) {
    console.error(`[observatory-ws] replay failed: ${e.message}`);
    return [];
  }
});

/** The readable tail of a reverse-geocoded address: town, county.
 *
 *  The stored form is "Ash Lane, Winsford, TA24 7AD, Somerset, United Kingdom".
 *  A door list wants "Winsford, Somerset" — the street and the postcode are
 *  precision nobody is using, and the country is the same for all of them.
 *  Returns null rather than a placeholder when nothing is cached yet, so the
 *  column stays empty instead of filling with noise while the backfill runs. */
function shortPlace(address) {
  if (!address) return null;
  const parts = address.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return parts[0] || null;
  const noCountry = parts.length > 2 ? parts.slice(0, -1) : parts;
  const postcodeish = s => /\d/.test(s) && s.length <= 9;
  const keep = noCountry.filter(s => !postcodeish(s));
  return keep.slice(-2).join(', ') || null;
}

/** The TOWN out of a reverse-geocoded address — what a map caption wants.
 *
 *  NOT shortPlace()'s first token, which is the street. Nominatim returns
 *  "Alexandra Road, St. Ives, TR26 2ET, Cornwall, United Kingdom" and
 *  "Rue des Prés, St. Pierre du Bois, GY7 9RZ, Guernsey" — the same shape with
 *  a different number of parts, so a fixed index picks the street in one and
 *  the county in the other.
 *
 *  Counted from the END instead: the last surviving part is always the region
 *  (Cornwall, Guernsey, Ceredigion) and the one before it is the town. Verified
 *  against every geocoded outlier in the cache — St. Ives, Torteval, Wychavon,
 *  St Peter Port, Nanpean — and it degrades to the single remaining part for
 *  the village-only addresses ("Horeb, SA44 4ND, Ceredigion") that have no
 *  street at all. */
function placeName(address) {
  if (!address) return null;
  const parts = address.split(',').map(s => s.trim()).filter(Boolean);
  // "United Kingdom" is the same for every node here and carries nothing.
  // Guernsey and Jersey are NOT dropped — there the country IS the location.
  const noCountry = parts.filter(s => s !== 'United Kingdom');
  const keep = noCountry.filter(s => !(/\d/.test(s) && s.length <= 9));
  if (!keep.length) return null;
  return keep.length >= 2 ? keep[keep.length - 2] : keep[0];
}

/** Current relay usage, heaviest first.
 *
 *  A pure read of stored facts — the inference already ran; this does not
 *  recompute on a page load. Provenance rides along (`at`, `evidence`) so the
 *  page can say when it was last worked out rather than implying it is live. */
function relayUsage() {
  const heard = lastHeardMap(), pos = positionMap();
  const now = Math.floor(Date.now() / 1000);
  return facts('relay.usage')
    .map(f => ({
      relay:    f.entity,
      // NAME RESOLVED HERE, not in the browser. The page tried
      // this.nodes.find(...) and got 4 nodes — that list is FILTERED, so every
      // relay rendered as a raw number. It is also a BROWSER_CONTRACT breach:
      // a label is a display value and belongs to the server.
      label:    resolveNodeLabel(Number(f.entity)) || String(f.entity),
      place:    shortPlace(getCachedGeocode(Number(f.entity))),
      uses:     f.value?.uses ?? 0,
      targets:  f.value?.targets ?? 0,
      furthest_km: f.value?.furthest_km ?? null,
      bearing:  bearingFromHome(pos.get(Number(f.entity))?.lat, pos.get(Number(f.entity))?.lon),
      since:    sinceStr(heard.has(Number(f.entity)) ? now - heard.get(Number(f.entity)) : null),
      since_sec: heard.has(Number(f.entity)) ? now - heard.get(Number(f.entity)) : null,
      at:       f.ts,
      evidence: f.evidence_count,
    }))
    .sort((a, b) => b.uses - a.uses);
}

/** The reach model, ready to render.
 *
 *  Server-computed per BROWSER_CONTRACT: the record, the ladder and the ranked
 *  frontier are all decided here, and the page places strings.
 *
 *  THE HEADLINE IS "AT LEAST". §4: silence is censored data, so a frontier is a
 *  lower bound on what we can reach, never a statement about what we cannot.
 *  Suspect distances (>200 km, §12) are excluded from the record and the
 *  frontier — a flag nobody reads is not a guard — but their count is reported
 *  so the exclusion is visible rather than silent. */
function reachModel() {
  const targeted = new Set(listObsTargets().map(x => x.num));
  const heard = lastHeardMap();
  const nowS = Math.floor(Date.now() / 1000);
  const targets = facts('reach.target');
  // HOW OLD IS ALL THIS? Peter, 2026-08-02: "if a traceroute was last done 4
  // days ago, then our entire page is dead and old data." Every panel here is
  // derived from traceroute_history, so the board must state the age of its
  // newest evidence rather than presenting five-day-old figures as current.
  const newest = targets.reduce(
    (mx, f) => Math.max(mx, f.value?.last_attempt || 0), 0) || null;
  const ladder  = facts('reach.ladder')[0]?.value ?? null;

  const usable = targets.filter(f => f.value?.verified && f.value?.km != null && !f.value?.suspect);
  const frontier = usable
    .sort((a, b) => b.value.km - a.value.km)
    .slice(0, 12)
    .map(f => ({
      target:  f.entity,
      label:   resolveNodeLabel(Number(f.entity)) || String(f.entity),
      km:      f.value.km,
      bearing: f.value.bearing ?? null,
      since:   sinceStr(heard.has(Number(f.entity)) ? nowS - heard.get(Number(f.entity)) : null),
      since_sec: heard.has(Number(f.entity)) ? nowS - heard.get(Number(f.entity)) : null,
      obs_target: targeted.has(Number(f.entity)),
      hits:    f.value.hits,
      attempts: f.value.attempts,
      last_ok: f.value.last_ok,
      // A place beats a callsign for judging a corridor: "St Ives, Cornwall"
      // says why the shot is hard in a way "Ives" never can. Trimmed to the
      // town-and-county tail — the street number is noise at this zoom.
      place:   shortPlace(getCachedGeocode(Number(f.entity))),
    }));

  // EVERY plottable target, not just the frontier's top 12: a radar showing a
  // dozen dots is a list with extra steps. Suspect distances stay out (§12).
  const plot = usable.map(f => ({
    target:  f.entity,
    label:   resolveNodeLabel(Number(f.entity)) || String(f.entity),
    km:      f.value.km,
    bearing: f.value.bearing,
    hits:    f.value.hits,
    attempts: f.value.attempts,
  })).filter(p => p.bearing != null);

  return {
    plot,
    home_lat: HOME.lat,
    home_lon: HOME.lon,
    record_km:    ladder?.record_km ?? null,
    record_at:    ladder?.record_at ?? null,
    rungs:        (ladder?.rungs ?? []).map(r => ({
      ...r,
      label: resolveNodeLabel(Number(r.target)) || String(r.target),
    })),
    frontier,
    verified:     targets.filter(f => f.value?.verified).length,
    targets:      targets.length,
    unverified:   targets.filter(f => !f.value?.verified).length,
    without_km:   targets.filter(f => f.value?.verified && f.value?.km == null).length,
    suspect:      targets.filter(f => f.value?.suspect).length,
    last_attempt: newest,
  };
}

/** The mission shortlist — what to try next, and why.
 *
 *  Ranking and reasons are the inference's (`reach.mission`); this resolves
 *  names and places and hands over a list. The summary row is separated out
 *  rather than being filtered away silently: the counts it carries are what
 *  stop a shortlist reading as "these are the only options". */
function missions() {
  // So the crosshair on each row can show its own state without the browser
  // holding any (BROWSER_CONTRACT).
  const targeted = new Set(listObsTargets().map(x => x.num));
  const heard = lastHeardMap();
  const nowM = Math.floor(Date.now() / 1000);
  const all = facts('reach.mission');
  const summary = all.find(f => f.entity === 'global')?.value ?? null;
  const list = all
    .filter(f => f.entity !== 'global' && f.value)
    .sort((a, b) => b.value.rank - a.value.rank)
    .map(f => ({
      target: f.entity,
      label:  resolveNodeLabel(Number(f.entity)) || String(f.entity),
      place:  shortPlace(getCachedGeocode(Number(f.entity))),
      km:     f.value.km,
      bearing: f.value.bearing ?? null,
      since:   sinceStr(heard.has(Number(f.entity)) ? nowM - heard.get(Number(f.entity)) : null),
      since_sec: heard.has(Number(f.entity)) ? nowM - heard.get(Number(f.entity)) : null,
      obs_target: targeted.has(Number(f.entity)),
      step_km: f.value.step_km ?? null,
      cls:    f.value.cls,
      reason: f.value.reason,
      attempts: f.value.attempts,
      hits:     f.value.hits,
      age_days: f.value.age_days,
    }));
  return { missions: list, summary };
}

/** The chart series. Display aggregation, assembled here rather than inferred —
 *  see docs/OBSERVATORY_CHARTS.md. `ladder` is reused from the existing fact and
 *  never recomputed.
 *
 *  Wrapped: a chart failing must degrade to an empty panel, not take the feed
 *  down with it. */
function charts() {
  const out = { ladder: [], record_km: null, daily: [], silence: [], distance: [] };
  try {
    const l = facts('reach.ladder')[0]?.value ?? null;
    out.ladder = (l?.rungs ?? []).map(r => ({
      ts: r.ts, km: r.km,
      label: resolveNodeLabel(Number(r.target)) || String(r.target),
    }));
    out.record_km = l?.record_km ?? null;
  } catch (e) { console.error(`[observatory-ws] ladder series failed: ${e.message}`); }
  try { out.daily = attemptsByDay(30); }
  catch (e) { console.error(`[observatory-ws] daily series failed: ${e.message}`); }
  try {
    // Ordered here, not in SQL: the buckets are a scale (best to worst) and the
    // page must not have to know their order to draw them correctly.
    const order = ['direct RF', '< 24h', '< 7d', 'silent 7d+'];
    const by = new Map(answerRateBySilence().map(r => [r.bucket, r]));
    out.silence = order.filter(k => by.has(k)).map(k => by.get(k));
  } catch (e) { console.error(`[observatory-ws] silence series failed: ${e.message}`); }
  try { out.distance = answerRateByDistance(); }
  catch (e) { console.error(`[observatory-ws] distance series failed: ${e.message}`); }
  return out;
}

/** Observed links with both endpoints placed — the mesh map's geometry.
 *
 *  Capped and ordered by traffic so the heaviest corridors survive the cut: a
 *  map that silently drops its busiest link would be worse than one that admits
 *  it is showing the top N. */
function meshLinks() {
  const all = facts('link.observed').map(f => f.value).filter(Boolean);
  const links = all.sort((a, b) => b.count - a.count).slice(0, 400).map(l => ({
    a: l.a, b: l.b, a_lat: l.a_lat, a_lon: l.a_lon, b_lat: l.b_lat, b_lon: l.b_lon,
    km: l.km, count: l.count,
  }));

  // LABEL THE OUTLIERS ONLY. Naming all 200-odd nodes would be a wall of text
  // over a map; naming the far ones tells you which corridor you are looking at.
  // Chosen by distance from us — the near cluster is where we live and needs no
  // caption, and the point of the map is the reach.
  const seen = new Map();
  for (const l of links) {
    for (const [n, lat, lon] of [[l.a, l.a_lat, l.a_lon], [l.b, l.b_lat, l.b_lon]]) {
      if (seen.has(n)) continue;
      seen.set(n, { node: n, lat, lon, km: haversine(HOME.lat, HOME.lon, lat, lon) });
    }
  }

  // ONE LABEL PER CLUSTER, NOT PER NODE — and this is the whole point of the
  // marks. The first attempt named nodes and printed six Guernsey street
  // addresses stacked on one another ("Rue du Closel 176km", "Terramar Court
  // 177km", "Les Vieux Beaucamps 179km" …), which is six ways of saying
  // "Guernsey" and one unreadable smudge. At 180 km the map cannot separate
  // them anyway.
  //
  // Greedy from the furthest outward: the first node in a neighbourhood names
  // it, and the rest only raise its count. CLUSTER_KM is a map-legibility
  // figure, not a mesh one — 15 km is roughly where two dots stop being
  // distinguishable at this zoom.
  const CLUSTER_KM = 15;
  const clusters = [];
  for (const n of [...seen.values()].filter(n => n.km > 90).sort((a, b) => b.km - a.km)) {
    const c = clusters.find(c => haversine(c.lat, c.lon, n.lat, n.lon) < CLUSTER_KM);
    if (c) { c.count++; continue; }
    clusters.push({ ...n, count: 1 });
  }

  const marks = clusters.slice(0, 12).map(n => ({
    node: n.node, lat: n.lat, lon: n.lon, km: Math.round(n.km), nodes: n.count,
    // Place beats callsign on a map — "St. Ives" locates you, "Ives" does not.
    // Falls back to the label, then the raw num; never a placeholder.
    label: placeName(getCachedGeocode(n.node))
           || resolveNodeLabel(n.node) || String(n.node),
  }));

  // EVERY PLOTTED NODE, CLASSIFIED HERE. The page was drawing 92 identical grey
  // dots, so the map showed where the mesh is and nothing about what it does for
  // us. Peter, 2026-08-02: "we need some node plot point colour differences so we
  // can more easily read the map and what it's telling us."
  //
  // Classification is a decision, so it is the server's (BROWSER_CONTRACT). The
  // browser gets a class name and a weight and paints them.
  //
  //   relay    — carried our traffic. A door. 57 of 92.
  //   endpoint — we have a verified route to it, but nothing has ever relayed
  //              through it. A leaf. 35 of 92.
  //   seen     — on the map through someone else's route only. Currently zero,
  //              and that is expected rather than a bug: link.observed is built
  //              FROM our traceroute routes, so every endpoint is by definition
  //              in a route we obtained. The class exists because the moment a
  //              second evidence source lands (passive relay_node, §7b) it will
  //              start filling, and a map that silently reclassified them as
  //              endpoints would be lying.
  //
  // `weight` is the door's share of relayed traffic, 0..1, linear on log(uses)
  // — the busiest relay is not fifty times more important than the quietest, it
  // is one or two rungs up, and a linear scale would draw one huge dot and
  // ninety-one specks.
  const usage = new Map(facts('relay.usage').map(f => [f.entity, f.value?.uses ?? 0]));
  const reached = new Set(
    facts('reach.target').filter(f => f.value?.verified).map(f => f.entity));
  const maxUses = Math.max(1, ...usage.values());

  const nodes = [...seen.values()].map(n => {
    const key = String(n.node);
    const uses = usage.get(key) ?? 0;
    return {
      node: n.node, lat: n.lat, lon: n.lon, km: Math.round(n.km),
      cls: uses > 0 ? 'relay' : (reached.has(key) ? 'endpoint' : 'seen'),
      uses,
      weight: uses > 0 ? Math.log1p(uses) / Math.log1p(maxUses) : 0,
      label: resolveNodeLabel(n.node) || String(n.node),
      place: placeName(getCachedGeocode(n.node)),
    };
  });

  const legend = [
    { cls: 'relay',    text: 'relayed for us', count: nodes.filter(n => n.cls === 'relay').length },
    { cls: 'endpoint', text: 'route verified', count: nodes.filter(n => n.cls === 'endpoint').length },
    { cls: 'seen',     text: 'seen only',      count: nodes.filter(n => n.cls === 'seen').length },
  ];

  return { total: all.length, links, marks, nodes, legend };
}

/** BEARING and SINCE — the two columns every table was missing.
 *
 *  Peter, 2026-08-02: "something missing from every table is 1: bearing,
 *  2: since." Both are display values, so both are computed here rather than in
 *  the browser (BROWSER_CONTRACT), and `since` ships as the STRING the column
 *  shows plus the raw seconds the page needs to tint it.
 *
 *  Short by design — "6h", "3d" — because the column has to fit the data, not
 *  the other way round. */
function sinceStr(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const h = sec / 3600;
  if (h < 1)  return `${Math.max(1, Math.round(sec / 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/** Bearing FROM us, degrees. Duplicated from the catalogue for the same reason
 *  haversine is: this layer must not import domain calculations. */
function bearingFromHome(lat, lon) {
  if (lat == null || lon == null || HOME.lat == null || HOME.lon == null) return null;
  const r = Math.PI / 180;
  const y = Math.sin((lon - HOME.lon) * r) * Math.cos(lat * r);
  const x = Math.cos(HOME.lat * r) * Math.sin(lat * r)
          - Math.sin(HOME.lat * r) * Math.cos(lat * r) * Math.cos((lon - HOME.lon) * r);
  return Math.round((Math.atan2(y, x) / r + 360) % 360);
}

/** Great-circle km. Duplicated from the catalogue on purpose: this file must not
 *  import domain calculations, and an inference must not be imported for its
 *  arithmetic — that coupling is how the engine's boundary starts to leak. */
function haversine(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// RECOMPUTED ON BOOT, then on a slow timer. `relay.usage` is a batch inference
// over all history — cheap at this size (12,268 evidence rows, ~40 ms) but not
// something to run per packet, and the answer moves slowly: a new relay appears
// only when a traceroute completes through it.
//
// Deferred past startup so a slow query cannot delay the port opening, and
// wrapped so a failure degrades the doors panel rather than the process.
function recompute(broadcast) {
  try {
    for (const key of ['relay.usage', 'reach.target', 'reach.ladder', 'link.observed', 'reach.mission']) {
      const r = runInference(key);
      console.log(`[observatory] ${r.key}: ${r.facts} facts from ${r.rows} evidence rows`);
    }
    // ONLY WHEN NON-ZERO. MQTT arrivals never enter the store (§3a) — they are
    // dropped at the mapper — but a silent discard is indistinguishable from a
    // quiet channel. Today this number is zero and the line never prints; the
    // day a gateway starts bridging, it does.
    const dropped = mqttDiscarded();
    if (dropped) console.log(`[observatory] ${dropped} MQTT arrivals discarded since boot — not radio hops`);

    broadcast?.({ type: 'relay_usage', relays: relayUsage() });
    broadcast?.({ type: 'reach_model', reach: reachModel() });
    broadcast?.({ type: 'mesh_links', links: meshLinks() });
    const list = missions();
    broadcast?.({ type: 'missions', missions: list });
    broadcast?.({ type: 'charts', charts: charts() });

    // FEED THE ACTUATOR. The runner never fetches — it is handed the shortlist
    // and works it. This file is already an allowed importer of the engine; the
    // runner deliberately is not, so the coupling lives here.
    missionRunner.setQueue(list.missions);
    // Seed what was already known BEFORE any mission ran, so the first route
    // does not report the whole existing mesh as newly discovered.
    // Replay recent attempts so the panel is populated on a cold start. Only
    // the yagi-dispatched ones: those are the discovery runner's, and a
    // passive-tracer trace of whatever just arrived is not a mission.
    try {
      const rows = recentAimedTraceroutes(25);
      missionRunner.seedRecent(rows.map(r => ({
        target: String(r.to_num),
        label:  resolveNodeLabel(r.to_num) || String(r.to_num),
        place:  shortPlace(getCachedGeocode(r.to_num)),
        km: null, step_km: null, az: r.rotator_az,
        seeded: true,
        ok: r.status === 'ok',
        hops: null, hops_back: null, found: [],
        error: r.status === 'ok' ? null : 'no reply',
        finished: r.ts,
      })));
    } catch (e) {
      console.error(`[observatory-ws] recent replay failed: ${e.message}`);
    }

    missionRunner.seed({
      relays: facts('relay.usage').map(f => f.entity),
      links:  facts('link.observed').map(f => f.entity),
    });
  } catch (e) {
    console.error(`[observatory] relay.usage failed: ${e.message}`);
  }
}

registerWsWiring(({ broadcast }) => {
  setTimeout(() => recompute(broadcast), 10_000);
  // Settable (discovery.recompute_min): selection latency is a timing that
  // changes what the operator sees, so it needs a bounded knob like the rest.
  // Read once at wiring — a live re-read would need the interval torn down and
  // rebuilt, which is not worth it for a value nobody changes mid-session.
  const recomputeMin = Number((getConfig('discovery', {}) || {}).recompute_min) || 15;
  setInterval(() => recompute(broadcast), recomputeMin * 60_000);

  // Live activity: every state change, pushed. This is the panel Peter asked
  // for — "what it's done, doing right now, and whether a discovery is in
  // progress" — so it must not wait on the 15-minute recompute.
  missionRunner.on('activity', (activity) => {
    try { broadcast({ type: 'mission_activity', activity }); }
    catch (e) { console.error(`[observatory-ws] activity broadcast failed: ${e.message}`); }
  });

  // Started after the first recompute has had a chance to fill the queue.
  setTimeout(() => missionRunner.start(), 20_000);
});
