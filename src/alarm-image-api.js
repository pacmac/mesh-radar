// ALARM PLUGIN — image bytes. NOT CORE.
//
// Serves a JPEG pac-host already holds on disk, so the Camera page can put one
// in an <img src>. Delete this file and its one mount line in index.js and
// node-dash is unchanged.
//
// Why a GET exists here when pac-command-api.js deliberately has none: image
// bytes are not page data. The core WS-only guard already draws exactly this
// line — it keys on `Sec-Fetch-Dest: empty`, which a fetch() sets and an
// <img src> does not. A JPEG is a binary asset, like a font. The LIST of
// images is page data and goes over the WS (alarm_images).
//
// See docs/modules/alarm-image-api.md.

import { Router } from 'express';
import { getImageBytes, getImageById, getDeviceImage } from './pac-host.js';
import { isStoredPid, isStoredId, isDevicePid, setDeviceImage } from './alarm-images.js';
import { numToNodeId } from './utils.js';
import { log } from './log.js';

const router = Router();

const FETCH_TIMEOUT_MS = 5000;
// A pull of a pid we do not already hold is a full radio transfer. services
// measured 183-239 s for one; the deployed unit listens ~8 s in every 900, so a
// slow window can push it well past that. Generous, and bounded.
const PULL_TIMEOUT_MS  = 600000;

// GET /alarm/image/:num/by-id/:id — the PREFERRED byte route.
//
// pid is a recycling uint16 and is not unique within a unit's stored list
// (!987ab80f: 7 rows, 3 distinct pids), so /images/<t>/<pid> can only ever
// return the newest row for a pid — four of GARG's images were listable but
// unreachable. services' by-id route fixes that; measured 200 in 1.6 ms.
router.get('/alarm/image/:num/by-id/:id', async (req, res) => {
  const num = Number(req.params.num);
  const id  = Number(req.params.id);
  if (!Number.isInteger(num) || !Number.isInteger(id)) {
    return res.status(400).json({ error: 'num and id must be integers' });
  }
  if (!isStoredId(num, id)) {
    return res.status(404).json({ error: 'no such stored image for this unit' });
  }
  try {
    const { buf, type } = await getImageById(numToNodeId(num), id, { timeoutMs: FETCH_TIMEOUT_MS });
    res.set('Content-Type', type);
    // Safe to cache hard: an id names ONE immutable stored blob, unlike a pid.
    res.set('Cache-Control', 'private, max-age=86400');
    return res.send(buf);
  } catch (err) {
    return res.status(err.status ?? 502).json({ error: err.message });
  }
});

// GET /alarm/image/:num/:pid
router.get('/alarm/image/:num/:pid', async (req, res) => {
  const num = Number(req.params.num);
  const pid = Number(req.params.pid);
  if (!Number.isInteger(num) || !Number.isInteger(pid)) {
    return res.status(400).json({ error: 'num and pid must be integers' });
  }

  // THE ALLOWLIST, and the reason this module exists in this shape.
  // Asking pac-host for a valid-range pid it does not hold does NOT 404 — it
  // leaves the store path and never answers (measured 2026-07-31: no response
  // in 45 s). A stale page holding an evicted pid must not be able to hang a
  // connection, so we only ever ask for a pid we ourselves published in the
  // last poll. Never remove this in favour of "let pac-host decide".
  // NOTE the allowlist here is STORED-ONLY, deliberately. The device-held pid is
  // fetchable, but never through this route: a pid we do not already hold runs
  // the full radio pull (minutes), and an <img src> would hang the socket. That
  // case goes through POST /alarm/image/:num/:pid/fetch below.
  if (!isStoredPid(num, pid)) {
    return res.status(404).json({ error: 'no such stored image for this unit' });
  }

  try {
    // Plain form only. `?refresh=1` forces pac-host's radio path — minutes, and
    // it costs the device a wake window — and must never be reachable from a
    // page. This route takes no query parameters at all.
    const { buf, type } = await getImageBytes(numToNodeId(num), pid, { timeoutMs: FETCH_TIMEOUT_MS });
    res.set('Content-Type', type);
    // Bounded, never `immutable`: a pid is a uint16 and recycles, so this URL
    // can legitimately mean a different picture later on.
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(buf);
  } catch (err) {
    // 504 is the eviction race the allowlist cannot close: a pid can vanish
    // between the poll that published it and this request. Bounded failure.
    const status = err.status ?? 502;
    return res.status(status).json({ error: err.message });
  }
});

