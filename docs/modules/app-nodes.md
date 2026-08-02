---
module: app-nodes
source: public/app-nodes.js
source_hash: 4c69759d4dfc3129e361c8472ed08605afffd651d637fb8cbbd474c2e215a955
updated: 2026-07-08
---

# Module: app-nodes

## Purpose

Nodes mixin: sorting, filter persistence (backend-owned filtering — the
browser only PUTs config and renders the pushed list), node lookup/label
helpers, hop/signal display helpers.

## Contract: nodeHops — pure accessor of backend hops_display (task radar-hops-verified-vs-reported)

`nodeHops(n)` returns `n.hops_display` — a value the **backend** decides
(`ws-relay.enrichEvent`): traceroute-VERIFIED relay count preferred over the
REPORTED live packet hops. The UI does NOT choose the source
(BROWSER_CONTRACT — presentation layer, nothing else):

```js
nodeHops(n)           { return n?.hops_display ?? null; }   // backend-decided
nodeHopsIsVerified(n) { return n?.hops_verified != null; }  // dot shown?
nodeHopsFresh(n)      { return !!n?.hops_fresh; }           // green (fresh) vs amber (stale)
```

`nodeHopsFresh(n)` reflects the backend `hops_fresh` (traceroute within the
auto-tracer staleness window) — the badge dot is green when fresh, amber when
stale. The age/threshold decision is the backend's; the UI only reads the flag.

`nodeHopsIsVerified(n)` reports whether that value came from a traceroute
(`n.hops_verified`), used only to style the badge (verified = green ring/border).

This SUPERSEDES the earlier `hops-coherence` contract (which forced nodeHops to
the live packet count and forbade traceroute length). With reliable traceroute
data we prefer it — "we have traceroute data, we should use it". Consumers
(card `hopsBadge`, node-info modal, radar badge, fewest-hops sort) all read the
same backend-decided value. NOTE: the backend `max_hops` filter still keys off
reported live hops (`node-filter.js`) — a deliberate split (proximity filter vs
displayed distance).

## `toggleObsTarget`

Mirrors `toggleFavourite` — a different flag, never the same one. No optimistic
mutation: the icon re-renders from the re-broadcast `node_list`, so what you see
is always what the server holds. See `docs/DISCOVERY_TARGETING.md`.

