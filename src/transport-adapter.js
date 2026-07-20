// Adapts the mt-transport facade onto node-dash's capability names.
//
// WHY THIS FILE EXISTS, separately from transport-plugin.js:
// the loader must stay protocol-free (see transport-plugin.md — a portnum
// literal in that file is a bug). But the module's public surface is
// `{ Client, chunk, cmd, target, parse260, ... }`, not functions named after our
// capabilities. Something has to bridge the two vocabularies, and that job
// belongs to the consumer — us. It lives here, alone, clearly named.
//
// Confirmed with the mt-transport session 2026-07-19 (docs/QA-mt-transport.md Q3):
// `Client` is the layer they will keep stable; the low-level names are exported
// for substitution and "expect churn". So map onto Client wherever possible and
// treat everything else as a fallback.
//
// Deliberately NOT adapted:
//   configSet — node-dash owns this. The text-command path in node-settings.js
//               is the implementation, not a workaround (Q&A Q6). The module
//               will not supersede it.
//   tilt256   — portnum 256 is decoded in ws-relay.js and the module does not
//               expose it. Nothing to adapt.
//   pullQueue — not designed on either side; the device half does not exist
//               (Q&A Q1). Name reserved, deliberately unimplemented.

// No pacing heuristics here, ever. Under PUSH the device streams at its own rate and
// mt-transport's client runs the receiver loop (store[seq], PROGRESS_Q, REPAIR,
// COMPLETE) for the whole transfer. node-dash adds nothing — it triggers and relays.
// (MSG_BUSY 0x06 flow control belonged to the pull era and no longer exists.)
//
// Cost for anyone exposing it in the UI: ~41 bytes/second effective, so budget
// roughly 3 minutes for a 7 KB image. Do not let a user queue several — the
// channel is shared with the alarm's own traffic.

// Never PRIMARY. Peter's rule, stated with no exceptions. The module guards this
// too (Q&A Q7 — its Client throws on unset and on 0), but a caller-side check
// costs nothing and this is the failure we cannot take back once transmitted.
function assertChannel(channel) {
  if (channel === undefined || channel === null) {
    throw new Error('channel must be given explicitly — it defaults to 0 (PRIMARY)');
  }
  if (channel === 0) {
    throw new Error('channel 0 is PRIMARY — forbidden');
  }
}

// One Client per (host, gatewayId, channel). A Client owns a MeshEvents
// WebSocket, so constructing one per fetch would open a socket per transfer and
// leak them — and each reconnect re-sends the gateway's multi-MB opening
// snapshot, which is the exact waste mt-transport flagged in Q&A QA.
//
// Keyed rather than a bare singleton because the transmitting radio can change
// at runtime (mode roles own which device is TX), and a fetch through the wrong
// gateway is a silent wrong answer, not an error.
const _clients = new Map();

function getClient(m, { host, gatewayId, channel, payloadDir }) {
  const key = `${host}|${gatewayId}|${channel}`;
  let entry = _clients.get(key);
  if (!entry) {
    const client = new m.Client({ host, gatewayId, channel, ...(payloadDir ? { payloadDir } : {}) });
    // connect() starts the event subscription. Kept as a promise so concurrent
    // first-fetches await the same connect instead of racing two of them.
    entry = { client, ready: client.connect() };
    _clients.set(key, entry);
  }
  return entry.ready.then(() => entry.client);
}

/** Close every cached Client. For shutdown and for tests. */
export function closeClients() {
  for (const { client } of _clients.values()) {
    try { client.close(); } catch { /* already gone */ }
  }
  _clients.clear();
}

/**
 * Map a loaded mt-transport module onto capability functions.
 *
 * @param {object} m  the module namespace (its exports)
 * @returns {object}  capability-name → function; only for capabilities the
 *                    module can actually serve. Absent keys mean absent
 *                    capabilities — the loader turns that into can()===false.
 */
export function adaptMtTransport(m) {
  const caps = {};

  // --- debug260: parse a portnum-260 JSON payload -------------------------
  // Pure function, no radio, no Client needed. parse260 is documented stable.
  if (typeof m.parse260 === 'function') {
    caps.debug260 = (payload) => {
      const parsed = m.parse260(payload);
      return { ok: true, state: 'applied', value: parsed };
    };
  }

  // --- chunkPush: receive a chunked payload (JPEG etc) PUSHED by a device ----
  //
  // The ONLY bulk-transfer path. Pull (`Client.fetch`) was removed entirely: its
  // follow-up requests were the thing that failed — a transfer stalled at 16/32
  // because the device never received the pull for `first=16`, which is why
  // mt-transport replaced the protocol.
  //
  // mt-transport's `Client` is an OUT-OF-PROCESS consumer of node-dash, not a
  // library: it POSTs to `http://<host>/<gatewayId>/messages` and subscribes to
  // `ws://<host>/events` — both node-dash's own routes. So we point it at
  // ourselves; that loopback is deliberate (see docs/modules/transport-adapter.md).
  //
  // The client owns the receiver loop for the whole ~3 minutes. We forward and
  // relay; we never pace, never batch, never decode a 261 frame.
  if (typeof m.Client === 'function') {
    caps.chunkPush = async ({ target, pid, channel, host, gatewayId, deadlineMs, onProgress, payloadDir, signal }) => {
      assertChannel(channel);
      if (!host || !gatewayId) {
        throw new Error('chunkPush needs host and gatewayId — node-dash supplies both');
      }
      const client = await getClient(m, { host, gatewayId, channel, payloadDir });
      if (typeof client.push !== 'function') {
        throw new Error('this mt-transport build has no Client.push — pull is no longer supported');
      }
      const buf = await client.push(target, pid, {
        ...(deadlineMs !== undefined ? { deadlineMs } : {}),
        ...(typeof onProgress === 'function' ? { onProgress } : {}),
        ...(payloadDir ? { payloadDir } : {}),
        ...(signal ? { signal } : {}),
      });
      return { ok: true, state: 'applied', value: buf };
    };
  }

  return caps;
}

/**
 * Recognise whether a module namespace looks like mt-transport at all, so the
 * loader can tell "wrong module" from "right module, older version".
 */
export function looksLikeMtTransport(m) {
  return typeof m?.Client === 'function' || typeof m?.parse260 === 'function';
}
