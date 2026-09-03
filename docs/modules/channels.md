---
module: channels
source:
  - src/mesh-send.js
  - src/messages-api.js
  - src/automation.js
  - src/callout.js
  - src/resolve.js
  - src/ws-relay.js
source_hash: 74a117125874cad5cd9c0027b8f49e38ee10a1e46cac3c38447c587bf00489f9
updated: 2026-09-03
---

# node-dash knows two words: `public` and `private`

Peter, 2026-08-19:

> you need to know nothing about channels, channel indexes, PSKs, PKI, all you
> need to know is public and private.

> so all code for resolve needs ripping out

That is the whole specification. A channel crosses this repo's boundary as one of
two strings. Nothing here computes, stores, compares or reasons about an index, a
name, a PSK or a key hash.

## What is deleted

`src/channels.js` — 239 lines — in full, with its four importers rewired.

It was not broken. It resolved per device by `sha256(name + NUL + psk)` against
our own configured identity, and returned `null` rather than `0` when nothing
matched. Measured today it agrees with the gateway on both radios.

**Being correct is not the argument for keeping it.** The instruction is that this
repo should not know what a PSK is. Two implementations of one rule is how
16–18 August happened, and this one being right tonight says nothing about the
next firmware or the next radio. The gateway owns the radios; resolution belongs
with the gateway.

## The divergence that makes any local index wrong

mesh-gw raised it, and it is confirmed here from two independent sources.

Their resolver, live:

```
!2687afb1  OMNI   {"public": 0, "private": 2}
!fa39f7b4  YAGI   {"public": 0, "private": 1}
```

Our own `messages` table, 14 days, which is traffic rather than opinion:

```
OMNI  E9:B0:3F:17:27:91   ch 0 x155    ch 2 x264
YAGI  F4:12:FA:39:F7:B6   ch 0 x37     ch 1 x679
```

OMNI carries a disabled `mqtt` slot at index 1, so its private sits at 2; YAGI has
no such slot and its private sits at 1. **Any code holding "private = 2" transmits
into an unconfigured slot on the YAGI** — silently, with no error.

## The new contract

| we send | gateway does |
|---|---|
| `POST /{id}/messages  {"text": "...", "channel": "private"}` | resolves on the radio addressed |
| `POST /{id}/traceroute {"to": N, "channel": "public"}` | same, and refuses if the primary was renamed or re-keyed |

`channel` is **required** on `/messages` as of their `eb43840`; omitting it is a
400. That refusal is about silence, not about PRIMARY — a caller that must say
which channel it wants cannot land on the public mesh by accident.

**If an index is ever needed for anything else, take it from
`GET /{id}/channels → resolved`. Never derive it.**

## The changes, call site by call site

| file | before | after |
|---|---|---|
| `src/channels.js` | the resolver | **deleted** |
| `src/mesh-send.js` | `if (!Number.isInteger(channel)) throw` | require the string to be `public` or `private`; pass it through |
| `src/messages-api.js` | passes `req.body.channel` (an index) | passes the word, unchanged |
| `src/automation.js` | `indexFor(device, 'pri')`, drop when null | send `channel: 'private'` |
| `src/callout.js` | `indexFor(gatewayNodeId, 'pub')`, withhold when null | send `channel: 'public'` |
| `src/resolve.js` | `channels: { pub: …, pri: … }` in the radio record | field removed |
| `src/ws-relay.js` | `refreshDeviceChannels` normalises name/psk and calls `setDeviceChannels` | the normalising and the call go; the device-list broadcast stays |

### The guards stay, and change shape

`automation.js` and `callout.js` each **drop the send** when a channel cannot be
resolved, rather than falling back to `0`. That reasoning is still right, but the
condition moves: there is nothing local left to be null. The gateway now answers
with a **400** when `public` or `private` does not resolve, so the guard becomes
"the send was refused" instead of "the index was null".

**Neither may fall back to any channel on a refusal.** A private reply on the
public mesh is the worst outcome that path can produce, and a callout into a
channel nobody is on spends social capital while logging a success.

### The one index that stays, and why it is not resolution

`automation.js` gates on the channel a command **arrived** on:

```js
if (!isRole(device, pkt.channel ?? 0, 'pri')) return;   // before
```

Without it, an `@ping` shouted on the public mesh drives our rotator. That gate
cannot be written in the two words today, because **inbound events carry an
integer only** — `docs/gw/API_SSE.md:135`, "`channel` | int | Channel index". The
gateway does not label a received packet public or private.

So the gate stays, and its number comes from the **gateway's own answer**:

```
GET /{id}/channels -> {"resolved": {"public": 0, "private": 1}}
```

mesh-gw asked for exactly this in `remove-your-channel-resolver`: *"if you keep
any index-derived logic at all, source the index from `resolved` rather than from
your own pass over the channel list."*

**This is not a resolver.** It computes nothing, reads no PSK, hashes no name, and
holds no rule about what makes a channel private. It caches an answer given to it,
per radio, and compares an integer. If the gateway's answer changes, ours changes
with it — which is the entire point of removing the second implementation.

Raised with mesh-gw as `inbound-packets-carry-no-channel-role`: label received
packets with the resolved role and this last integer disappears too.

**It fails CLOSED.** No cached answer, or a `private` of `null`, means the gate
returns false and the automation does not run. Silence is the safe failure; acting
on a public command is not.

### Config keys retired

`channels.pub_name`, `channels.pub_psk`, `channels.pri_name`, `channels.pri_psk`.
`/config` currently publishes only `channels.*_present` booleans, because the PSK
is sensitive — after this, the repo has no reason to hold either half.

### Explicitly NOT changed

- **The `channel` column in `messages`.** It records the index a packet was
  *received* on, which is history and is per-gateway by nature. This task is about
  what we **send**, and rewriting stored history to a word would destroy the
  evidence that proved the divergence above.
- **`src/traceroute.js:507`** — `bridge.post(…/traceroute, { to })` carries no
  channel. Whether the gateway now refuses that is checked during implementation;
  if it does, it is fixed here as a channel-carrying send, and if it does not, it
  is registered rather than tidied.

## Test notes

- no file under `src/` imports `channels.js`, and the file does not exist
- `grep -rn "indexFor\|channelKey\|designatedKey\|setDeviceChannels" src/` is empty
- no `psk` or `pub_name`/`pri_name` config read remains in `src/`
- a send with `channel` omitted is refused by us before it reaches the gateway
- a send with `channel: 'private'` reaches the gateway carrying the word, not an
  integer — asserted on the request body, since the index is no longer ours to
  know
- the two radios still receive on different private indices, and nothing in `src/`
  depends on which
