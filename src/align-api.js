// Backend for the mobile Yagi alignment page.
//
// Serves /align, runs the align PING loop, and pushes a NARROW sample stream
// over its own WebSocket. Same port, same server — just another route.
//
// Why a separate feed rather than a filter on /events: the dashboard stream
// pushes 7.2 MB on connect (measured 2026-07-19 — env_history 3.8 MB,
// tilt_history 3.0 MB). This page needs ~150 bytes per sample. A filter would
// not help: the bulk lands before any subscribe message could arrive.
//
// STIMULUS is `ping`, not traceroute (changed 2026-07-19). The alarm firmware is
// ours and answers `@<suffix> ping` -> `pong`: upt, rssi, snr (mt-transport
// API.md §3). The pong's payload rssi/snr is the DEVICE's reading of our ping —
// measured at the antenna being turned — and is the primary alignment signal.
// See docs/modules/align-api.md for the full rationale and the measurements.

import { Router } from 'express';
import { WebSocketServer } from 'ws';
import { getRotatorAddress, getPrimaryMac, resolvePrimaryNodeId } from './device-config.js';
import { dashMode } from './dash-mode.js';
import { resolveCommandChannel } from './node-settings.js';
import { getDeviceChannelsByNodeId } from './ws-relay.js';
import { listFavourites } from './db.js';
import { log } from './log.js';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8001';

const router = Router();
const clients = new Set();

// One session at a time, globally.
let session = null;   // { num, suffix, probes, prevMode, gatewayNodeId, channel, pending }

// Pings are NOT continuous — the operator COMMANDS each one (Peter, 2026-07-19):
// point the antenna, press PING, read the result, point again. So there is no
// loop and no interval. Each press fires exactly one ping. Correlation is by
// reply_id, so a slow reply still matches its own ping.
//
// Measured 2026-07-19: reply latency mean 16.1s (min 11.9, max 18.6), ~75% reply
// rate. So a ping is given 30s before it is declared a miss.
const ALIGN_REPLY_TIMEOUT_MS = 30000;
// Both radios hear one pong a fraction apart, each as its own 'packet' event with
// the same reply_id. Collect for a short window after the first, then emit ONE
// sample carrying both radios' envelope readings.
const ALIGN_COLLECT_MS       = 1200;

const round1 = (v) => (typeof v === 'number' && Number.isFinite(v))
  ? Math.round(v * 10) / 10 : null;

// The 4-hex suffix of a node id is the safe command target: derived from the id,
// it can never drift, unlike a user-editable shortName (Peter, 2026-07-19).
const hexSuffix = (num) => (Number(num) >>> 0).toString(16).padStart(8, '0').slice(-4);

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) { try { ws.send(s); } catch { /* dropped */ } }
  }
}

// Transient problems the operator must SEE. Held on the server so every client
// shows the same thing — a second phone must not disagree with the first.
let notice = null;

function statusFrame() {
  return {
    kind: 'status',
    running: !!session,
    target: session?.num ?? null,
    // Which home radio transmits fixes what dev_rssi means (the device's reading
    // of THAT radio). Surface it so the reading is never ambiguous.
    tx: session?.gatewayNodeId ?? null,
    channel: session?.channel ?? null,
    warning: notice,
  };
}

function pushStatus(msg) {
  notice = msg;
  broadcast(statusFrame());
}

function clearNotice() {
  if (notice !== null) { notice = null; broadcast(statusFrame()); }
}

