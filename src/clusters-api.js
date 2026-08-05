// ── Clusters REST ────────────────────────────────────────────────────────────
//
// Read + seed. Full CRUD (rename, move, delete) is a separate task; this is the
// surface the radar needs to draw anything at all.
//
// Everything served here is DERIVED IN NODE. The browser renders hulls, names,
// purity and verdict strings; it computes none of them (BROWSER_CONTRACT).

import { Router } from 'express';
import { clusters, seedClusters, listAnchors, clusterConfig } from './clusters.js';

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

export default router;
