---
module: chunk-api
source: src/chunk-api.js
source_hash: 5f0da35d9fe50dd1df1ce1b846e79bc3b6f176c7d9b480604b2d3e2e2fc8f54c
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

## `batch` removed from `chunk_progress`; the no-poll rule (task `push-agreed-cleanup`)

**`batch` is gone.** Under push there is no client batch size — the device streams at its
own pace — so mt-transport spec'd `onProgress` as `{received, count, elapsedMs}`
(their `specs/chunk-push.md` §4b, which cites this file's line for exactly this reason).
Keeping the destructure would have emitted `batch: undefined` on every event once push
lands. Removed from both the destructure and the broadcast.

## HARD CONSTRAINT — never poll `push stat` while `upst = 2`

Recorded here because it is counter-intuitive and a future session WILL be tempted.
Control traffic is TEXT at hop 3 and gets rebroadcast; chunk frames are hop 0 and are
not. So polling the device *during* a transfer measurably SLOWS the transfer being
watched. This inverts the normal instinct for a progress UI (poll harder while busy).

- Discovery polling (`push stat`, "is an image waiting") only at `upst` 0 / 1 / 3.
- During a transfer, progress comes ENTIRELY from `onProgress`. Add no polling.
- `upst`: 0 idle · 1 pending · 2 sending · 3 awaiting COMPLETE.

Source: mt-transport, measured on the bench 2026-07-20.

## BUG: the target was addressed with a full node id, so the device ignored it

Peter pressed Start and the page sat on "waiting for manifest" — because the device never
answered, and it never answered because it was never addressed in a form it parses.

`const target = numToNodeId(num)` produced `!8cee336b`. The `Client` prefixes `@` to
whatever target it is given, so the frame on air read `@!8cee336b chunk info 1`. The
device's command grammar is `@<4-hex-suffix> <verb>` — the same grammar `command-api.js`
already uses via `hexSuffix()`, and the same one `src/message-type.js` classifies on
(`/^@[0-9a-f]{4}\s+\S/i`).

Evidence from the message log, which is unambiguous:

| form | count | answered |
|---|---|---|
| `@336b chunk info …` | 155 | yes (all prior working traffic) |
| `@!8cee336b chunk info 1` | 18 | **never once** |
| `@!00000001 chunk info …` | 12 | never (nonexistent node, my accidental fetch) |

Fixed: `const target = hexSuffix(num)`, matching the command route. The full-node-id
helper is removed rather than left unused.

**This was silent by construction.** The route reports 202, the transfer "starts", frames
go out, and the device simply never replies — so it looks identical to a weak link. There
is no error to log because nothing failed; the messages were addressed to nobody. Worth
remembering: a mis-addressed command is indistinguishable from a lost one, and only
comparing against known-good traffic separates them.

**Still unverified even with correct addressing:** the bench is on push firmware
`260720-11`. Whether it still serves the PULL verb `chunk info` is unknown — the 155
working examples predate that flash. So a retry may still fail, for a different and
legitimate reason, and that will need mt-transport's `push` entry point rather than
another fix here.

## PULL PURGED — push is the only bulk-transfer path (2026-07-20)

Peter: *"purge it."* `chunkFetch` / `Client.fetch` is **removed entirely** — from the
adapter, from the `CAPABILITIES` allow-list, from the route, and from the tests. It is not
a fallback and must not be reintroduced as one.

**Why it went rather than being kept for compatibility.** Pull's follow-up requests were
the failure: a real transfer here stalled at exactly 16/32 because the device never
received the pull for `first=16` (`stalled at 16/32 after 12 empty windows (no serve, no
busy)`, evidence preserved under `data/payload-evidence/`). Keeping a path that is known
to strand transfers, as a silent fallback, would mean the worst case is chosen precisely
when the good path is unavailable.

**A build without `Client.push` now FAILS LOUDLY** (`no Client.push — pull is no longer
supported`) instead of quietly degrading. There is a test for exactly that.

**The field unit** `!987ab80f` runs `mt-chunk` (pull) and cannot be reflashed — but it is
off-limits to node-dash entirely, so we would never have driven a transfer to it. The
pull path was dead by policy before it was dead by protocol.

Live capability line after the purge:

    capabilities: debug260, chunkPush

Also gone with it: `batch`, and every `MSG_BUSY (0x06)` reference describing pacing as
current — under push the device paces itself and that frame does not exist.

## Publish before START, and surface a refusal (task `push-publish-first`, 2026-07-20)

**The bug:** a fresh Start returned `{"start":1,"ok":0,"cnt":0}` five times and the UI
showed a blank progress bar. The device was refusing deliberately — its `bs` (badStarts)
counter reached 5 — because the pid was not published.

**Why the device was empty.** The JPEG lives permanently in flash (no capture step), but
the UPLOAD must be published into a pending state before a START can be served. COMPLETE
(`push done`) clears that pending state — correctly: the receiver is the only party that
can assert a transfer is finished. The device then republishes only at boot or on
`push pub`. So after ANY successful transfer, the next START is refused until republished.
mt-transport: *"This is going to happen in production and it is the thing to fix, not the
symptom."*

**Fix 1 — publish first.** The route sends `@<suffix> push pub`, waits 4 s, then lets
mt-transport's client send START. One small text frame; it re-publishes from flash and
leaves the device pending (`up:1, upst:1`). Staging only — START remains mt-transport's to
send and node-dash sends nothing else (two STARTs restart the pass).

**Fix 2 — a refusal is no longer silent.** `notePushReply()` inspects device replies
already arriving on the command channel and converts `{"start":N,"ok":0}` into a
`chunk_error` carrying the device's own `cnt`. Read-only: it transmits nothing.

**Why this could not be diagnosed from the dashboard.** `up`/`upst` are NOT in the
device's periodic status frame (mt-transport, pending), and polling `push stat` during a
transfer is forbidden because control is TEXT at hop 3 and gets rebroadcast. So a device
with nothing published was indistinguishable from a dead radio. Until the status frame
carries them: treat a refused START as "nothing published", never as a device fault.

## Automatic publish REMOVED — conditional staging belongs in `Client.push()` (2026-07-20)

The publish-before-START added earlier is **withdrawn**, after mt-transport pushed back with
two objections that both hold:

- **It discards a resume.** At `upst=3` the device is holding a COMPLETED pass awaiting
  COMPLETE. Publishing throws that away and re-sends 32 chunks at ~2 s of airtime each,
  when a query plus one repair round would have finished it.
- **It is a correctness bug at `upst=2`.** Publishing mid-transfer resets the cursor UNDER
  a running stream — and that stream may be mt-transport's, which our one-in-flight guard
  cannot see (it guards concurrent callers inside THIS server, not the device).

Deciding correctly needs `upst`, which means asking the device — and `Client.push()`
already calls `push stat` for its adoption decision. So staging belongs there: **one place
that decides, rather than two that are each correct alone and combine badly.**
mt-transport is implementing it.

What remains here instead:
- a refused START is surfaced, not swallowed (`notePushReply`);
- the viewer offers an explicit **Publish** control, so an operator can stage deliberately
  after a completed transfer — which is the case that actually needs it.

## Deadline raised 240 s -> 600 s (2026-07-20)

A real transfer died at **31/32** — one chunk short — hitting our deadline. The wall was
the cause, not the radio:

    mt-transport's verified CLEAN run   222 s
    our DEADLINE_MS                     240 s     <- 18 s of headroom
    their Client's own default          600 s

With ~17% loss the EXPECTED operating condition, a transfer needing a repair round cannot
finish inside 240 s. A clean run barely fit; a lossy one was guaranteed to fail. We had
imposed a wall shorter than the work takes and then read the result as a device problem.

Now 600 s, matching their client's default rather than second-guessing it. The tail is
~90 s of the 222 s today (the receiver waits out an idle timer instead of acting on the
`{cursor, done}` the device already sends); when mt-transport lands that fix, runs get
shorter — so 600 s does not need revisiting downward, it simply stops truncating.

**Not a licence to hide stalls:** the deadline is the outer bound, not the progress
indicator. A genuinely dead transfer still shows its last `received/count` and, once
mt-transport ships fail-fast on a refused START, errors early rather than waiting this out.

**Observed while fixing this — the stored layout changed under push** and cost us nothing:
files now appear as `pid-<N>.jpg.part` at the payload root, where pull wrote
`<node>/pid<N>.part` with a `.json` sidecar. `listStoredPayloads()` walks the tree and
keys off the `.part` suffix rather than a documented path, so it kept working; the sidecar
being absent degrades to a caption without a percentage, which is the designed fallback.
That is the layout-agnostic decision paying for itself.

## The completed image was DISCARDED — `push()` does not save (2026-07-20)

A transfer completed successfully — `fetch ok node 2364420971 pid 1 (7156 B)`, the exact
size of the known-good image — and the viewer reported **"stored — location unknown"**,
because `data/payloads` was empty. The image arrived intact and this route threw it away.

**Cause: an assumption that silently stopped holding at the protocol switch.** Under PULL,
`Client.fetch()` stored the image itself (`PayloadStore.save`), so this route was written
to merely LOCATE the file afterwards. Under PUSH, `Client.push()` **resolves with verified
bytes but does not write them** — only `fetchAndSave()` calls `store.save()`. The route
read `r.value.length` for the log line and dropped the buffer.

Nothing errored. The transfer genuinely succeeded, the bytes were genuinely verified, and
the only trace was a warning about a file that was never going to exist.

**Fix:** write `r.value` to `<PAYLOAD_DIR>/<target>/pid-<pid>.jpg` before the terminal
broadcast, so the listing that follows includes it. Guarded on `Buffer.isBuffer` and a
non-zero length — if the client ever starts saving again, the newest-file resolution still
finds whichever file exists, since it was always layout-agnostic.

**Lesson worth keeping:** "the other side stores it" was true when written and untrue three
commits later, and nothing in either codebase failed when it changed. A cross-repo
assumption needs re-checking at every protocol change, not just at the seam where it was
first agreed.

## `chunk_images` re-announced when a transfer starts

Clearing an abandoned partial was invisible to browsers: `chunk_images` was only pushed on
connect and after a terminal event, so a page kept rendering the deleted partial —
"abandoned 18 min ago" — while a fresh transfer was already running. The route now
broadcasts the listing immediately after the clear.
