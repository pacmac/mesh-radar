// Backend for the mobile Yagi alignment page.
//
// Serves /align and OWNS THE ENTIRE ALIGN VIEW-MODEL (docs/BROWSER_CONTRACT.md):
// quality, labels, best, trend, bar heights, burst averaging — everything derived
// is computed here and pushed complete over WS /align/events. The browser renders
// it and decides nothing. Two phones on one session show identical screens.
//
// STIMULUS is `ping` (the alarm firmware answers `@<suffix> ping` -> pong with
// rssi/snr — the device's own reading of our ping, at the antenna being turned).
// Each press fires a BURST of N pings that are AVERAGED into one reading, because
// a single ping jitters at a fixed position. See docs/modules/align-api.md.

import { Router } from 'express';
import { WebSocketServer } from 'ws';
import { getRotatorAddress, getPrimaryMac, resolvePrimaryNodeId } from './device-config.js';
import { dashMode } from './dash-mode.js';
import { resolveCommandChannel } from './node-settings.js';
import { getDeviceChannelsByNodeId } from './ws-relay.js';
import { listFavourites, getConfig, setConfig } from './db.js';
import { signalQuality } from './utils.js';
import { sendMeshText } from './mesh-send.js';
import { log } from './log.js';

const router = Router();
const clients = new Set();

// One session at a time, globally.
let session = null;

// Measured 2026-07-19: reply latency mean 16.1s, max 18.6s, ~75% land. The two
// radios' copies of one pong are gathered over a short window; burst pings fire
// just over that window apart so each is a genuine separate attempt.
//
// A burst resolves on ONE deadline sized to the reply latency, NOT by waiting out
// each unanswered ping — otherwise a burst where some replies land and others
// never do would sit "gathering" for the full per-ping timeout (~30s) before the
// already-sufficient average is shown, and presses would 409 the whole time.
const ALIGN_COLLECT_MS       = 1200;
const BURST_SPACING_MS       = 1200;
const N_MIN = 1, N_MAX = 5, N_DEFAULT = 4;

// The reply-wait window is operator-set and PERSISTED (the page field). A weak
// node can answer at 18–43 s, longer than the old fixed 20 s window that
// discarded those replies. Default 30 s; clamped 5–120. Read at burst creation.
const REPLY_WINDOW_DEFAULT_SEC = 30, REPLY_WINDOW_MIN = 5, REPLY_WINDOW_MAX = 120;
const clampWindow = (s) => Math.max(REPLY_WINDOW_MIN, Math.min(REPLY_WINDOW_MAX, Math.round(Number(s) || REPLY_WINDOW_DEFAULT_SEC)));
const replyWindowSec = () => clampWindow(getConfig('align.reply_window_sec', REPLY_WINDOW_DEFAULT_SEC));

const clampN = (n) => Math.max(N_MIN, Math.min(N_MAX, Math.round(Number(n) || N_DEFAULT)));
const round1 = (v) => (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * 10) / 10 : null;
const mean   = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const hexSuffix = (num) => (Number(num) >>> 0).toString(16).padStart(8, '0').slice(-4);

// Quality band → label + semantic colour. Bands per node-status.js.
function qualityBand(q) {
  if (q == null)  return { label: '—',         cls: 'base-content/30' };
  if (q >= 76)    return { label: 'Excellent', cls: 'success' };
  if (q >= 51)    return { label: 'Good',      cls: 'success' };
  if (q >= 26)    return { label: 'Fair',      cls: 'warning' };
  return            { label: 'Poor',      cls: 'error' };
}

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === 1) { try { ws.send(s); } catch { /* dropped */ } }
  }
}

