// Ask the node-dash socket a question and get back OUR reply.
//
// Spec: docs/modules/check-harness.md
//
// This exists because two checks need the identical rule and a rule written
// twice drifts apart silently — the same argument docs/modules/coulomb.md makes
// for splitting coulombModel out of buildCoulomb.
//
// THE RULE: the first message of a type is not the answer. The socket REPLAYS
// page data on connect at the server's own default window, and only then answers
// what was asked. Taking the first `snapshot` message compares against the wrong
// window. This has already bitten the browser and tests/test_page_snapshot.py.

import WebSocket from 'ws';

const URL_DEFAULT = 'ws://127.0.0.1:8000/events';

// MEASURED, not chosen. The connect replay carries a single `env_history` frame
// of 5,907,462 bytes (measured 2026-08-13 against the live socket; the whole
// replay is ~13.2 MB — bug ledger B92). A client on library defaults never sees
// its reply at all: python's websockets caps at 1 MiB and drops the connection
// with `1009 message too big`, which is exactly how tests/test_node.py fails.
//
// 32 MiB is 5.68x the largest frame observed, so retention can grow several-fold
// before this needs revisiting. It is a ceiling on a read buffer, not an
// allocation — nothing is reserved.
const MAX_PAYLOAD_DEFAULT = 32 * 1024 * 1024;

// MEASURED. Slowest single board is the all-time window at 3,346 ms; all six
// windows answered on one socket in 3,354 ms (2026-08-13, warm store, 700 MB
// data/node-dash.db). 20 s is 6x the slowest observed reply — enough that a cold
// page cache does not trip it, short enough that a genuinely dead socket fails
// the check rather than hanging the run.
const TIMEOUT_MS_DEFAULT = 20_000;

/** Open a socket, send `requests`, resolve when `match` has claimed a reply for
 *  each one. One connection for N questions.
 *
 *  `match(msg, request)` decides whether `msg` answers `request`. It must key on
 *  something the reply echoes — `days`, `unit` — because ordering is not a
 *  guarantee and the replay is indistinguishable by position.
 *
 *  Replies come back in REQUEST order regardless of arrival order. */
export function askWsMany(requests, match, {
  url = URL_DEFAULT,
  timeoutMs = TIMEOUT_MS_DEFAULT,
  maxPayload = MAX_PAYLOAD_DEFAULT,
} = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload });
    const answers = new Array(requests.length).fill(undefined);
    let outstanding = requests.length;
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      err ? reject(err) : resolve(value);
    };

    const timer = setTimeout(() => {
      const missing = requests.filter((_, i) => answers[i] === undefined);
      finish(new Error(
        `no reply within ${timeoutMs} ms for ${missing.length} of ${requests.length} request(s): `
        + `${JSON.stringify(missing)}`));
    }, timeoutMs);

    ws.on('open', () => { for (const r of requests) ws.send(JSON.stringify(r)); });

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf); } catch { return; }   // not ours; not an error
      for (let i = 0; i < requests.length; i++) {
        if (answers[i] !== undefined) continue;
        let hit = false;
        try { hit = match(msg, requests[i]); } catch { hit = false; }
        if (!hit) continue;
        answers[i] = msg;
        if (--outstanding === 0) finish(null, answers);
        return;                                          // one reply answers one request
      }
    });

    ws.on('error', (e) => finish(new Error(`socket ${url} failed: ${e.message}`)));
    ws.on('close', () => finish(new Error(
      `socket ${url} closed with ${outstanding} of ${requests.length} request(s) unanswered`)));
  });
}

/** One question, one reply. `match(msg)` takes the message alone. */
export async function askWs(request, match, opts = {}) {
  const [answer] = await askWsMany([request], (msg) => match(msg), opts);
  return answer;
}
