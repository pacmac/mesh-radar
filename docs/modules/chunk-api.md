---
module: chunk-api
source: src/chunk-api.js
source_hash: 38f0874699040ce2e052d7e2828232b5668f92b5ad5dfda7c1939cbf680995c0
updated: 2026-07-20
---

# Module: chunk-api

## Purpose

The browser-facing route that triggers a chunked payload fetch (a JPEG etc.) off a
mesh node via the optional mt-transport plugin, and relays its progress to the
dashboard over the WebSocket. It is the *trigger + progress* half of the
chunk-fetch feature; the mt-transport `Client` does the actual mesh work and
**stores the image itself** (`PayloadStore` → `<payloadDir>/<node>/<when>_pidN.jpg`),
so this module writes no files.

Does **not**: decode chunk frames, pace the transfer (the device owns pacing via
`MSG_BUSY`), choose a channel *number* (it resolves the channel by NAME), or store
the payload (the `Client` does).

## Route

```
POST /nodes/:num/chunk-fetch     body { pid }
```

- **Browser sends only `num` + `pid`.** It never names a gateway or a channel
  index — those are server decisions (BROWSER_CONTRACT). Responds **202** and runs
  the transfer asynchronously (a 7 KB image is ~3 min); all further status is
  pushed over the WS, not polled.
- **Gateway** = `resolvePrimaryNodeId()` (the primary TX radio).
- **Channel** = `resolveCommandChannel(getDeviceChannelsByNodeId(gateway))` — the
  existing name-based resolver: finds the channel **named "Private"** on that
  gateway and returns its index, refusing index 0 (primary) and a missing Private
  channel. **Never PRIMARY by construction** — the same resolver align + node
  settings already use (reused, not duplicated). This is why a per-gateway index
  (Private = 2 on OMNI, 1 on YAGI) is never hardcoded.
- **host** = `localhost:${PORT}` — the `Client` loopbacks through node-dash's own
  `/:gw/messages` + `/events` routes (transport-adapter.md).
