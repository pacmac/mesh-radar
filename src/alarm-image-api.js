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
import { getImageBytes } from './pac-host.js';
import { isStoredPid } from './alarm-images.js';
import { numToNodeId } from './utils.js';

const router = Router();

const FETCH_TIMEOUT_MS = 5000;

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

export default router;
