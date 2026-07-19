# Open decisions — alarm transport plugin

Questions raised while building `alarm-transport-module` that need Peter, with
the assumption I proceeded on. **Nothing here blocked work.** If an assumption is
wrong, the fix is listed with it.

Raised 2026-07-19.

---

## D1 — Where does the plugin implementation live? *(assumed, medium cost to reverse)*

`mt-transport/clients/node` is outside this repo, and `CLAUDE.md` forbids
modifying anything outside `node-dash/`. So node-dash cannot own that code, and a
hard `import` would couple two repos.

**Assumed:** node-dash defines the plugin *interface* in `src/transport-plugin.js`
and loads an implementation optionally at runtime. mt-transport is one such
implementation, resolved by path/package at boot. Node-dash never imports it
directly.

This also satisfies your "prefer a plugin, dashboard not dependent on it".

**If wrong:** if you want mt-transport vendored *into* node-dash instead, the
interface stays and only the loader changes — roughly an hour, not a rewrite.

---

## D2 — How is the plugin located? *(assumed, cheap to reverse)*

**Assumed:** env var `MT_TRANSPORT_PATH`, falling back to `node_modules/mt-transport`,
falling back to absent. Absent is a first-class state, not an error — it is the
default for anyone who has only stock Meshtastic nodes.

Env var chosen because it matches how `bridge.js` and the rotator already take
their endpoints (per the `rotator-targets-no-hardcoded-ip` task), so it is the
established convention here rather than a new one.

**If wrong:** one constant in the loader.

---

## D3 — `config set` cannot actually work yet *(blocked upstream, not by me)*

SPEC §2 lists `config set` as "stub — needs raw-portnum send", and §3 explains
why: **mesh-gw has no arbitrary-portnum send path.** Send is text-only.