- **deadlineMs** = 240000 — the hard wall (mt-transport's suggested value); the
  fetch rejects cleanly at it.
- **payloadDir** = `data/payloads` (absolute) — passed to `chunkFetch` so node-dash
  owns where images land (not the `Client`'s cwd-relative `./payloads` default).

### Responses

| Condition | Status |
|---|---|
| accepted, transfer started | `202 {ok, state:'started', num, pid}` |
| bad `num`/`pid` | `400` |
| plugin has no `chunkFetch` (stock box) | `503` |
| no gateway radio available | `503` |
| no "Private" channel resolvable | `409` (`ch.error`) |
| a fetch already in flight | `409` |

## One-in-flight

A module-scope `_inFlight = { num, pid } | null` allows **exactly one** transfer at
a time; a second request gets `409`. The mesh channel is shared with the alarm's
own traffic and every node — queuing several is forbidden (task requirement, from
mt-transport's measured airtime).

## WS progress (via `ws-relay.broadcastChunkProgress`)

The route's `onProgress` and terminal states push these events to every dashboard
client (the browser renders a progress bar + result; it decides nothing):

- `{type:'chunk_progress', num, pid, received, count, batch, elapsedMs, state}`
  — `state` `'started'` then `'running'`, fired per accepted window by the client.
- `{type:'chunk_done', num, pid, bytes, elapsedMs}` — success.
- `{type:'chunk_error', num, pid, error}` — failure or deadline.

## Degradation

If the transport plugin is absent (stock Meshtastic box), `transport().can('chunkFetch')`
is false → `503`. No route error crashes; the gallery still shows already-stored
images (they are files on disk, independent of the plugin).

## Cancel — not yet

A true mid-flight cancel needs an abort signal on `Client.fetch`, which is **not in
mt-transport's current API** (only `onProgress` + `deadlineMs`). So there is no
cancel route yet; the deadline is the only hard stop. Tracked as a QA item for
mt-transport. Do not fake a cancel that leaves the transmission running on-air.

## Dependencies

- `transport-plugin.js` (`transport()`), `device-config.js` (`resolvePrimaryNodeId`),
  `node-settings.js` (`resolveCommandChannel`), `ws-relay.js`
  (`getDeviceChannelsByNodeId`, `broadcastChunkProgress`), `log.js`.

## Exports

```js
export default router;                 // POST /nodes/:num/chunk-fetch
export const PAYLOAD_DIR;               // absolute; index.js static-serves it at /chunk-images
```

## Invariants

- **Never a channel number from the browser.** The channel is resolved by name,
  server-side, every time.
- **Never PRIMARY** — `resolveCommandChannel` refuses index 0; the adapter's
  `assertChannel` refuses 0/unset again downstream.
- **One transfer in flight**, ever.
- **Writes no files** — the `Client`'s `PayloadStore` owns storage.
- Responds 202 then works async; the browser learns the outcome over the WS only.

## Test notes

- No plugin → `503`; bad body → `400`; second concurrent call → `409`.
- With the plugin + a resolvable Private channel: `202`, then a `chunk_progress`
  `started` on the WS. (A real transfer is gated on a coordinated DEV1 window.)
- Channel resolves by name to Private's index for the chosen gateway (2 on OMNI),
  never 0.

## `chunk_done.url` — the server owns the image location (task `chunk-done-image-url`)

`chunk_done` previously carried `{num, pid, bytes, elapsedMs}` — no path. A viewer was
therefore told an image existed but not where, and both ways it could bridge that are
BROWSER_CONTRACT violations: deriving the filename in the browser is the browser deciding
state, and `GET`ing a directory listing breaks the absolute transport rule (all page data
over the WS). So the server resolves it and pushes it.

`chunk_done` gains two fields:

| field | value |
|---|---|
| `url` | `/chunk-images/<relative path>`, each segment `encodeURIComponent`-escaped — or `null` |
| `file` | the resolved basename, for logs/captions — or `null` |

An `<img src>` pointing at a server-supplied URL is an ASSET fetch (same class as
`app.js`), not page data, so it does not breach the transport rule. What matters is that
the URL is *computed server-side and pushed*, never assembled by the browser.

**Resolution is LAYOUT-AGNOSTIC and this is deliberate.** `chunkFetch` returns
`{ok, state, value: buf}` — the buffer only, no path (`transport-adapter.js:130`) — and
`PayloadStore` names the file itself. mt-transport documents the layout as
`<payloadDir>/<node>/<when>_pid<N>.jpg`, but **that has never been observed here**
(`data/payloads` is empty; no fetch has completed on this host). Constructing that
filename would be building on an unverified claim. Instead `_newestPayloadSince(startedAt)`
walks `PAYLOAD_DIR` and returns the newest regular file with `mtimeMs >= startedAt - 2000`
(2 s slack for clock/filesystem granularity). If the layout changes, this keeps working.

**Degradation is explicit, never a guess.** If no file matches, `url` and `file` are
`null` and a warning is logged. The viewer then shows a server-stated "stored, location
unknown" — the contract requires an unknown indicator, not a guessed path.

Nothing else changes: this module still writes no files, and the `Client` still owns
storage.

### Files changed

`src/chunk-api.js` only:
1. `import fs from 'fs'` alongside the existing `path` import.
2. New helper `_newestPayloadSince(sinceMs)` — recursive walk of `PAYLOAD_DIR`, newest
   qualifying file, `null` on none/unreadable.
3. In the success path, resolve the file and include `url` + `file` in the `chunk_done`
   broadcast; log the resolved basename, and warn when unresolved.

NOT changed: `transport-adapter.js` (the adapter stays a thin wrapper — adding path
plumbing there would push node-dash into the Client's storage contract);
`ws-relay.js` (`_broadcastChunkProgress` is a verbatim passthrough, so the new fields
reach the browser with no relay change); `index.js` (`/chunk-images` already serves
`PAYLOAD_DIR`).

### Future: `partUrl`

When mt-transport exposes the contiguous prefix (channel item `[partial-render]`), the
same resolution adds `partUrl` to `chunk_progress` for progressive rendering. Out of scope
here — no partial file exists to point at yet.

## Out of scope

- Listing/serving the gallery — `node-status.js` `image_grid` section (later pass)
  + the `/chunk-images` static mount (index.js).
- The transfer/codec/pacing — mt-transport's `Client` (another repo).
- The viewer page itself — Domain 2, separate task (`public/push.html`).
