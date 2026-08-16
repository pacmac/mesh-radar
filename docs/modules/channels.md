---
module: channels
source: src/channels.js
source_hash: 24f1169061cf2f7ecc563251edc8c0d62ac6886515d358582dd5061376ae3bce
updated: 2026-08-16
---

# Module: channels

## Purpose

**The single source of truth for "which channel is this, and which slot do I send
it on".** Nothing else in the codebase may decide a channel.

Peter, 2026-08-16: *"the resolver needs to resolve this, needs an arg passed to it
'pub or pri' ... I suspect there are lots of other places where the wrong channel
is used. resolve should be the SSOT"*, and earlier: *"you CANNOT use channel index
and assume that channel 1 is the private channel on all devices."*

## A channel's identity is its NAME **and** its key

`channelKey(name, psk)` = `sha256(name + NUL + psk)`, and `null` when there is no
key.

**Key alone is not enough, and getting that wrong cost five days of the YAGI.** An
earlier version of this module identified a channel by its PSK fingerprint and
concluded that our two PRIMARYs — same key, one unnamed and one named `Public` —
were the same channel. Meshtastic derives the transmitted channel hash from the
name *and* the key, so they are **not**: a primary renamed `Public` is a channel
nothing else on the mesh is listening to.

Measured 2026-08-16, and this is the whole argument for the identity function:

| radio | idx | role | name | `channelKey` |
|---|---|---|---|---|
| OMNI `E9:B0` | 0 | PRIMARY | *(unnamed)* | `865e781a56f3…` |
| | 1 | SECONDARY | `mqtt` | *(no key)* |
| | 2 | SECONDARY | `Private` | `fffb995be728…` |
| YAGI `F4:12` | 0 | PRIMARY | `Public` | `b7ecd210d6cd…` |
| | 1 | SECONDARY | `Private` | `fffb995be728…` |

The two `Private` slots come out **identical** at different indices — that is the
resolution the automation depends on. The two primaries come out **different**,
which is the fault, and under the old key-only identity they looked the same.

**`null` for an unencrypted channel, deliberately.** `mqtt` has no key. If it
returned a constant, `null === null` would make it match a designated channel and
a private broadcast would go out in clear.

## Roles: `pub` and `pri`

Callers ask for a **role**, never an index and never a name:

| config key | role | what it is |
|---|---|---|
| `channels.pub_key` | `pub` | the public mesh — LongFast, the channel strangers are on |
| `channels.pri_key` | `pri` | our own private channel |

The designation is **configured, not inferred**. "The channel both radios share"
does not single either out, and inferring `pub` from "index 0" is exactly the
assumption that hid the YAGI fault — index 0 on the YAGI *is* a primary, it is
just the wrong one.

**Automations run on `pri`.** Peter, 2026-08-16: *"FYI for the time being
automations will work on private channel."*

## API

| function | returns | notes |
|---|---|---|
| `channelKey(name, psk)` | `string \| null` | identity: name **and** key |
| `designatedKey(role)` | `string \| null` | the configured key for `pub`/`pri` |
| `indexFor(device, role)` | `number \| null` | **the slot to transmit on** |
| `roleOf(device, index)` | `'pub' \| 'pri' \| null` | what a received channel IS |
| `isRole(device, index, role)` | `boolean` | the only permitted membership test |
| `channelsFor(device)` | `array` | every known channel on that radio |
| `divergences()` | `array` | radios missing a designated channel — see below |
| `setDeviceChannels(device, chans)` | — | fed by ws-relay; this module does no HTTP |

`device` is MAC vocabulary, case-insensitive. **The pair (device, index) is the
only thing that identifies a slot**; neither half alone is sufficient.

### `indexFor` returns `null`, never a default

A caller that fell back to `0` would transmit on whatever that radio's primary
happens to be. On the YAGI that is the misnamed channel; on any radio it is the
public mesh when you asked for private. **Null means "cannot send", not "send
anyway".**

### `divergences()` — the SSOT reports its own gaps

For each radio, any designated role with no matching slot. This is the check that
would have caught the YAGI on 12 August instead of five days later:

```
[{ device: 'F4:12:FA:39:F7:B6', role: 'pub', reason: 'no slot carries the designated key' }]
```

A radio that cannot reach the public mesh is not a quiet edge case — it is a radio
whose every public transmission goes nowhere, silently, while the dashboard shows
a plausible combined success rate carried by the other radio.

## Known callers that still choose a channel themselves

Found 2026-08-16 while making this the SSOT. **Not migrated in this task** — each
needs its own change and its own proof, and Peter's "lots of other places" is a
scope warning, not an invitation to do them all at once:

| site | today | why it matters |
|---|---|---|
| `src/callout.js:85` | `channel: 0` hardcoded | the public callout. On the YAGI, index 0 is the misnamed slot, so a callout would go nowhere while the ledger recorded it sent |
| `src/imap-receiver.js:112` | `ctx.channel ?? 0` | email-to-mesh falls back to index 0 |
| `src/messages-api.js:14` | `req.body.channel ?? 0` | the browser send form's default |
| `src/mesh-send.js:28` | `channel ?? 0` | records 0 when unstated — a recording default, not a transmit decision |

`src/alerts.js` and `src/persist.js` echo the channel a packet *arrived* on. That
is not choosing, and is correct as it stands.

## What this module does not do

- **No policy.** "Never transmit on `pub` unattended" is a caller's rule.
  `callout.js` transmits publicly on purpose and correctly.
- **No name lookup.** No function takes a channel name; a name is half an
  identity, and half an identity is how this went wrong.
- **No HTTP.** `ws-relay`'s `refreshDeviceChannels()` feeds it on every device
  READY. A second fetcher would be a second source of truth for one question.
- **No persistence across restarts.** The table is rebuilt from the radios, so a
  channel edited on a radio is picked up without a migration.
