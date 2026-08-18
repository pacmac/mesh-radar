---
module: channels
source: src/channels.js
source_hash: 100dced1d85383821686e62199d3077a9a3482dd161adfe0591cb8c0e153c07e
updated: 2026-08-18
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

## ⚠ A MISNAMED PRIMARY IS FIXED BY RENAMING THE RADIO — NEVER BY DESIGNATING IT

**Read this before changing `channels.pub_key` or a radio's primary channel name.**

The section above diagnosed the YAGI correctly on 2026-08-16. The fix was then
applied **backwards**, and that cost two further days and every scrap of public
traffic.

`channels.pub_key` was set to `b7ecd210` — `channelKey('Public','AQ==')`, the
YAGI's **broken** channel. The OMNI, named in the table above as the **correct**
one at `865e781a` = `channelKey('','AQ==')`, was then renamed `Public` to match
it. Both radios ended up transmitting into, and listening on, a channel nobody
else on the mesh uses.

| | |
|---|---|
| public text messages | 85/day → **0** |
| nodeinfo refreshes | 185/day → **0** |
| remote traceroutes | every one timed out |
| Peter's own public messages | no replies for two days |

Dead from 2026-08-16 ~18:15 until it was found on 2026-08-18.

### Why nothing caught it

**The radios and the config agreed with each other.** `divergences()` compares
each radio to *our designation* — never to the mesh. Designate the wrong channel
and every radio becomes "correct" and the check goes silent. A green resolver is
not evidence that anybody can hear us.

### The signature, so it is recognised in minutes

**You still hear everyone, and you decrypt nothing from any stranger.** LoRa
headers are unencrypted, so `from`, `snr` and last-heard keep updating and the
dashboard looks entirely alive while every payload from a third party fails to
decrypt. If node-dash decodes its own radios and the alarm units but no outside
node, suspect the primary's **name** before anything else.

### The rule

The designation names **the channel the mesh is on**. Not "the channel our radios
happen to carry", and never "the channel they agree on" — two radios can agree
and both be wrong, which is precisely what happened here.

### The name is load-bearing and is hashed verbatim

From the firmware itself, `src/mesh/Channels.cpp` — the published documentation
does not state this:

```c
generateHash() = xorHash(getName(ch)) ^ xorHash(key)
getName()      = the stored name, EXCEPT an empty name is replaced by the
                 modem preset display name ("LongFast") when use_preset is set
```

So empty ≡ `LongFast` ≡ the default public channel, and **any** other string —
`Public`, a typo, a stray capital — is a private channel of one that looks
perfectly normal in every UI. Set the primary's name to **empty** and leave it.

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

### The resolver absorbs the vocabulary; callers do not convert

`device` may be a **BLE MAC** (`E9:B0:3F:17:27:91`) or a **node id**
(`!2687afb1`), case-insensitive. `ws-relay` registers each radio's table under
both, because it holds both.

`docs/IDENTITY.md` is LAW that the MAC is canonical — `__ble_addr`, present from
first scan, surviving reboots and factory resets, while `node_id` is an attribute
that is null until first sync. Measured 2026-08-16 across 34 live gw events:
`addr` and `__ble_addr` never differed and were never absent; `node_id` was
missing on 3 of them.

**Accepting both is not a softening of that law, it is enforcement of it.**
Callers legitimately hold different vocabularies — `dash-mode.transmitterForMode()`
returns a node id via `macToNodeId()`, so `callout` is handed `!fa39f7b4` and never
sees a MAC. If the resolver took MACs only, every caller would grow its own
conversion, which is how eleven identity helpers across five modules came to exist.
One boundary converts; nothing beyond it does.

Short forms (`27:91`, `TA2o`) are **not** accepted. Across 1,056 nodes, last-4 hex
collides 20 times and short names 26 times; they are unambiguous only within our
own radios, and a resolver that is safe for two devices and unsafe for the mesh is
a trap. `IDENTITY.md`: *"The 4-char suffix is NOT an identifier."*

**The pair (device, index) is the only thing that identifies a slot**; neither half
alone is sufficient.

### Where the data comes from is behind this boundary

Peter, 2026-08-16: *"whether or not the resolver gets its data from cache or
directly from mesh-gw could be changed provided that resolver is the SSOT for
antenna / channel selection."*

Today `ws-relay` feeds it on device READY. It could feed from `GET /devices` on
every call instead, and no caller would change. That is the property worth
protecting: callers ask for a **role on a radio**, never for an index, so the
source can move without a sweep.

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

**MIGRATED 2026-08-16**, task `channel-callers-onto-resolver`:

| site | was | now |
|---|---|---|
| `src/callout.js` | `channel: 0` hardcoded | `indexFor(dev,'pub')`, and **refused** when it will not resolve |
| `src/messages-api.js` | `req.body.channel ?? 0` | **400** when the channel is unstated |
| `src/mesh-send.js` | `channel ?? 0`, and undefined dropped from the body | **throws** `channel required` — the chokepoint every sender crosses |

**`src/imap-receiver.js:112` is deliberately NOT migrated.** Its `ctx.channel ?? 0`
reads a reply token built in `alerts.js:169/:185` from `pkt.channel` — it **echoes
the channel the original message arrived on**, which is the same shape as
`alerts.js` and `persist.js`. Echoing is not choosing. Routing it through the
resolver would replace a correct answer (reply where they spoke) with a guess
(reply on whichever role we think fits).

`src/alerts.js` and `src/persist.js` likewise echo the arrival channel and are
correct as they stand.

## What this module does not do

- **No policy.** "Never transmit on `pub` unattended" is a caller's rule.
  `callout.js` transmits publicly on purpose and correctly.
- **No name lookup.** No function takes a channel name; a name is half an
  identity, and half an identity is how this went wrong.
- **No HTTP.** `ws-relay`'s `refreshDeviceChannels()` feeds it on every device
  READY. A second fetcher would be a second source of truth for one question.
- **No persistence across restarts.** The table is rebuilt from the radios, so a
  channel edited on a radio is picked up without a migration.