// ── the view-model — the ONLY thing the WS pushes ────────────────────────────
// Built fresh on every change: all derived state (best, trend, bar height,
// current) is computed here, never in the browser.
function computeView() {
  if (!session) {
    return { kind: 'align', running: false, target: null, tx: null, channel: null,
             nBurst: N_DEFAULT, replyWindowSec: replyWindowSec(),
             burst: null, warning: null, best: null, readings: [] };
  }
  const rs = session.readings;
  const qualities = rs.map(r => r.quality);
  let lo = qualities.length ? Math.min(...qualities) : 0;
  let hi = qualities.length ? Math.max(...qualities) : 100;
  if (hi - lo < 20) { const m = (hi + lo) / 2; lo = m - 10; hi = m + 10; }  // don't flatten
  const barPct = (q) => Math.max(8, Math.min(100, Math.round(((q - lo) / (hi - lo)) * 100)));

  const bestN = rs.length ? rs.reduce((a, b) => (b.quality > a.quality ? b : a)).n : null;

  const readings = rs.map((r, i) => {
    const prev = i > 0 ? rs[i - 1] : null;
    const delta = prev ? r.quality - prev.quality : null;
    return {
      ...r,
      barPct: barPct(r.quality),
      isBest: r.n === bestN,
      isCurrent: i === rs.length - 1,
      trendDir: delta === null ? null : delta > 1 ? 'up' : delta < -1 ? 'down' : 'same',
      trendDelta: delta === null ? null : Math.round(delta),
    };
  });

  // The headline: the current reading plus its relationship to the best, both
  // computed here so the browser only prints them.
  let current = null;
  if (readings.length) {
    const c = readings[readings.length - 1];
    const bestQ = rs.reduce((a, b) => (b.quality > a.quality ? b : a)).quality;
    // A reading that TIES the best is at the best — say "BEST YET", not "−0 below".
    const atBest = c.quality >= bestQ;
    current = { ...c, isBest: atBest, gapToBest: Math.max(0, bestQ - c.quality), bestN, bestAgo: c.n - bestN };
  }

  return {
    kind: 'align',
    running: true,
    target: session.num,
    tx: session.txLabel,
    channel: session.channel,
    nBurst: session.nBurst,
    replyWindowSec: replyWindowSec(),
    burst: session.burst ? { active: true, got: session.burst.got, of: session.burst.of } : null,
    warning: session.warning,
    best: bestN === null ? null : { n: bestN },
    current,
    readings,
  };
}

function pushView() { broadcast(computeView()); }

// ── one ping within a burst ──────────────────────────────────────────────────
async function sendPing(burst) {
  if (!session || session.burst !== burst) return;   // burst cancelled
  let sent;
  try {
    // Broadcast on the Private channel, @suffix addressing; recorded as a 'ping'
    // via the shared send path so every probe lands in the feed.
    sent = await sendMeshText({
      gatewayNodeId: session.gatewayNodeId,
      text: `@${session.suffix} ping`,
      channel: session.channel,
      category: 'ping',
    });
  } catch (e) {
    burst.done += 1;                 // a ping that never left counts as resolved
    maybeResolve(burst);
    return;
  }
  if (!sent?.id) { burst.done += 1; maybeResolve(burst); return; }

  // No per-ping timeout: the burst-level deadline resolves everything at once. An
  // unanswered ping simply never lands a sample; the deadline averages what did.
  const ping = { replyId: sent.id, payload: null, yagi: null, omni: null, collectTimer: null, resolved: false };
  burst.pings.set(sent.id, ping);
}

// A pong arrives once per RECEIVING radio; gather both copies of one ping over a
// short window, then finalize it into the burst.
export function handleAlignPong(pkt, rxDevice) {
  if (!session?.burst) return;
  const replyId = pkt?.decoded?.reply_id;
  if (!replyId) return;
  const ping = session.burst.pings.get(replyId);
  if (!ping || ping.resolved) return;

  let payload = null;
  try {
    const text = pkt.decoded.payload ? Buffer.from(pkt.decoded.payload, 'base64').toString('utf8') : '';
    payload = JSON.parse(text);
  } catch { /* not JSON */ }
  if (!payload || payload.type !== 'pong') return;

  ping.payload = payload;
  if (typeof pkt.rx_snr === 'number') {
    if (rxDevice === getRotatorAddress()) ping.yagi = { rssi: pkt.rx_rssi ?? null, snr: pkt.rx_snr };
    else if (rxDevice === getPrimaryMac()) ping.omni = { rssi: pkt.rx_rssi ?? null, snr: pkt.rx_snr };
  }
  if (!ping.collectTimer) {
    ping.collectTimer = setTimeout(() => finalizePing(session.burst, ping), ALIGN_COLLECT_MS);
  }
}

