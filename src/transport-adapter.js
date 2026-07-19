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

// Chunks requested per pull. NOT mt-transport's default of 16 — see the note at
// the fetch call. 16 never completes on real hardware; 4 does. Measured by
// mt-transport against DEV1 2026-07-19, not chosen.
//
// Cost of this, for anyone exposing it in the UI: ~41 bytes/second effective,
// so budget roughly 3 minutes for a 7 KB image. Do not let a user queue several
// — the channel is shared with the alarm's own traffic.
const CHUNK_BATCH = 4;

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

function getClient(m, { host, gatewayId, channel }) {
  const key = `${host}|${gatewayId}|${channel}`;
  let entry = _clients.get(key);
  if (!entry) {
    const client = new m.Client({ host, gatewayId, channel });
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

  // --- chunkFetch: pull a chunked payload (JPEG etc) off a device ---------
  //
  // mt-transport's `Client` is an OUT-OF-PROCESS consumer of node-dash, not a
  // library: it POSTs to `http://<host>/<gatewayId>/messages` and subscribes to
  // `ws://<host>/events` — both of which are node-dash's own routes. Confirmed
  // by measurement in Q&A Q9; they have driven DEV1 through :8000 all session.
  //
  // So we point it at ourselves. That is a loopback — node-dash → HTTP →
  // node-dash → mesh-gw — and it is deliberate. The alternative is
  // reimplementing Client.fetch()'s manifest/pull/reassemble loop here, which
  // would duplicate the one part of the module that is properly tested against
  // the C++ encoder. Duplicating tested protocol logic to save a local HTTP hop
  // is the wrong trade: the queue spaces commands 3 s apart, so loopback cost is
  // noise, and one frame carries sixteen chunks.
  //
  // `host` and `gatewayId` are supplied per call rather than captured: the
  // gateway radio can change at runtime (mode roles), and a captured one goes
  // stale silently.
  if (typeof m.Client === 'function') {
    caps.chunkFetch = async ({ target, pid, channel, host, gatewayId, timeoutMs, batch }) => {
      assertChannel(channel);
      if (!host || !gatewayId) {
        throw new Error('chunkFetch needs host and gatewayId — node-dash supplies both');
      }
      const client = await getClient(m, { host, gatewayId, channel });
      // Positional signature — fetch(target, pid, opts). Verified against
      // index.js:128, not assumed.
      //
      // batch defaults to CHUNK_BATCH here, NOT to Client's own default of 16.
      // mt-transport measured 16 on real hardware: a 16-chunk batch is ~35 s of
      // transmission during which the device is DEAF (half-duplex) while the
      // Omni rebroadcasts every frame. Re-issuing a pull inside that window makes
      // the device restart from the first gap, so the transfer never completes —
      // it failed indefinitely, not slowly. Batch 4 completed a 32-chunk image in
      // 173 s. Overridable, but the default must be the value that works.
      const buf = await client.fetch(target, pid, {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        batch: batch ?? CHUNK_BATCH,
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
