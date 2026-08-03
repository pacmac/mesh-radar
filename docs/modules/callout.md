---
module: callout
source: src/callout.js
source_hash: 4d30e68b0b332393739310bf2efdfa6eef1ecf5f9e1234526e3be9e3ab385262
updated: 2026-08-03
---

# Module: callout

## Purpose

The public "did you hear me?" broadcast, and every guard that stops it becoming
a nuisance. Peter, 2026-08-03: *"a PUBLIC ping when we detect a remote node
(strike while the iron is hot)... problem with this is frequency of send, we
dont want to make ourselves unpopular or always keep sending the same message.
select them randomly and ttl them."*

A traceroute proves a route. **A broadcast a human answers proves reach into the
public mesh** — `MESH_REACH_SPEC` §7 calls it the strongest evidence available
and the most expensive, because it spends social capital rather than airtime.

## It ships DISABLED

`callout.enabled` defaults `false`. Merging this transmits nothing.

§10: *"An autonomous prober transmitting on PRIMARY is a product decision Peter
has taken, and is not licence for a session to send by hand."* Turning it on is
his action. That is also why no live broadcast was needed to verify it — the
whole engine is provable through `evaluate()`, which decides but never sends.

**There was no prior implementation.** `git log --all --grep` for
callout/broadcast/ping and `-S "callout" -- src/` both return nothing; if it was
ever written it was in another repository.

## The guards live in code, not config

§8: *"A hard ceiling on transmissions per day, enforced in the transmit path
itself, which a config edit cannot raise to infinity and a bug cannot bypass."*

| constant | value | why |
|---|---|---|
| `HARD_MAX_PER_DAY` | 12 | config may only lower it |
| `HARD_MAX_KM` | 250 | beyond this a position is not evidence |
| `HARD_MIN_COOLDOWN_DAYS` | 3 | per target, **days** not hours |
| `HARD_QUIET_FROM/TO_H` | 22–07 | no unattended broadcast overnight |

`calloutConfig()` clamps **towards safety only**: asking for more than a hard
ceiling yields the ceiling; asking for less yields what was asked.

## What the dry run caught

Running the engine enabled, against real data, before anything transmitted:

```
MLBR  1681km  hold  exceeds the 250km plausibility ceiling
HTF   1003km  hold  exceeds the 250km plausibility ceiling
```

Without `HARD_MAX_KM` the first live callout would have broadcast *"did you hear
me at 1681km?"* to the public channel, addressed to an MQTT-sourced node whose
position is not RF evidence. Humiliating, and it would have proven nothing.

That guard exists **because the dry run ran**, not because it was foreseen.

## "Strike while the iron is hot" is checkable, not assumed

A callout requires the node to have been heard **on LoRa** within
`heard_within_h` (default 2). A node known only through an MQTT bridge cannot
hear a LoRa broadcast from us, so calling out to it spends public airtime on
someone who is not listening.

This is testable because `transport_mechanism` is captured per packet in
`relay_observation` (`packet-provenance-capture`). Measured live: of the ten
in-range candidates 50–250 km, **exactly one** passed — `JRSY` at 219 km,
bearing 159°, heard within the hour. That is Jersey, the node that would beat the
189.1 km record.

## Wording

Templates are `{ text, ttl_days }`, chosen **at random** among those not
TTL-blocked for that node. Random rather than round-robin: a predictable
rotation is still a pattern a listener notices.

Tokens: `%short_name%` `%long_name%` `%km%` `%az%` `%hops%`. An **unknown token
renders empty**, never as the literal `%token%` — a broadcast containing raw
template syntax tells the whole channel the sender is not paying attention.

### A nameless node still has an address

The name fallback was `short_name || long_name || '?'`, and on 2026-08-03 that
put this on the public channel, verbatim:

```
@? long way for a few bytes — 216km, bearing 160°. Any chance that landed?
```