// A ping's two-radio gather window closed with a reply — record its sample.
function finalizePing(burst, ping) {
  if (!session || session.burst !== burst || ping.resolved || !ping.payload) return;
  ping.resolved = true;
  if (ping.collectTimer) clearTimeout(ping.collectTimer);
  burst.done += 1;
  burst.samples.push({
    quality: signalQuality(ping.payload.rssi, ping.payload.snr),
    rssi: ping.payload.rssi, snr: ping.payload.snr,
    yagi_q: ping.yagi ? signalQuality(ping.yagi.rssi, ping.yagi.snr) : null,
    omni_q: ping.omni ? signalQuality(ping.omni.rssi, ping.omni.snr) : null,
  });
  burst.got = burst.samples.length;
  session.warning = null;           // something landed — the link is alive
  pushView();                       // progress (got/of)
  maybeResolve(burst);
}

// Resolve early only when EVERY ping has resolved (all landed, or all sends
// failed). The mixed case — some land, some never reply — is resolved by the
// burst deadline instead, so it does not wait out the stragglers.
function maybeResolve(burst) {
  if (burst.done >= burst.of) resolveBurst(burst);
}

// Average the landed samples into ONE reading.
function resolveBurst(burst) {
  if (!session || session.burst !== burst) return;
  session.burst = null;
  if (burst.deadlineTimer) clearTimeout(burst.deadlineTimer);
  for (const p of burst.pings.values()) if (p.collectTimer) clearTimeout(p.collectTimer);
  const s = burst.samples;

  if (s.length === 0) {
    session.warning = 'No replies — try again.';
    pushView();
    return;
  }

  const qs = s.map(x => x.quality);
  const yq = s.map(x => x.yagi_q).filter(v => v != null);
  const oq = s.map(x => x.omni_q).filter(v => v != null);
  const q = Math.round(mean(qs));
  const band = qualityBand(q);

  session.readings.push({
    n: ++session.readingCount,
    quality: q,
    label: band.label,
    cls: band.cls,
    spread: Math.round(Math.max(...qs) - Math.min(...qs)),
    got: s.length,
    of: burst.of,
    rssi: Math.round(mean(s.map(x => x.rssi))),
    snr: round1(mean(s.map(x => x.snr))),
    yagi_q: yq.length ? Math.round(mean(yq)) : null,
    omni_q: oq.length ? Math.round(mean(oq)) : null,
  });
  pushView();
}

// ── commanded burst ──────────────────────────────────────────────────────────
async function alignPing(n) {
  if (!session) return { ok: false, error: 'no session' };
  if (session.burst) return { ok: false, error: 'burst in progress' };
  const of = clampN(n);
  session.nBurst = of;
  const burst = { of, got: 0, done: 0, samples: [], pings: new Map(), deadlineTimer: null };
  session.burst = burst;
  session.warning = null;
  // One deadline covers the reply window for the LAST ping (sent (of-1) spacings
  // in). At it, resolve with whatever landed — do not wait out unanswered pings.
  // The window is the persisted operator setting, read now at burst creation.
  burst.deadlineTimer = setTimeout(() => resolveBurst(burst),
    (of - 1) * BURST_SPACING_MS + replyWindowSec() * 1000);
  pushView();                       // button -> gathering 0/of
  // Fire the pings, spaced so each is a fresh attempt. Sends are awaited so the
  // burst can be cancelled by a stop between pings.
  for (let i = 0; i < of; i++) {
    if (session?.burst !== burst) return { ok: true, of };   // cancelled
    await sendPing(burst);
    if (i < of - 1) await sleep(BURST_SPACING_MS);
  }
  return { ok: true, of };
}

