# Node settings — save, validate, confirm by reply

Backlog #14. Peter: *"a SSOT function that saves and validates settings based on
whether the request message gets a reply"*.

Names `docs/STYLE_GUIDE.md` (§8.6). Contract: `docs/mt-transport/API.md` +
`docs/mt-transport/config-schema.json`.

## Everything needed already exists — verified, not assumed

| Requirement | Evidence |
|---|---|
| What is settable, with ranges | `config-schema.json` — `cmd`, `type`, `min`, `max`, `readonly` |
| Command grammar | API.md §3: `@<target> <verb> [args]`; a bare `@verb` is silently ignored |
| Transport | `POST /{node_id}/messages` (text) — the gateway's only write endpoint |
| Correlation | replies carry `reply_id` = the command's packet id (API.md §3) |
| Acknowledgement | `{"type":"interval","secs":300,"was":60,"ok":true}` — observed live |
| Rejection | `{"type":"err","msg":…}` |
| Truth after the change | the device re-broadcasts `type:config` on 260 — observed live at 13:52:20 |

Schema note: `cmd` no longer carries `@` (it is `interval`, `alarm ot`), matching
the addressed grammar. `txp` and `det.n` are `readonly`.

## The SSOT rule

**We never write the setting into our own state.** A successful reply means the
command was *accepted*; the value shown on the page continues to come from the
device's own `type:config` broadcast, cached in `node_app_state`. If the device
disagrees with what we asked for, the device wins and the UI shows the device.

That is the whole point: one source of truth, and it is the radio.

## `saveNodeSetting({ num, path, value })`

1. **Resolve** `path` in `config-schema.json`. Unknown → error. `readonly` → error.
2. **Validate** against `type`/`min`/`max` before transmitting. An out-of-range
   value never reaches the air. The device re-validates and remains authoritative.
3. **Build** the command: `@<shortName> <cmd> <arg>`, target from the node's
   `short_name`. Booleans use the schema's `on`/`off` words.
4. **Resolve the channel by NAME** — see the safety section. Never index 0.
5. **Send** via `POST /{node_id}/messages`; the response gives `id` (packet id).
6. **Register** a pending op keyed by that packet id.
7. **Await** a reply whose `reply_id` matches, or time out (30 s — a sleeping
   node may simply not answer, and silence must not read as success).
8. **Resolve**: `ok === true` → success; `type === 'err'` → failure with `msg`;
   timeout → failure, explicitly "no reply", never assumed applied.

Returns `{ ok, state, sent, reply, error }` where `state` is one of
`applied | rejected | no_reply | invalid`.

## Channel safety — a hard invariant

Peter, 2026-07-18: *"you can send on PRIVATE but NEVER on PRIMARY"*.

- The channel is resolved from the **sending radio's own channel list, by name**
  (`Private`), never hardcoded and never inferred from historical traffic —
  firmware generations have changed and old logs do not describe current
  behaviour.
- Config key `command_channel` overrides the lookup when set.
- **If the resolved channel is index 0, or no channel named `Private` exists,
  the send is REFUSED** with `state: 'invalid'`. Refusing is correct; guessing
  is not.

## Reply correlation

Replies are `TEXT_MESSAGE_APP` packets. `bridge-events.js` already dispatches
after persistence, so it calls `nodeSettings.handleReply(...)` there — the same
placement, and for the same ordering reason, as the message-history rebroadcast.

Pending ops live in a module-level `Map` keyed by packet id, each with a timer.
Nothing is stored in the database: an in-flight command is transient, and a
restart legitimately abandons it.

## Files

| File | Change |
|---|---|
| `src/node-settings.js` | NEW — schema lookup, validation, command build, send, pending-op registry, reply correlation |
| `src/bridge-events.js` | route replies to `handleReply` |
| `docs/modules/node-settings.md` | NEW spec |

## NOT in this step

- **The UI** (edit/save toggle on the alarm config panel). This is the function
  Peter asked for; the panel is a separate step and needs the function first.
- **Compound `detect` arguments.** `det.win` shares `cmd: detect` with the
  readonly `det.n`, and API.md §3 says the first arg is ignored. Only settings
  with a single unambiguous argument are wired now; `det.win` is listed as
  unsupported rather than guessed at.
- **OpManager integration.** The natural home is a `MeshRunner` class, but
  OpManager's runners are documented as stubs; wiring into a stub framework
  would couple this to unfinished work. The function stands alone and can be
  adopted by OpManager later.

## Invariants

- No setting is written to node-dash state on success — the device's
  `type:config` remains the only source of displayed config.
- An out-of-range value is never transmitted.
- Silence is a failure (`no_reply`), never a success.
- A send on channel 0 is impossible by construction.

## Done when

- Validation rejects out-of-range and readonly paths without transmitting
- Channel resolution refuses when no named Private channel is found
- A live save returns `applied` on `ok:true`, and the device's re-broadcast
  updates the cached config
- `check_specs.py` green
