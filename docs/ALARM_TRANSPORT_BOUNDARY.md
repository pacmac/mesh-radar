# Meshtastic is the alarm's TRANSPORT, never its application

Peter, 2026-08-13:

> *"the alarms are meshtastic nodes and will appear in node-dash, just as they
> would also appear in every other mesh user's phone app. it uses the mt mesh as a
> transport, and it keeps common things like nodeinfo, position, telemetry etc
> etc, but in alarm meshtastic is JUST a transport. alarm devices do not run
> meshtastic firmware that is ONLY dedicated to meshtastic and messaging etc etc.
> alarms are 100% custom firmware, meshtastic is ONLY the transport which we use."*

## Two layers, and conflating them is the whole class of bug

| | owner | what may be assumed |
|---|---|---|
| **TRANSPORT** — nodeinfo, position, telemetry, routing, hops, channels, RSSI/SNR | Meshtastic | everything. These units are ordinary nodes here, and in a stranger's phone app, and nothing about them is special at this layer |
| **APPLICATION** — what the unit actually *does* | **custom firmware, ours** | **nothing.** Meshtastic knows this layer does not exist |

An alarm unit is **not** a Meshtastic client with extra features. It is a
different product that happens to use the same radio to move bytes.

## What this forbids

Never reason about an alarm unit's behaviour from Meshtastic semantics — not its
role, not a channel convention, not an app-port meaning, not sleep/wake
behaviour, not what a message type implies. On stock firmware those inferences
are sound; here they describe a product that does not exist.

This has already cost real work:

- **`alarm` on portnum 260 is a PORT classification, not a motion event.** 260 is
  the product's own port, so observations and config ride it too. Measured by
  device: 149 obs, 6 config, **zero** alarm payloads — while plugins' notify paged
  21 times in 40 minutes treating the class as an event. Motion is
  `{"type":"motion"}` *inside* the payload. See xsession `[alarm-is-not-motion]`.
- **`trig` is a running counter, not a flag.** It resets on reboot and on a board
  swap, so a level test fires on every beat and a naive delta goes negative.
- **A `no_ack` proves the unit was asleep, not that routing failed.** Units wake
  ~30 s every 15 minutes; that is the product's schedule, not a mesh property.

The authority for what a unit can do is **the device itself** —
`{action:'help'}` and its schema — never Meshtastic documentation, and never a
stored message row from an older build.

## What follows for node-dash

**The units stay visible here whatever happens to the alarm product.** Our radios
(OMNI, YAGI) hear their frames the same way they hear any node's, so nodeinfo,
position, telemetry, signal history and their place in the node list and radar are
TRANSPORT facts and belong to node-dash. That is true today and would remain true
if the alarm moved to its own server tomorrow.

What is *not* node-dash's is the application: the bridge boundary
(`src/alarm-host.js`), the Control page (`public/plugins/alarm/`), and every
decision about what a payload means.

## The two systems share hardware, and nothing else

The alarm product and node-dash's mesh probing have **no relationship**. Peter,
2026-08-13: *"PASV/ACTV etc have nothing whatsoever to do with alarm, they are
functions of the radar and the probing of the mesh to reach as far as possible.
There is NO link between that whatsoever. The ONLY common factor is MY RADIOS
(OMNI and RAK) and the rotator. They are 2 entirely different things and there is
nothing one offers to the other."*

So the only contract between them is **arbitration of shared hardware** — which
radio is transmitting, and a rotator hold with a timeout. Not modes, not state,
not data, in either direction.

**This was broken once, and the fix is what the rule now rests on.**
`applyAlignModel()` in `src/alarm-host.js` used to call `dashMode.set(0)` to force
PASV for an align session, and restore the mode on stop — the 2026-08-06 rule
(*modes use the pointer, they must not control or gate it*) broken from the
plugin's end. It was deleted in `21e2432` on 2026-08-13.

Verified 2026-08-14, and this is the check to re-run rather than trust the
sentence above:

```
grep -n dashMode src/alarm-host.js     -> one COMMENT at :295, no call
grep -rn "dashMode.set" src/*.js       -> lifecycle.js, rotator-api.js only
                                          (core, legitimate); no alarm file
```

`applyAlignModel()` still exists (`src/alarm-host.js`) and still returns early,
because section `align` is `ok:false` while ownership is parked. When
`park-align-ownership` is settled it should be **deleted rather than moved** — the
align routes have no home on the bridge, and carrying dead code across a boundary
is how a violation gets reinstated by accident.

## See also

- `docs/PLUGIN_BOUNDARY_SPEC.md` — how a plugin attaches without core knowing it
- `docs/modules/alarm-host.md` — the one boundary to the bridge
- `docs/PEER_SUCCESSION.md` — who owns which half now
