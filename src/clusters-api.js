// ── Clusters REST ────────────────────────────────────────────────────────────
//
// Read + seed. Full CRUD (rename, move, delete) is a separate task; this is the
// surface the radar needs to draw anything at all.
//
// Everything served here is DERIVED IN NODE. The browser renders hulls, names,
// purity and verdict strings; it computes none of them (BROWSER_CONTRACT).

import { Router } from 'express';
import { clusters, seedClusters, listAnchors, clusterConfig,
         createAnchor, updateAnchor, deleteAnchor } from './clusters.js';

const router = Router();

// Every cluster with membership, hull and stats, plus the loners.
router.get('/clusters', (req, res) => {
  try {
    res.json(clusters({ force: req.query.force === '1' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/clusters/config', (req, res) => res.json(clusterConfig()));

// Raw anchors, without derivation — for a management UI that wants to edit the
// places themselves rather than see what currently falls inside them.
router.get('/clusters/anchors', (req, res) => {
  try { res.json({ anchors: listAnchors() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ADDITIVE AND IDEMPOTENT. Never deletes, never moves an existing anchor, and
// only proposes where no cluster already covers the group — so this is safe to
// call repeatedly and safe to expose as a button.
router.post('/clusters/seed', (req, res) => {
  try { res.json(seedClusters()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CRUD ─────────────────────────────────────────────────────────────────────
//
// The functions existed in clusters.js from the day the module was written and
// were never wired to routes — so you could SEE `cluster-f` and had no way to
// call it "Blackdowns", which is what made the whole feature feel unfinished.
//
// The anchor is the identity: renaming never moves it, and moving it never
// renames it. Membership is always derived, so neither operation touches a node.

router.post('/clusters', (req, res) => {
  const { lat, lon, radius_km, friendly_name } = req.body ?? {};
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon)))
    return res.status(400).json({ error: 'lat and lon are required' });
  try { res.json(createAnchor({ lat, lon, radius_km, friendly_name })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/clusters/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  // ABSENT MEANS UNCHANGED. updateAnchor already honours that per field; the
  // route must not helpfully fill in the gaps. Three config paths in this repo
  // wiped stored values by treating "not supplied" as "set to nothing" (8002efd)
  // and this is not going to be the fourth.
  const patch = {};
  for (const k of ['friendly_name', 'lat', 'lon', 'radius_km'])
    if (k in (req.body ?? {})) patch[k] = req.body[k];
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change' });
  try {
    const out = updateAnchor(id, patch);
    if (!out) return res.status(404).json({ error: 'no such cluster' });
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/clusters/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  try {
    // Deleting an anchor deletes a PLACE, not any nodes. The members simply
    // become loners again on the next derivation.
    res.json({ deleted: deleteAnchor(id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
