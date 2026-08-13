// ── Reach REST ───────────────────────────────────────────────────────────────
//
// TWO SERIES, deliberately separate. Peter, 2026-08-05:
//
//   "the antenna beam / reach arc ... should be based on what has actually been
//    CONTACTED or heard. but another series of plots could also show the
//    potential reach in that direction based on the terrain that we now have."
//
//   achieved   what we have PROVEN — proven direct links and direct receptions
//   potential  what the GROUND allows — the line-of-sight horizon per bearing
//
// They are not the same kind of claim and are never merged. Achieved is
// evidence; potential is geometry. The gap between them is the interesting
// quantity — it is where terrain permits more than we have used.
//
// There is deliberately NO theoretical RF reach here. Peter: "theoretical is
// irrelevant", and the measurement backs him: with the link budget constrained
// by terrain diffraction the model still reaches 343-400 km on EVERY bearing —
// a 1.2x spread against a 36x spread in obstruction, and 8x beyond our furthest
// proven link of 48.4 km. SRTM is bare earth, so the model is missing the
// buildings and tree lines that actually stop 868 MHz over the first kilometre.

import { Router } from 'express';
import { reachBySector, provenLinks, heardDirect } from './reach.js';
import { visibility } from './terrain.js';

const router = Router();

// GET /reach IS GONE. It served live data over HTTP, which is forbidden
// (Peter, 2026-08-13). The radar's three overlays — reach, clusters, terrain —
// now arrive together in one `radar` message on the socket, replayed on
// connect: see radarOverlays() in ws-relay.js.
//
// The achieved/potential split moved with it unchanged. What we have PROVEN
// and what the GROUND ALLOWS remain two different kinds of claim and are still
// never merged.

router.get('/reach/links', (req, res) => {
  try { res.json({ proven: provenLinks(), heard: heardDirect() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