Node `2053915524` has **both** names null. Addressing a stranger as `@?` is
published nonsense aimed at nobody.

Peter's fix, and it is the right one: **the last four hex digits of the node ID**
— Meshtastic's own default short name for a node that has not set one, so it is
what that operator sees on their own device. `0x7A6C4384` → **`@4384`**. Our node
table is already full of them: `38d8`, `89ec`, `b3f6`, `24b0`.

My first fix was to **skip** unnamed nodes, and it was worse: it would have
silently excluded a whole class of target — including `4384` itself at 215.6 km,
one of the Jersey group that could beat the record.

The defaults are deliberately self-deprecating and end in a question, so a reply
is natural and nothing reads as boasting:

> `@%short_name% long way for a few bytes — %km%km, bearing %az%°. Any chance that landed?`

### The TTL is per (node, wording)

Keyed on a **hash of the text**, not an array index. Editing or reordering the
template list must not make the engine think a node never heard a sentence it
heard yesterday. A different node may hear that wording tomorrow — the TTL bounds
repetition to *one listener*, it does not retire the phrase globally.

## Channel

`channel` is passed **explicitly** at the call site and defaults to `0`
(PRIMARY), which is the entire point of a *public* callout. No path here may
select a channel by omission.

## The reply is the evidence

Peter, 2026-08-03: *"we send a PUBLIC broadcast targeting the node with '@xxxx'
and we then see if we get anything back from that node in a text message that
indicates we heard each other. that will also be used as data, and a guaranteed
2 way hit."*

A callout alone proves only that we **transmitted**. A text back from that node
proves the packet arrived, a human read it, and their answer travelled the whole
way home — **two-way contact at a known distance**. §7 ranks that above any
traceroute, because a traceroute can be answered by firmware while nobody is
there.

`noteInboundText()` is wired into `persist.js`, on the persisted inbound text.
That path — not a live WS handler — because it is the one route every received
message passes through; hanging it off the browser feed would miss replays and
anything arriving while no browser is connected. It is a no-op unless the sender
has an unanswered callout inside `REPLY_WINDOW_H` (6), so calling it on every
message is safe, and it is wrapped so a fault in reach bookkeeping can never
cost us the message itself.

**6 hours, not seconds.** A person has to notice, read and type. Beyond that
window a text is a coincidence, and calling it a reply would manufacture
evidence.

**The wording is recorded, never interpreted.** §10: *"Not a chatbot."* The
*fact* of a reply is the datum.

`reply_km` is null when we cannot place the node — a two-way contact we cannot
measure is still a two-way contact, and writing `0` would claim a measurement we
never made.

Proven end to end without transmitting, against the real `JRSY` row:

```
1. callout logged, awaiting reply
   unrelated node texts us      -> null
2. the TARGET replies           -> { km: 218.6, minutes: 30 }
3. hook: JRSY ANSWERED our callout after 30 min — two-way at 218.6 km
4. stats: { sent:1, answered:1, best_two_way_km:218.6, pct:100 }
   a second reply               -> null   (already answered)
```

## Storage

`callout_log (ts, num, template_hash, text, packet_id)` — the evidence behind
both the per-target cooldown and the per-wording TTL. Sends go through
`mesh-send.js`, already the single path that transmits **and** records, tagged
`category: 'callout'`.

## Hooks

`callout-sent` and `callout-withheld`, both `store` scope. The second matters as
much as the first: every rejection names its guard, because a prober that goes
quiet without saying why is the failure this project keeps rediscovering.

## Still open

§8: *"The firmware's own traceroute rate limit must be established before
assuming any rate is available. **Not yet checked — do not assume.**"* Unchecked.
The engine therefore treats its own ceiling as binding and never infers headroom
from the firmware's silence.

## Out of scope

- The config UI (Domain 2, separate task)
- Any auto-reply or conversation handling — §10: *"Not a chatbot."*
- DMs — §10: broadcasts only
