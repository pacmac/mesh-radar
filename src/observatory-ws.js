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
import { getConfig, getCachedGeocode } from './db.js';

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

/** Current relay usage, heaviest first.
 *
 *  A pure read of stored facts — the inference already ran; this does not
 *  recompute on a page load. Provenance rides along (`at`, `evidence`) so the
 *  page can say when it was last worked out rather than implying it is live. */
function relayUsage() {
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
  const targets = facts('reach.target');
  const ladder  = facts('reach.ladder')[0]?.value ?? null;

  const usable = targets.filter(f => f.value?.verified && f.value?.km != null && !f.value?.suspect);
  const frontier = usable
    .sort((a, b) => b.value.km - a.value.km)
    .slice(0, 12)
    .map(f => ({
      target:  f.entity,
      label:   resolveNodeLabel(Number(f.entity)) || String(f.entity),
      km:      f.value.km,
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
  };
}

/** Observed links with both endpoints placed — the mesh map's geometry.
 *
 *  Capped and ordered by traffic so the heaviest corridors survive the cut: a
 *  map that silently drops its busiest link would be worse than one that admits
 *  it is showing the top N. */
function meshLinks() {
  const all = facts('link.observed').map(f => f.value).filter(Boolean);
  return {
    total: all.length,
    links: all.sort((a, b) => b.count - a.count).slice(0, 400).map(l => ({
      a: l.a, b: l.b, a_lat: l.a_lat, a_lon: l.a_lon, b_lat: l.b_lat, b_lon: l.b_lon,
      km: l.km, count: l.count,
    })),
  };
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
    for (const key of ['relay.usage', 'reach.target', 'reach.ladder', 'link.observed']) {
      const r = runInference(key);
      console.log(`[observatory] ${r.key}: ${r.facts} facts from ${r.rows} evidence rows`);
    }
    broadcast?.({ type: 'relay_usage', relays: relayUsage() });
    broadcast?.({ type: 'reach_model', reach: reachModel() });
    broadcast?.({ type: 'mesh_links', links: meshLinks() });
  } catch (e) {
    console.error(`[observatory] relay.usage failed: ${e.message}`);
  }
}

registerWsWiring(({ broadcast }) => {
  setTimeout(() => recompute(broadcast), 10_000);
  setInterval(() => recompute(broadcast), 15 * 60_000);
});