export function alignStart({ num }) {
  if (session) alignStop();

  const gatewayNodeId = resolvePrimaryNodeId();
  if (!gatewayNodeId) return { ok: false, state: 'invalid', error: 'no gateway radio available to send from' };
  const ch = resolveCommandChannel(getDeviceChannelsByNodeId(gatewayNodeId));
  if (!ch.ok) return { ok: false, state: 'invalid', error: ch.error };

  // Label the TX radio for the view. Primary is the OMNI; the YAGI is unreliable
  // since its WiFi→BLE swap, so it is not used to transmit.
  const primaryMac = getPrimaryMac();
  const txLabel = (primaryMac && primaryMac === getRotatorAddress()) ? 'YAGI' : 'OMNI';

  // Force PASV for the session (restored on stop): ACTV swings the home Yagi.
  const prevMode = dashMode.value;
  if (prevMode !== 0) { dashMode.set(0); log.info('align', `mode ${prevMode} -> PASV for alignment`); }

  session = {
    num, suffix: hexSuffix(num), gatewayNodeId, channel: ch.channel, txLabel,
    prevMode, nBurst: N_DEFAULT, readingCount: 0, readings: [], burst: null, warning: null,
  };
  log.info('align', `session on !${(Number(num) >>> 0).toString(16)} (@${session.suffix}) via ${gatewayNodeId} (${txLabel}) ch${ch.channel}`);
  pushView();
  return { ok: true, state: 'applied' };
}

export function alignStop() {
  if (!session) return { ok: true, state: 'applied' };
  if (session.burst) {
    if (session.burst.deadlineTimer) clearTimeout(session.burst.deadlineTimer);
    for (const p of session.burst.pings.values()) {
      if (p.collectTimer) clearTimeout(p.collectTimer);
    }
    session.burst = null;
  }
  if (session.prevMode !== undefined && session.prevMode !== dashMode.value) {
    dashMode.set(session.prevMode);
    log.info('align', `mode restored to ${session.prevMode}`);
  }
  log.info('align', 'stopped');
  session = null;
  broadcast(computeView());   // running:false to everyone
  return { ok: true, state: 'applied' };
}

// ── routes ───────────────────────────────────────────────────────────────────
router.get('/align/targets', (_req, res) => {
  const rows = listFavourites() ?? [];
  res.json(rows.map(r => ({ num: r.num, label: r.label })));
});

// One press = one burst. Opens/re-targets the session, then fires N pings.
router.post('/align/ping', async (req, res) => {
  const num = Number(req.body?.num);
  const n = req.body?.n;
  if (!Number.isFinite(num)) return res.status(400).json({ error: 'num required' });
  if (!session || session.num !== num) {
    const started = alignStart({ num });
    if (!started.ok) return res.status(400).json(started);
  }
  const result = await alignPing(n);
  res.status(result.ok ? 200 : 409).json(result);
});

router.post('/align/stop', (_req, res) => res.json(alignStop()));

// Persist the operator's reply-wait period (the page field). Server-owned value;
// the browser field is raw input that calls this, then renders the pushed model.
router.post('/align/reply-window', (req, res) => {
  const sec = clampWindow(req.body?.sec);
  setConfig('align.reply_window_sec', sec);
  broadcast(computeView());          // every client sees the new value
  res.json({ ok: true, sec });
});

// ── WS /align/events ─────────────────────────────────────────────────────────
export function attachAlignWs(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/align/events')) return;   // /events is not ours
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify(computeView()));            // full state on connect
      ws.on('close', () => {
        clients.delete(ws);
        if (clients.size === 0 && session) {
          log.info('align', 'last client gone — stopping');
          alignStop();
        }
      });
    });
  });
}

export default router;
