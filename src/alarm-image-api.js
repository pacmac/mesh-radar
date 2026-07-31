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
import { getImageBytes, getDeviceImage } from './pac-host.js';
import { isStoredPid, isDevicePid, setDeviceImage } from './alarm-images.js';
import { numToNodeId } from './utils.js';
import { log } from './log.js';

const router = Router();

const FETCH_TIMEOUT_MS = 5000;
// A pull of a pid we do not already hold is a full radio transfer. services
// measured 183-239 s for one; the deployed unit listens ~8 s in every 900, so a
// slow window can push it well past that. Generous, and bounded.
const PULL_TIMEOUT_MS  = 600000;

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
  if (isStoredPid(num, pid)) {
    // Already on disk — nothing to spend airtime on.
    return res.status(409).json({ error: 'already downloaded' });
  }
  if (!isDevicePid(num, pid)) {
    return res.status(404).json({ error: 'the device has not reported holding this image — check the device first' });
  }

  // Fire and forget. services own the START frame, the repair loop and the
  // retry policy; we only ask for the image and watch /progress like everyone else.
  getImageBytes(numToNodeId(num), pid, { timeoutMs: PULL_TIMEOUT_MS })
    .then(() => log.info('alarm-image', `device pull complete for ${numToNodeId(num)} pid ${pid}`))
    .catch(e => log.warn('alarm-image', `device pull failed for ${numToNodeId(num)} pid ${pid}: ${e.message}`));

  return res.status(202).json({ started: true, pid });
});

export default router;
