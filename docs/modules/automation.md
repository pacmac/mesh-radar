---
module: automation
source: src/automation.js
source_hash: 655441b8015946ae32f8765cf08bca74db29efd9711450362e49d95070a28c8c
updated: 2026-08-16
---

# Module: automation

## Purpose

**Lets one person in a field drive the home station and get a measurement back.**
A verb is broadcast on the Private channel, node-dash acts on it, and answers as a
reply to the command.

Peter, 2026-08-14: *"a remote survey where I pinged home 11 times to test different
antannae locations"*, *"a commmand verb would be prefixed by `@` i.e `@xxxx`"*, and
on where it is typed: *"DM no, BC on Private Channels"*.

This is the whole point — no second operator at the dashboard.

## The verb table

Closed and small, in `probe-plan.js`'s shape and for its stated reason: *"An
open-ended DSL in a config file becomes a programming language nobody can validate,
and the failure mode is a silently-ignored step."*

| verb | argument | does |
|---|---|---|
| `@point` | node, or **omitted = you** | aims the YAGI at that node's bearing, briefly holds, releases |
| `@ping` | *(ignored)* | answers with the signal of the packet that carried the command |
| `@route` | node, or **omitted = you** | traceroutes and answers with the path |

**The argument is optional and defaults to the sender**, which is not what Peter's
sketch said (`point xxx`) and is deliberate. In a field, one-handed, the node you
want pointed at is *you* — and typing your own node id is exactly the friction the
module exists to remove. An explicit `!hex` still works for driving it at something
else.

Contents are hard-coded for now, by his instruction — *"maybe initially they would
not be 100% confiugurable but hard coded"* — but the SHAPE is the eventual one:
verb, args, permission check, handler. A later config-backed table replaces the
contents, not the machinery.

## Replies

Peter, 2026-08-14: *"all replies start with a short form time stamp: 12:15 XXXX and
they should be REPLIES to the command."*

Both are contract:

- **Stamped.** Every reply begins `HH:MM ` from `fmtStamp()` in `format.js` — the
  same server-side formatter the pages use. A survey is a sequence of measurements
  and an unstamped one cannot be placed in it.
- **Threaded.** Every reply carries `reply_id` = the command packet's id, so a
  client shows it against the command rather than as loose chatter. With several
  pings in flight this is the only thing that says which answer belongs to which.

Sent through `sendMeshText()`, the single recording transmit path — so every reply
lands in the message log like any other traffic.

## Where it listens, and where it answers

**Gate, in order.** Any failure is silence, never a guess:

1. `ev.type === 'packet'`, portnum `TEXT_MESSAGE_APP`
2. **broadcast, not a DM** — `packet.to === BROADCAST_NUM`
3. `isRole(device, packet.channel, 'pri')` — `channels.js`, never an index literal
4. text begins `@`
5. the packet id has not already been handled

The reply goes out on `indexFor(device, 'pri')` for the radio that heard it — the
role is asked for by name, two args, `(radio, 'pri')`. **If that returns null the
reply is dropped, not sent on 0.** Channel 0 is a PRIMARY, which is the public
mesh; answering a private command in public is the worst outcome available.

**Automations run on `pri` and only `pri`** — Peter, 2026-08-16: *"FYI for the
time being automations will work on private channel."* `channels.js` is the SSOT
for which slot that is on each radio, and this module never decides it.

### Both radios hear the same broadcast

Measured in the live store, 2026-08-14:

```
select packet_id, count(*) n, group_concat(device) from messages
  where ts > now-86400 and is_dm=0 group by packet_id having n>1;
-> 3049001458 | 2 | F4:12:FA:39:F7:B6, E9:B0:3F:17:27:91
```

So without a dedup one `@point` moves the rotator **twice** and answers twice. The
handled-ids set is this module's own; `ws-relay`'s `_seenLivePktIds` is precedent
but not shared — it is cleared on bridge reconnect for reasons that are not ours.

The **first** radio to deliver the command wins and answers. It demonstrably holds
the Private channel and demonstrably has a path to the sender.

### An unknown verb is answered with silence

Proven necessary by the first live test. A third party on the private channel sent
`@claude` — ordinary human chatter that merely began with `@` — and the first
implementation broadcast `? @point @ping @route` back at the whole channel.

**`@` is not ours.** It is a normal way to address a person, and a machine that
answers every message starting with one is exactly the nuisance `callout.js` exists
to avoid: *"we dont want to make ourselves unpopular"*.

The cost is that a typo gets no answer. That is the right trade — the refusal is
recorded on the `automation-verb-refused` hook and visible in the event log, so it
is explainable to us without being broadcast at everyone else.

## Guards

- **Ships disabled.** `automation.enabled`, default false. Same rule as
  `callout.js`: merging this transmits nothing, and turning it on is Peter's action.
- **A hard reply ceiling in code that config may only lower.** `callout.js`'s
  pattern verbatim, and for its reason: *"An unattended process transmitting on a
  public channel shared with strangers is the one failure here that a commit cannot
  undo."* Private is not public, but a rotator that answers every broadcast forever
  is still a fault.
- **The rotator is SHARED with the garage alarm.** `@point` uses
  `rotator.point(az, {hold, by:'automation'})`, which already waits out another
  holder's stated hold rather than fighting it, and takes a brief hold it releases.
  It never takes a long lockout.
- **`@route` does not aim.** `traceroute.run()` owns aiming through `opts.aim`.
  Aiming here as well would repeat the double-aim defect already in the ledger.

### Any sender on Private may command — Peter's explicit decision

I proposed restricting verbs to his own nodes. He declined:

> *"no need to restrict from my nodes, this is a provate channel. I am not bothered
> about that at this point."*

Recorded here so it reads as a decision rather than an oversight, and is not
"fixed" back by a later session. His own *"at this point"* is why `senderAllowed()`
**exists and returns true** rather than being absent: if it is ever wanted, there is
one function to change and no hole to find.

## What this module does not do

- **No scheduling, no sequences.** A survey is a sequence, but v1 answers one verb
  at a time. `mission-runner.js` already runs step sequences and is where that
  belongs when it is wanted.
- **No name lookup.** An argument is `!hex` or nothing. Resolving `"BNCH"` to a num
  needs a decision about ambiguity that has not been taken.
- **No per-radio signal comparison — deferred, and stated rather than faked.** When
  both radios hear a `@ping`, comparing them is exactly what a survey wants
  (*"OMNI -95/6.5, YAGI -88/8.0"*). It needs a coalescing window, and picking a
  "safely large" wait is what `/derive` forbids. **So a reply names the radio that
  heard it**, and a number is never ambiguous about which antenna produced it.
