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
import { events, recentObservations } from './observatory.js';
import { registerWsWiring, registerConnectReplay } from './ws-relay.js';

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
    return [{
      type: 'observations_replay',
      observations: recentObservations('reception', REPLAY_LIMIT).map(toMessage),
    }];
  } catch (e) {
    console.error(`[observatory-ws] replay failed: ${e.message}`);
    return [];
  }
});
