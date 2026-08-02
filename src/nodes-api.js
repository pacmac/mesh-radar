// Node actions the browser can trigger. Currently: favourites.
//
// A toggle is an ACTION, so POST/PUT is correct — BROWSER_CONTRACT's transport
// rule restricts GET to form flows, not writes. The response is not the source
// of truth: after the write the node list is re-broadcast, and the browser
// re-renders from that. Same rule that fixed the message feed — no optimistic
// local state.
import { Router } from 'express';
import { setNodeFavourite, setObsTarget } from './db.js';
import { nodeList } from './node-list.js';

const router = Router();

router.put('/nodes/:num/favourite', (req, res) => {
  const num = Number(req.params.num);
  if (!Number.isFinite(num) || num <= 0) {
    return res.status(400).json({ error: 'invalid node num' });
  }
  const value = req.body?.favourite;
  if (typeof value !== 'boolean') {
    return res.status(400).json({ error: 'favourite must be a boolean' });
  }

  const changed = setNodeFavourite(num, value);
  if (!changed) {
    // No nodeinfo row yet — the node has never sent identity, so there is
    // nothing persistent to attach the flag to. Say so rather than silently
    // succeeding.
    return res.status(404).json({ error: 'node not known yet (no nodeinfo row)' });
  }

  // Cached node objects were enriched when the node was last HEARD, so the new
  // flag must be synced onto the cache before re-filtering — otherwise the
  // bypass reads a stale `favourite` and the node stays hidden.
  nodeList.syncFavourites();
  res.json({ num, favourite: value });
});

/** Mark a node as a DISCOVERY TARGET. A different flag from `favourite`, and
 *  deliberately so: favourite pins a node to the sidebar, this one spends
 *  airtime pursuing it. See docs/DISCOVERY_TARGETING.md.
 *
 *  Same shape as the favourite route above, including the 404 for a node with
 *  no nodeinfo row and the cache sync afterwards. */
router.put('/nodes/:num/obs_target', (req, res) => {
  const num = Number(req.params.num);
  if (!Number.isFinite(num) || num <= 0) {
    return res.status(400).json({ error: 'invalid node num' });
  }
  const value = req.body?.obs_target;
  if (typeof value !== 'boolean') {
    return res.status(400).json({ error: 'obs_target must be a boolean' });
  }

  const changed = setObsTarget(num, value);
  if (!changed) {
    return res.status(404).json({ error: 'node not known yet (no nodeinfo row)' });
  }

  nodeList.syncObsTargets();
  res.json({ num, obs_target: value });
});

export default router;
