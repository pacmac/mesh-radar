// ALARM PLUGIN — WebSocket wiring. NOT CORE.
//
// Peter, 2026-07-29: "makes no difference if they were added today or not they
// break the rules and need fixing."
//
// src/ws-relay.js is core: it serves the WS for every page. It named pac-host
// seven times — an import, three event handlers, three replay sends — so
// deleting the alarm meant editing core, and the "node-dash runs without the
// plugin" property did not actually hold. This file is where that wiring
// belongs. Delete it and its one import in index.js and core is unchanged.
//
// Everything here was MOVED VERBATIM out of ws-relay.js. The message shapes,
// the cadence and the on-connect ORDER are unchanged; only the place they are
// wired from has moved.
//
// See docs/WS_PLUGIN_HOOKS_SPEC.md and docs/PLUGIN_BOUNDARY_SPEC.md.

import * as pacHost from './pac-host.js';
import { registerWsWiring, registerConnectReplay } from './ws-relay.js';

// Live pushes. Core hands us `broadcast` and `hintNodeStatus`; we know pac-host,
// core does not know us.
registerWsWiring(({ broadcast, hintNodeStatus }) => {
  // pac-host status changes (module owns all polling/derivation — see
  // docs/modules/pac-host.md); rebroadcast its ready-made message on change.
  //
  // ALSO hint node_status for every unit it holds. The node page's Reachability
  // section is built from this roster (alarm-sections.js), and _hintNodeStatus
  // was otherwise driven ONLY by mesh-gw packet events — so those facts would
  // have refreshed exactly when a packet arrived, i.e. when the unit is
  // reachable, and frozen while it was silent. That is backwards: a sleeping
  // unit's countdown to its next window matters precisely BECAUSE nothing is
  // arriving from it. Measured over 68s with the hint removed: a sleeping GARG
  // received ZERO refreshes, against 2 with it. A hint carries only a num, so
  // this stays one code path producing displayed values.
  pacHost.events.on('change', () => {
    broadcast(pacHost.connectMessage());
    for (const num of pacHost.unitNums()) hintNodeStatus(num);
  });
  // Command queues — same shape, separate event so a queue tick (every 5s
  // while pac-host is up) doesn't force-resend the larger, rarer-changing
  // status payload.
  pacHost.events.on('queuesChanged', () => broadcast(pacHost.queuesMessage()));
  // Antenna-alignment view-model — separate event/message, own 2s poll
  // cadence (task yagi-align-rebuild, 2026-07-25).
  pacHost.events.on('alignChanged', () => broadcast(pacHost.alignMessage()));
});

// Replayed to every NEW connection, in this order, spliced by core between the
// bridge-state message and `settings`. BROWSER_CONTRACT: page data arrives over
// WS only — the Control page must never fetch this on click.
registerConnectReplay(() => [
  // absence is normal; connectMessage() reports 'unreachable' cleanly
  pacHost.connectMessage(),
  // command queues — so the Control page has data from the moment it connects,
  // never from a browser-triggered GET
  pacHost.queuesMessage(),
  // align view-model — same replay-on-connect rule
  pacHost.alignMessage(),
]);
