# Favourites

Backlog #18 (closes the nav-entry half of #7). Peter: *"favourites are always
excluded from ALL filters. and if it is a favourite it gets its own menu in the
left nav panel that links to the node-info page. in the nodes page, a star is
needed disabled by default, enabled yellow when clicked. a field is required in
the database to record fav devices."*

Names `docs/STYLE_GUIDE.md` (§8.6). Companion: `docs/BROWSER_CONTRACT.md`.

## Storage — `nodeinfo.favourite`

`nodeinfo` is the **persistent** node table; `nodes` is ephemeral and is wiped by
`clearNodeCache()`. A favourite must survive that, so the column goes on
`nodeinfo`:

```sql
ALTER TABLE nodeinfo ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0;
```

This deliberately does **not** reuse the old `monitored_nodes` config key, which
was deleted in `9667d30`. That key fused three unrelated concerns — pinned-in-nav,
which-nodes-get-a-page, and which-fields-to-hide. Favourites is only the first.

## Excluded from ALL filters

`passesFilter()` (`node-filter.js`) is the single choke point for every node
filter — max_age, max_hops, named_only, has_pos, hide_mqtt, has_signal,
has_telem, msg_only, roles, node_source. One line covers all of them:

```js
if (node.favourite) return true;   // favourites bypass every filter
```

Placed **after** the own-gateway guard. A gateway radio is excluded structurally
rather than by a filter — it belongs on the Devices page — so favouriting one
must not inject it into the node list.

`favourite` reaches the node object via `enrichFromCache()`, which already
merges persisted `nodeinfo` fields (`hops_away`, `last_traceroute`) onto live
nodes.

## Nav entries — server-supplied

`BROWSER_CONTRACT`: the browser makes zero decisions, and "if a display differs
based on a condition, that condition is evaluated in Node.js". So the sidebar is
**not** allowed to scan the node list for favourites — the server sends the list:

```js
{ type: 'node_list', nodes: [...], favourites: [{ num, node_id, label }] }
```

Each entry links to `/node/<node_id>`, the existing focus-page route.

## Star on the nodes page

Each node card gains a star, top-left, mirroring the existing signal bars
top-right:

- **not a favourite** → outline star, `text-base-content/30`
- **favourite** → filled star, `text-warning` (the guide's amber; §4 forbids raw
  colours, and `warning` is the sanctioned token)
- `@click.stop` so it toggles without opening the summary modal

The click PUTs to the backend; the star re-renders from the **re-broadcast
node_list**, not from local state — same rule that fixed the message feed.

## Files

| File | Change |
|---|---|
| `src/db.js` | `favourite` column (guarded), `setFavourite`, `queryFavourites` |
| `src/node-list.js` | `enrichFromCache` attaches `favourite` |
| `src/node-filter.js` | favourites bypass every filter |
| `src/nodes-api.js` | NEW — `PUT /nodes/:num/favourite`, then re-broadcast |
| `src/index.js` | mount the router |
| `src/ws-relay.js` | `favourites` on the `node_list` event |
| `public/partials/tab-nodes.html` | the star |
| `public/partials/drawer-sidebar.html` | favourite nav entries |
| `public/app-nodes.js` | `toggleFavourite()` — PUT only, no local mutation |
| `public/app-ws.js` | keep `favourites` from `node_list` |
| `docs/modules/*` | updated + rehashed |

## Invariants

- A favourite is visible regardless of every filter setting.
- Own gateway radios stay out of the node list even if favourited.
- The star's state comes from the server, never from local optimism.
- Nav entries are server-supplied; the browser filters nothing.
- Favourites survive `clearNodeCache()` — they live on `nodeinfo`.

## Done when

- Starring a node turns it yellow and it appears in the left nav
- A favourite stays visible with filters that would otherwise hide it
- The star survives a reload and a node-cache clear
- 1440×900, both themes, zero console errors
- `check_specs.py` green