// POST /alarm/image/:num/check — ask the device what it is currently holding.
//
// USER-INITIATED ONLY, and that is a hard rule, not a preference. This is a real
// radio round-trip (pac-host issues `push stat` and waits for the reply — no
// cache, every call; measured 4.3 s). services, asked directly: "Airtime on that
// link is the scarcest thing in this project… a background poller would compete
// with real commands for the same windows." NEVER put this on a timer. If a
// cadence is ever wanted, services own the polling and publish an age.
//
// A POST because it is an ACTION that spends airtime, not page data. The result
// reaches the browser the same way everything else does — pushed over the WS in
// the next `alarm_images`.
router.post('/alarm/image/:num/check', async (req, res) => {
  const num = Number(req.params.num);
  if (!Number.isInteger(num)) return res.status(400).json({ error: 'num must be an integer' });
  try {
    const info = await getDeviceImage(numToNodeId(num));
    setDeviceImage(num, info);
    return res.json({ ok: true, pid: info?.pid ?? null });
  } catch (err) {
    return res.status(err.status ?? 502).json({ error: err.message });
  }
});

// POST /alarm/image/:num/:pid/fetch — pull an image the DEVICE holds and we do not.
//
// This is the case /stored cannot answer and the reason this route exists: an
// image captured on the device that has never been transferred. Peter,
// 2026-07-31: "I need to be able to pull an existing image whether or not it has
// been sent before."
//
// Returns 202 IMMEDIATELY and lets the pull run. It must not block the browser:
// services measured 183-239 s for a full transfer. Progress renders through the
// existing /progress polling with the same code path as every other transfer,
// and the bytes appear in /stored when it completes.
//
// Gated on the pid the DEVICE told us it holds — never an arbitrary number, for
// the same reason as the stored allowlist: an unknown valid pid does not 404, it
// hangs (>45 s measured, xsession #59).
router.post('/alarm/image/:num/:pid/fetch', async (req, res) => {
  const num = Number(req.params.num);
  const pid = Number(req.params.pid);
  if (!Number.isInteger(num) || !Number.isInteger(pid)) {
    return res.status(400).json({ error: 'num and pid must be integers' });
  }
  // RE-DOWNLOAD IS ALLOWED. An earlier version refused any pid already in
  // /stored with 409 "already downloaded", which directly contradicted Peter's
  // requirement: "pull an existing image WHETHER OR NOT IT HAS BEEN SENT
  // BEFORE". That guard is gone.
  //
  // What remains is a limit of the device, not a policy of ours: it holds ONE
  // payload and a new capture replaces it, so only that pid can be re-pulled.
  // Every other returns ENOIMG — measured, and visible in services' /history
  // (pid 50108 ENOIMG twice). We refuse those rather than start a transfer we
  // know will fail and bill it to a wake window.
  if (!isDevicePid(num, pid)) {
    return res.status(409).json({
      error: 'the device is no longer holding this image, so it cannot be downloaded again — it holds one at a time. Use Check device to see which.',
    });
  }

  // Fire and forget. services own the START frame, the repair loop and the
  // retry policy; we only ask for the image and watch /progress like everyone else.
  // refresh:true — skip services' store and go to the device. Without it a pid
  // they already hold is served from disk in milliseconds and nothing goes on
  // air, so the button would report a download that never happened.
  getImageBytes(numToNodeId(num), pid, { timeoutMs: PULL_TIMEOUT_MS, refresh: true })
    .then(() => log.info('alarm-image', `device pull complete for ${numToNodeId(num)} pid ${pid}`))
    .catch(e => log.warn('alarm-image', `device pull failed for ${numToNodeId(num)} pid ${pid}: ${e.message}`));

  return res.status(202).json({ started: true, pid });
});

export default router;
