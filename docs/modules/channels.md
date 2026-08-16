---
module: channels
source: src/channels.js
source_hash: 4e6a3906b605d8fb264fe84e4d34ade4d7ab27cb7a7453a84c2493f7234b228c
updated: 2026-08-14
---

# Module: channels

## Purpose

**The one place that answers "which channel is this".** A Meshtastic channel's
identity is its pre-shared key. Not its index, and not its name. Every consumer
that needs to know whether traffic is on the private channel, or which slot to
transmit on, asks this module.

Peter, 2026-08-14: *"it should be a global func, that selects the private channel
based on a shared key (which may be in a config file) you CANNOT use channel index
and assume that channel 1 is the private channel on all devices."*

## Why index and name both fail

Measured 2026-08-14, `GET localhost:8001/<addr>/channels` on both our radios.
Fingerprint is the first 12 hex of sha256(psk); the key itself is never printed,
logged or stored.

| radio | idx | role | name | psk_fp |
|---|---|---|---|---|
| `E9:B0:3F:17:27:91` | 0 | PRIMARY | *(none)* | `5d4dc0ce1ab5` |
| | 1 | SECONDARY | `mqtt` | *(no key — unencrypted)* |
| | 2 | SECONDARY | `Private` | `1ee0ab2c7a2b` |
| `F4:12:FA:39:F7:B6` | 0 | PRIMARY | `Public` | `5d4dc0ce1ab5` |
| | 1 | SECONDARY | `Private` | `1ee0ab2c7a2b` |

- **INDEX FAILS.** Private is `2` on one radio and `1` on the other. Index `1` on
  `E9:B0` is `mqtt` — unencrypted, and the one channel that is emphatically *not*
  private. Code that hard-codes `1` broadcasts to MQTT from that radio.
- **NAME FAILS.** The two PRIMARYs are the same channel by key, but one is named
  `Public` and the other is **unnamed**. A name is decoration, not identity.
- **KEY WORKS.** The fingerprint matches across radios in both cases.

## The key is never stored

`psk` is already in `public/app-forms.js` `SENSITIVE_FIELDS`, and
`docs/modules/browser-playwright-audit.md` permits only `psk_present` and a length
to leave the system. This module holds a **sha256 fingerprint** and nothing else.

A fingerprint matches exactly as well as the key for every question this module
answers — it is what proved both `Private` channels are one channel — while being
safe to persist, log and serve. Putting a live mesh key in the SQLite config table
would be a step backwards from the rule the browser already follows.

`pskFingerprint(psk)` returns `null` for an absent or empty key, so an unencrypted
channel can never accidentally compare equal to a configured one — `mqtt` above is
exactly that case, and `null === null` must not mean "same channel".

## Which channel is private is CONFIGURED, not inferred

Config key **`channels.private_psk_fp`** holds the fingerprint of the designated
private channel.

It cannot be derived. "The key both radios share" does not single it out — the two
PRIMARYs are shared too, and a third shared channel would be equally ambiguous. So
the designation is a stated fact, not a deduction.

When the key is unset, every predicate below returns `null`/`false` rather than
guessing. **An unknown private channel must never resolve to index 0**, which is
PRIMARY, which is the public mesh.

## API

| function | returns | notes |
|---|---|---|
| `pskFingerprint(psk)` | `string \| null` | sha256 hex of the key; `null` if absent/empty |
| `privateFp()` | `string \| null` | the configured designation, or `null` if unset |
| `isPrivate(device, index)` | `boolean` | **the only permitted "is this private" test** |
| `privateIndexFor(device)` | `number \| null` | the slot to transmit on for that radio |
| `resolveChannel(device, index)` | `object \| null` | `{index, name, role, psk_fp, is_private}` |
| `channelsFor(device)` | `array` | every known channel on that radio |

`device` is MAC vocabulary, case-insensitive — the same key `lastDeviceChannels`
uses, and the same `device` column the `messages` table records against a received
packet. **The pair (device, index) is the only thing that identifies a slot**;
neither half alone is sufficient.

## Where the table comes from

`src/ws-relay.js` `refreshDeviceChannels()` already fetches `/<addr>/channels` on
every device READY and caches `{index, name, role}` per radio. It now also computes
`psk_fp` and calls `setDeviceChannels()` here, so this module holds the same table
the send form is built from and the two can never disagree.

This module does **no** HTTP of its own. A second fetcher would be a second source
of truth for the same question, and they would drift.

## What this module deliberately does not do

- **It does not decide policy.** "Never transmit on PRIMARY" is a caller's rule;
  this module only says which slot is which. `src/callout.js` transmits on channel
  `0` on purpose and correctly — a public callout is its entire point.
- **It does not resolve by name.** No function takes a channel name. Adding one
  would reintroduce the failure documented above.
- **It does not cache across restarts.** The table is rebuilt from the radios on
  every READY, so a channel edited on the radio is picked up without a migration.

## Known consumer still to convert

`public/app-messages.js:34` classifies traffic with
`privateChannel: (r.channel ?? 0) !== 0`. On `E9:B0` that labels the `mqtt` channel
private, and it is mislabelling live traffic today. Converting it is Domain 2 and
tracked separately — the browser must receive a served boolean, not compute one.