So the plugin can *validate* a config change and *send it as a text command*
(which is what node-dash's current `node-settings.js` already does), but it
cannot write a real 260 config frame.

**Assumed:** keep the existing text-command + reply-correlation path as the
`configSet` capability. It works today. Do **not** wait for raw-portnum send.

**Your call (SPEC §7.1):** adding a raw-portnum endpoint to mesh-gw is the tidy
fix, but mesh-gw is a live service and modifying it is explicitly out of scope in
both that spec and this repo's CLAUDE.md. I have not touched it.

---

## D4 — Chunk fetch needs a TX channel decision *(genuinely blocked — same as bugs #9)*

A chunk pull is `@<target> chunk pull <first> <count>` — an outbound text
command. Which channel it goes on is undecided, and this is the *same* blocker
already logged as bug backlog #9 for the 260 config editor.

Standing rule, from memory and from your instruction: **never PRIMARY.** Private
is permitted. `channel` defaults to 0 so it must always be set explicitly.

**Assumed for now:** chunk pull uses the same channel resolution as
`node-settings.js:resolveCommandChannel()`, which already refuses channel 0 by
construction. That keeps one rule, one place.

**Needs you:** confirm the Private channel index is the intended TX channel for
chunk pulls, or name a different one. Until confirmed I will not run a live
fetch against a real device — the code path will be built and unit-tested
against captured frames only.

**UPDATE 2026-07-19 14:42 — strong evidence for channel 2, still awaiting your
word before any live transmit.**

mt-transport answered (Q&A Q7) with empirical evidence, not inference:
- the gateway's channel list gives index **2 = name `"Private"`**
- firmware `secrets.h` sets `MESH_CHANNEL_NAME = "Private"`
- DEV1 answered commands on channel 2 repeatedly today (`@336b status`,
  `@336b ping`, renames) — decoded round-trip, not assumption

They have also made it structurally impossible for their client to reach PRIMARY:
`new Client({})` throws on an unset channel, `{channel: 0}` throws, and
`_sendText()` re-checks so mutating `.channel` afterwards cannot get there. I have
added the same guard caller-side in `transport-adapter.js` — both sides check,
because transmitting on the public mesh cannot be undone.

I am **still not transmitting** until you confirm. The evidence is good and I
expect you'll say 2, but the gate I set was your word, and the cost of being wrong
here is flooding the public mesh — which you were unambiguous about.

---

## D5 — Image retention is unowned *(SPEC §7.2 says so too)*

`store.js` writes JPEGs; nothing decides when to delete them. Its `prune()`
currently throws `retention policy not implemented`. The device's own retention
is separate and also unbuilt.

**Assumed:** node-dash does not implement retention in this task. Images land in
a configured directory and stay. I will not silently invent a deletion policy
for image data.

**Needs you:** a retention rule (count? age? disk budget?), or an explicit
"keep everything".

---

## D8 — The module gives node-dash exactly ONE thing, and it is not what the brief assumed

The most important finding of the task, and it changes its shape. Recording it
plainly because it is easy to lose in the detail.

The brief was "move the non-standard stuff behind a module". Having gone through
each surface with mt-transport, **almost none of it should move**:

| surface | verdict | why |
|---|---|---|
| `configSet` | **stays in node-dash** | our text-command path with reply-id confirmation already works. mt-transport's own words: "strictly better than what SPEC §2 implied, I have no intention of superseding it" |
| `tilt256` | **stays in node-dash** | the module does not expose tilt at all. Nothing to move |
| `debug260` | **stays in node-dash** | see D7 — 8 lines of `JSON.parse` on a sync ingestion path. Moving it costs an async conversion of the ingest choke point and buys tidiness |
| `pullQueue` | **nothing to move** | undesigned on both sides; the device half does not exist |
| `chunkFetch` | **genuinely needs the module** | node-dash cannot do this alone. Wire codec, reassembly, CRC, queue discipline — all real, all tested against the C++ encoder |

So the module's value to node-dash is **chunked transfer** — JPEG-over-mesh — plus
whatever `pullQueue` becomes later. That is a real and substantial thing, and it is
the part neither of us could fake. But it is one capability, not five.

This is not a disappointing result. The plugin seam is still right — it is what
lets `chunkFetch` arrive without node-dash depending on it, and what keeps the
door open for `pullQueue`. It just means "move everything behind the module" was
the wrong mental model, and "add one capability node-dash cannot do itself" is the
right one.

**Consequence for the task:** step 3 ("delete the inline duplicates") is very
nearly empty. There are no duplicates to delete. What remains is building the
node-dash side of `chunkFetch`, which is blocked on Q9 and on mt-transport's own
end-to-end failure (0/32 chunks, still being debugged).

---

## D7 — The plugin is async; ingestion is sync — DECIDED 2026-07-19, option 3

Found by trying it, 2026-07-19. I wired `debug260` into `persist.js` and then
reverted it, because the change was bigger than it looked.

Capability methods are **uniformly async** — correct for `chunkFetch`, which does
radio I/O over minutes. But `persist.js:handlePrivateAppState()` sits on the
synchronous ingestion path: `handleEvent()` is `→ void` by contract
(`docs/modules/persist.md`). Awaiting a capability there makes the whole persist
chain async, which changes **ingestion ordering**, not just syntax. `node_app_state`
is a latest-only upsert, so two 260 frames in one tick could land out of order.

That is not a refactor to make unattended on a live service, so I stopped.

**Three ways out, my preference first:**

1. **Sync escape hatch for pure decoders.** `parse260` does no I/O — it is
   `Buffer → object`. Let the adapter expose pure decoders synchronously and keep
   async only for capabilities that actually transmit. Smallest change, keeps
   ingestion sync, and honest about the difference between decoding and radio.
2. **Make the persist path async.** Cleanest conceptually, but it touches the
   ingest choke point and needs the ordering thought through properly.
3. **Leave 260 decoding in node-dash.** The parse is eight lines. The gain from
   moving it is tidiness, not capability — unlike `chunkFetch`, which node-dash
   genuinely cannot do alone.

**Worth knowing before you pick:** the plugin's parser is *better* than ours. A
260 frame is built with `snprintf` against a fixed device buffer, so truncation is
real; `parse260` returns `{type:'unparseable'}` where our `JSON.parse` throws and
we drop the frame. Today both end up dropped — our guard requires a real `type` —
so adopting it changes nothing until we decide we *want* truncated frames
surfaced rather than silently discarded. That is itself a question: right now a
truncated alarm payload is indistinguishable from another user's traffic on an
additive portnum.

**DECIDED — option 3.** `persist.js` keeps its inline parse permanently, marked
with a pointer to this entry. This is my call, not one to defer: it is node-dash's
ingestion path, and mt-transport has no visibility into it.

Reasoning: the benefit of moving eight lines of `JSON.parse` is tidiness. The cost
is converting the synchronous ingest choke point to async, which changes ordering
on a latest-only upsert. Tidiness does not buy an ordering risk. Option 1 (a sync
escape hatch in the adapter) is achievable and I own that file, but it would put
two shapes in the interface — sync decoders alongside async capabilities — to
save eight lines. Not worth the complexity either.

Reopen this only if 260 grows something node-dash genuinely cannot parse, e.g.
the paginated config-schema surface in SPEC §2, which is still a firmware-side
stub. That would be a real capability rather than a re-homed `JSON.parse`.

**Still open, and genuinely interesting:** `parse260` returns
`{type:'unparseable'}` on truncation where ours throws and drops. Today both
outcomes are identical, because our guard requires a real `type`. But it means a
**truncated alarm payload is indistinguishable from another user's traffic on an
additive portnum** — we discard both silently. That is a gap in node-dash's
design, not a consequence of this decision, and it survives option 3. Logged for
Peter; not fixing it in-flight.

---

## D6 — ~~SPEC §5's verification claim is not currently true~~ — RESOLVED 2026-07-19 14:40

**Closed.** The mt-transport session read this, wrote the missing test, and
corrected the spec — within about ten minutes of the Q&A channel opening.

`test/cross-cpp.js` + `npm run test:cross` now genuinely shell out to the compiled
C++ `dump_frames`, and I verified it here rather than trusting the spec: 33 frames
from the real encoder, byte-identical reassembly, `crc=65fbd5d9`, **13 passed,
0 failed**.

So `chunk.js` is **proven against the device-side encoder**, not merely
implemented. I've withdrawn the assumption below. The only thing still blocking a
live fetch is D4 (TX channel).

The original finding is kept below for the record.

---

### Original finding (superseded)

Not a decision, a correction — flagging because the spec reads as settled.

§5 states the node test suite "parses the exact bytes the C++ `ChunkServer`
emits" with "13 assertions covering manifest decode, full reassembly, gap
detection, duplicate and reordered delivery, corruption detection and stale-pid
rejection."

Measured: the suite runs **8 tests / 17 assertions**, and `dump_frames` /
`ChunkServer` appear nowhere in `clients/node` except that sentence. There is no
test consuming C++-emitted bytes. What *is* real: `chunk.js` reassembly is
implemented (not a stub), and the CRC32 assertion genuinely passes against
`real_ov3660_outdoor.jpg` → `0x65FBD5D9`.

The C++ tooling exists and is compiled (`pio/mylibs/mt-chunk/test/dump_frames`),
so the claimed test is writable — it just has not been written. Note the spec's
relative paths are off: `mylibs` is at `pio/mylibs`, not under
`projects/mt-transport`.

**Assumed:** I treat `chunk.js` as *implemented but not yet proven against the
C++ encoder*, and will not rely on it for a live transfer until that test exists.
Writing that test belongs in the mt-transport repo, which is out of my scope.
