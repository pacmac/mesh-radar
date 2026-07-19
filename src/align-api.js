// Backend for the mobile Yagi alignment page.
//
// Serves /align, runs the align traceroute loop, and pushes a NARROW sample
// stream over its own WebSocket. Same port, same server — just another route.
//
// Why a separate feed rather than a filter on /events: the dashboard stream
// pushes 7.2 MB on connect (measured 2026-07-19 — env_history 3.8 MB,
// tilt_history 3.0 MB). This page needs ~150 bytes per sample, ~11 KB for a
// whole five-minute session. A filter would not help: the bulk lands before any
// subscribe message could arrive.
//
// traceroute.js is NOT modified. Its header says callers pass args and mode
// logic stays in the caller — align is simply another caller, passing
// cooldownMs: 0 so the loop is not rate-limited by the passive path's cooldown.

import { Router } from 'express';
import { WebSocketServer } from 'ws';
import { traceroute } from './traceroute.js';
import { getRotatorAddress, getPrimaryMac } from './device-config.js';
import { isListenerForMode, transmitterForMode } from './dash-mode.js';
import { listFavourites } from './db.js';
import { log } from './log.js';

const router = Router();
const clients = new Set();

// One session at a time, globally. Two traceroutes in flight to the same target
// cannot be attributed — replies carry no request id, so correlation is
// positional. This is the same constraint mt-transport's queue enforces.
let session = null;   // { num, timer }

// Tick faster than the timeout and every extra dispatch merely JOINS the pending
// one (traceroute.js dedupes by target) — which is what made the first live run
// look dead: one request, ten joins, then a 60s timeout. One attempt per minute.
//
// So the align timeout is short and deliberate. A traceroute round trip at SF11
// is a few seconds; if no reply has come back in 14s it is lost, and asking
// again beats waiting out the discovery-length default.
const ALIGN_TIMEOUT_MS  = 14000;
const ALIGN_INTERVAL_MS = 15000;  // just past the timeout, so each tick is a
                                  // genuine new attempt rather than a join

const round1 = (v) => (typeof v === 'number' && Number.isFinite(v))
  ? Math.round(v * 10) / 10 : null;

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) { try { ws.send(s); } catch { /* dropped */ } }
  }
}

// Status carries a PRE-FORMATTED warning string. If PASV's rx role excludes a
// radio, that radio never listens and one curve is silently empty — which looks
// like a dead antenna rather than a config choice. Say so explicitly.
function statusFrame() {
  const yagiMac = getRotatorAddress();
  const omniMac = getPrimaryMac();
  const yagi = yagiMac ? isListenerForMode('pasv', yagiMac) : false;
  const omni = omniMac ? isListenerForMode('pasv', omniMac) : false;
  let warning = null;
  if (!yagi && !omni)      warning = 'Neither radio is a PASV listener — set the PASV rx role to "all" in Config → Modes.';
  else if (!yagi)          warning = 'The YAGI is not a PASV listener, so its curve will stay empty. Set the PASV rx role to "all".';
  else if (!omni)          warning = 'The OMNI is not a PASV listener, so its curve will stay empty. Set the PASV rx role to "all".';
  return {
    kind: 'status',
    running: !!session,
    target: session?.num ?? null,
    yagi_listening: yagi,
    omni_listening: omni,
    // A live send failure outranks a config warning: it is why nothing is
    // happening RIGHT NOW, which is the question the operator is asking.
    warning: notice ?? warning,
  };
}

// Transient problems the operator must SEE. Held on the server so every client
// shows the same thing — a second phone must not disagree with the first.
let notice = null;
function pushStatus(msg) {
  notice = msg;
  broadcast(statusFrame());
}

// ── the align loop ───────────────────────────────────────────────────────────
// Dispatches through the existing traceroute SSOT. cooldownMs: 0 bypasses the
// passive path's per-node cooldown, which exists to avoid hammering the mesh
// during discovery — during alignment repeated traces of ONE node are the point.
function tick() {
  if (!session) return;

  // The transmitting radio is a MODE ROLE, not a fixed choice. dash-mode is the
  // SSOT for it (mode-dispatch-ssot). Hardcoding the rotator here was wrong twice
  // over: it ignores the configured PASV tx role, and it dispatches through a
  // radio that may be OFFLINE while another is READY — which is exactly what
  // happened on the first live test (503 NEED_PAIR / RECONNECTING, every send).
  const device = transmitterForMode('pasv');
  if (!device) {
    pushStatus('No transmitting radio available for PASV — check Config → Modes.');
    return;
  }

  // Tell the page a request is in the air. Without this the operator sees a LIVE
  // badge, no number, and no reason — indistinguishable from a broken page.
  session.probes += 1;
  broadcast({ kind: 'probe', n: session.probes, at: Math.floor(Date.now() / 1000) });

  traceroute.dispatch({
    to: session.num,
    device,
    timeoutMs: ALIGN_TIMEOUT_MS,
    cooldownMs: 0,
    cooldownKey: 'align',
  }).catch((e) => {
    // A dispatch that never leaves the gateway produced NOTHING on the page
    // before this: no sample, no error, just a still screen. Standing at a mast
    // that is indistinguishable from "the mesh is quiet". Say it out loud.
    const msg = String(e?.message ?? e);
    if (/cooldown/i.test(msg)) return;              // benign, self-resolving
    pushStatus(`Send failed: ${msg}`);
  });
}

