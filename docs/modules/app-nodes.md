---
module: app-nodes
source: public/app-nodes.js
source_hash: 4e30342ea2be80bf3b2d08b1e19681e02d581a169a7e8967a5224a6c2dec72ab
updated: 2026-07-03
---

# Module: app-nodes

## Purpose

Nodes mixin: sorting, filter persistence (backend-owned filtering — the
browser only PUTs config and renders the pushed list), node lookup/label
helpers, hop/signal display helpers.

## Fixed contract: nodeHops (task hops-coherence)

nodeHops(n) returns the LIVE packet hop count (hops_away ?? hops ?? null) —
the exact source the backend max_hops filter uses (node-filter.js). It must
never prefer last_traceroute.route.length: that is a routed-path property,
often longer and stale, and preferring it made node cards show 5-6 hop
badges inside a max_hops<=2 filter. Traceroute path length belongs only in
traceroute contexts (radar route overlay, perf Via column). Consumers:
card hopsBadge, node-info modal, fewest-hops sort — all live-hops semantics.