// ── one commanded ping ───────────────────────────────────────────────────────
// Fires exactly ONE ping. Returns { ok, n } or { ok:false, error }. The reply (or
// a miss) arrives asynchronously over the WS as a sample / miss frame.
async function alignPing() {
  if (!session) return { ok: false, error: 'no session' };

  session.probes += 1;
  const n = session.probes;
  broadcast({ kind: 'probe', n, at: Math.floor(Date.now() / 1000) });

  let sent;
  try {
    const r = await fetch(`${BRIDGE_URL}/${session.gatewayNodeId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `@${session.suffix} ping`, channel: session.channel }),
    });
    if (!r.ok) throw new Error(`gateway ${r.status}`);
    sent = await r.json();
  } catch (e) {
    broadcast({ kind: 'miss', n, reason: `Send failed: ${e.message}` });
    return { ok: false, error: e.message };
  }
  if (!sent?.id) {
    broadcast({ kind: 'miss', n, reason: 'gateway returned no packet id' });
    return { ok: false, error: 'no packet id' };
  }

  // reply_id on the pong will equal this packet id (API.md §3). A per-ping timer
  // declares a miss if no pong lands — the page needs to re-enable the button
  // and say so, rather than wait forever on a silent link.
  const entry = { sentAt: Date.now(), n, radios: new Map(), payload: null, emitted: false, collectTimer: null };
  entry.missTimer = setTimeout(() => {
    if (session?.pending.get(sent.id) === entry && !entry.emitted) {
      session.pending.delete(sent.id);
      broadcast({ kind: 'miss', n, reason: 'No reply — try again.' });
    }
  }, ALIGN_REPLY_TIMEOUT_MS);
  session.pending.set(sent.id, entry);
  return { ok: true, n };
}

// Called from bridge-events for every TEXT_MESSAGE_APP reply carrying a
// reply_id. No-op unless it matches a pending ping of the active session, so
// routing every reply here is free.
export function handleAlignPong(pkt, rxDevice) {
  if (!session) return;
  const replyId = pkt?.decoded?.reply_id;
  if (!replyId) return;
  const pending = session.pending.get(replyId);
  if (!pending) return;   // not ours, or already resolved

  let payload = null;
  try {
    const text = pkt.decoded.payload ? Buffer.from(pkt.decoded.payload, 'base64').toString('utf8') : '';
    payload = JSON.parse(text);
  } catch { /* not JSON — ignore */ }
  if (!payload || payload.type !== 'pong') return;

  clearNotice();
  if (pending.missTimer) { clearTimeout(pending.missTimer); pending.missTimer = null; }
  pending.payload = payload;          // device's own rssi/snr (identical per radio)
  // Per-radio envelope: THIS radio's reading of the device's transmission.
  if (rxDevice && typeof pkt.rx_snr === 'number') {
    pending.radios.set(rxDevice, { snr: pkt.rx_snr, rssi: pkt.rx_rssi ?? null });
  }

  // First matching event opens a short collection window for the other radio.
  if (!pending.collectTimer) {
    pending.collectTimer = setTimeout(() => emitSample(replyId), ALIGN_COLLECT_MS);
  }
}

function emitSample(replyId) {
  if (!session) return;
  const p = session.pending.get(replyId);
  if (!p || p.emitted) return;
  p.emitted = true;
  session.pending.delete(replyId);

  const envSnr = (mac) => {
    const e = mac ? p.radios.get(mac) : null;
    return e ? round1(e.snr) : null;
  };
  const yagi = envSnr(getRotatorAddress());
  const omni = envSnr(getPrimaryMac());

  broadcast({
    t: Math.floor(p.sentAt / 1000),
    n: p.n,
    // PRIMARY: the device's reading of our ping, at the antenna being turned.
    dev_rssi: round1(p.payload?.rssi),
    dev_snr:  round1(p.payload?.snr),
    // SECONDARY: our radios' reading of the device (per-radio envelope).
    yagi, omni,
    delta: (yagi !== null && omni !== null) ? round1(yagi - omni) : null,
  });
}

export function alignStart({ num }) {
  if (session) alignStop();
  notice = null;

  // Send from the primary radio (OMNI). It is the reliable transmitter, and it
  // fixes what dev_rssi means for the whole session — it must not change
  // mid-session or the curve loses its meaning.
  const gatewayNodeId = resolvePrimaryNodeId();
  if (!gatewayNodeId) return { ok: false, state: 'invalid', error: 'no gateway radio available to send from' };

  // Channel resolution is the node-settings SSOT: it refuses index 0 (PRIMARY)
  // by construction and resolves "Private" by name. Never reimplemented here.
  const ch = resolveCommandChannel(getDeviceChannelsByNodeId(gatewayNodeId));
  if (!ch.ok) return { ok: false, state: 'invalid', error: ch.error };

  // Force PASV for the duration. In ACTV the rotator is driven by active-tracker,
  // so the home Yagi swings while the operator turns the remote one — that
  // perturbs the secondary envelope curves. Previous mode restored on stop.
  const prevMode = dashMode.value;
  if (prevMode !== 0) {
    dashMode.set(0);
    log.info('align', `mode ${prevMode} -> PASV for alignment`);
  }

  session = {
    num, suffix: hexSuffix(num), probes: 0, prevMode,
    gatewayNodeId, channel: ch.channel,
    pending: new Map(),
  };
  log.info('align', `session on !${(Number(num) >>> 0).toString(16)} (@${session.suffix}) via ${gatewayNodeId} ch${ch.channel}`);
  broadcast(statusFrame());
  return { ok: true, state: 'applied' };
}

export function alignStop() {
  if (!session) return { ok: true, state: 'applied' };
  for (const p of session.pending.values()) {
    if (p.collectTimer) clearTimeout(p.collectTimer);
    if (p.missTimer)    clearTimeout(p.missTimer);
  }

  // Put the dashboard back the way we found it.
  if (session.prevMode !== undefined && session.prevMode !== dashMode.value) {
    dashMode.set(session.prevMode);
    log.info('align', `mode restored to ${session.prevMode}`);
  }

  log.info('align', 'stopped');
  session = null;
  broadcast(statusFrame());
  return { ok: true, state: 'applied' };
}

// ── routes ───────────────────────────────────────────────────────────────────
router.get('/align/targets', (_req, res) => {
  const rows = listFavourites() ?? [];
  res.json(rows.map(r => ({ num: r.num, label: r.label })));
});

router.post('/align/start', (req, res) => {
  const num = Number(req.body?.num);
  if (!Number.isFinite(num)) return res.status(400).json({ error: 'num required' });
  const result = alignStart({ num });
  res.status(result.ok ? 200 : 400).json(result);
});

// One commanded ping. Opens (or re-targets) the session first, so a single button
// press is all the operator needs — no separate "start".
router.post('/align/ping', async (req, res) => {
  const num = Number(req.body?.num);
  if (!Number.isFinite(num)) return res.status(400).json({ error: 'num required' });
  if (!session || session.num !== num) {
    const started = alignStart({ num });
    if (!started.ok) return res.status(400).json(started);
  }
  const result = await alignPing();
  res.status(result.ok ? 200 : 502).json(result);
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