// A traceroute reply is heard by whichever radios are in range, and mesh-gw emits
// ONE EVENT PER RECEIVING RADIO carrying its own __ble_addr. That per-radio
// attribution is the entire basis of the two-curve chart, and it exists ONLY on
// the live path — signal_history has no device column and its UNIQUE(num,
// packet_id) index discards the second radio's copy.
// The two radios hear the same reply a fraction apart and each produces its own
// 'result'. Rather than trying to pair them by identity — they carry no shared
// request id — hold the latest reading per radio and expire anything older than
// PAIR_WINDOW_MS. A curve gaps rather than lying when one antenna goes deaf,
// which is exactly the information the operator needs.
const PAIR_WINDOW_MS = 15000;
const latest = new Map();   // mac -> { snr, at }

function onResult(r) {
  if (!session || r.from !== session.num) return;
  if (!r.rx_device || r.rx_snr === null || r.rx_snr === undefined) return;

  clearNotice();                      // something arrived — the link is alive
  latest.set(r.rx_device, { snr: r.rx_snr, at: Date.now() });

  const fresh = (mac) => {
    const e = mac ? latest.get(mac) : null;
    return (e && Date.now() - e.at <= PAIR_WINDOW_MS) ? round1(e.snr) : null;
  };

  const yagi = fresh(getRotatorAddress());
  const omni = fresh(getPrimaryMac());

  // route length 0 == direct. A relayed reading describes the relay's path, not
  // where this antenna is pointing, and would actively mislead the operator.
  const direct = Array.isArray(r.route) ? r.route.length === 0 : false;

  broadcast({
    t: Math.floor((r.ts ?? Date.now()) / 1000),
    yagi, omni,
    delta: (yagi !== null && omni !== null) ? round1(yagi - omni) : null,
    hops: Array.isArray(r.route) ? r.route.length : null,
    direct,
  });
}

traceroute.on('result', onResult);

// A traceroute that times out or fails to send emits 'cancel'. Silence is the
// normal failure mode on an unacked broadcast link, so an unreported timeout
// looks identical to a page that is simply not working.
traceroute.on('cancel', (c) => {
  if (!session || c.to !== session.num) return;
  pushStatus(`No reply from the node (${c.reason ?? 'timeout'}) — still trying.`);
});

// Clear a stale notice as soon as anything succeeds, so a one-off blip does not
// leave a warning sitting on screen contradicting live data.
function clearNotice() {
  if (notice !== null) { notice = null; broadcast(statusFrame()); }
}

export function alignStart({ num }) {
  if (session) alignStop();
  notice = null;
  latest.clear();
  session = { num, probes: 0, timer: setInterval(tick, ALIGN_INTERVAL_MS) };
  log.info('align', `started on !${Number(num).toString(16)}`);
  tick();                       // first sample immediately, not after 6 s
  broadcast(statusFrame());
  return { ok: true, state: 'applied' };
}

export function alignStop() {
  if (!session) return { ok: true, state: 'applied' };
  clearInterval(session.timer);
  log.info('align', 'stopped');
  session = null;
  broadcast(statusFrame());
  return { ok: true, state: 'applied' };
}

// ── routes ───────────────────────────────────────────────────────────────────
router.get('/align/targets', (_req, res) => {
  // Favourites only — this page exists to align the nodes you care about.
  // queryFavourites already COALESCEs long_name → short_name → node_id into
  // `label`. Re-deriving it here produced the hex fallback for every node,
  // because those columns are not in the result set.
  const rows = listFavourites() ?? [];
  res.json(rows.map(r => ({ num: r.num, label: r.label })));
});

router.post('/align/start', (req, res) => {
  const num = Number(req.body?.num);
  if (!Number.isFinite(num)) return res.status(400).json({ error: 'num required' });
  res.json(alignStart({ num }));
});

router.post('/align/stop', (_req, res) => res.json(alignStop()));

// ── WS /align/events ─────────────────────────────────────────────────────────
export function attachAlignWs(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/align/events')) return;   // /events is not ours
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify(statusFrame()));
      ws.on('close', () => {
        clients.delete(ws);
        // Dead-man stop. A phone that locks, loses signal or navigates away must
        // not leave the mesh transmitting indefinitely on a shared channel.
        if (clients.size === 0 && session) {
          log.info('align', 'last client gone — stopping');
          alignStop();
        }
      });
    });
  });
}

export default router;
