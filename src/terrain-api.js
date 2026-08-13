// ── Terrain REST ─────────────────────────────────────────────────────────────
//
// Read the cached polar relief grid, and trigger the one-time sample.
//
// The sample is a POST and never happens on boot: it calls a third-party
// elevation service, and a restart must not decide by itself to go and do that.

import { Router } from 'express';
import { grid, sample, isSampling, isStale, meta, terrainConfig, visibility } from './terrain.js';

const router = Router();

// The VISIBILITY mask is what the radar draws — see terrain.js. The raw relief
// grid stays available for anything that wants the elevations themselves.
// GET /terrain/visibility IS GONE — it arrives in the `radar` message now.
//
// It was the most defensible of the three to leave: the mask changes only when
// the home position or the terrain grid does. Moved anyway, because
// BROWSER_CONTRACT names page data as WS-only without carving out slow-moving
// data, and one endpoint keeping a second transport alive is how a rule erodes.

router.get('/terrain', (req, res) => {
  try { res.json(grid()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/terrain/status', (req, res) => {
  try {
    res.json({ sampling: isSampling(), stale: isStale(), meta: meta(), config: terrainConfig() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Fire and report progress via the log; the response returns when done.
// Long (~90 s), so the caller should expect to wait or poll /terrain/status.
router.post('/terrain/sample', async (req, res) => {
  if (isSampling()) return res.status(409).json({ error: 'already sampling' });
  try {
    const r = await sample({
      onProgress: ({ done, total }) => {
        if (done % 1000 === 0 || done === total) console.log(`[terrain] ${done}/${total} points`);
      },
    });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
