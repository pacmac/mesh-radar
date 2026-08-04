---
module: callout-runner
source: src/callout-runner.js
source_hash: 2fa635477a124ee0163e7d5ab13e89ff6194465ef80dacd6412eabab4494db41
updated: 2026-08-03
---

# Module: callout-runner

## Purpose

The thing that actually pulls the trigger. `callout.js` decides and sends; until
this existed **nothing called it** — every guard was correct and no callout could
ever happen. A feature that cannot fire is not shipped, only written.

## Why a cadence and not a packet handler

"Strike while the iron is hot" sounds like it belongs on reception, but hanging a
transmit decision off every inbound packet means evaluating a send hundreds of
times a minute and relying on guard *order* to stop it.

A sweep is cheaper and is rate-limited by construction. The heat is already
encoded in `heard_within_h`: a node heard on `TRANSPORT_LORA` in the last two
hours **is** the hot iron, whether we act at reception or two minutes later.

It is a **worker** in Peter's sense — it runs itself on a cadence and nothing
hooks into it (`docs/modules/hooks.md`).

## At most one per sweep

Combined with the daily ceiling and the per-target cooldown, that is what stops
this ever becoming a burst. §8's "never two callouts in flight" is enforced in
the engine; this never even offers it a second.

## Furthest first

A callout is the most expensive probe available — it spends **social capital**,
not just airtime — so it goes to the target that would tell us the most, which is
the one nearest the edge of what we can reach.

## The radio is dash-mode's decision

`transmitterForMode(mode)` resolves the gateway. Peter's standing rule is that
dash mode owns every per-mode behaviour including which radio transmits, so this
module does not invent a radio-selection rule of its own.

## Cadence

Default **20 minutes**, deliberately slower than the mission loop's 180 s. A
callout asks a *human* for their attention, and the polite interval for that is
tens of minutes. The daily ceiling would bound a faster sweep anyway; the slow
cadence makes the intent explicit rather than leaving the ceiling to do the work.

First sweep is 120 s after boot, so the node list has settled.

## Verified

Against a throwaway copy of the live database with the engine **enabled**, in
`dryRun` — so nothing transmitted:

```
considered : 122      nodes heard on LoRa within 2h
eligible   :  45      passed every guard
target     : JRSY     219 km — the furthest eligible
text       : "@JRSY 219km, 159°. Testing how far this mesh
              really goes — shout back if you can hear me?"
```

A different wording from the previous run, which is the random template selection
working rather than a rotation.

With the engine at its shipped default the same sweep returns
`{ skipped: 'disabled' }`.

## Out of scope

- The decision to enable it — spec §10, Peter's switch
- Template editing UI (Domain 2)
- Reply handling — `callout.js` owns that, wired into `persist.js`
