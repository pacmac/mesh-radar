---
module: traceroute-via
source:
  - src/aim.js
  - src/traceroute.js
  - src/traceroute-api.js
source_hash: bee9cea5b99946f028543437250914f149e34fc72bf918cdab365aefe4cd220a
updated: 2026-08-18
---

# `via` — aim at a chosen node instead of the derived one

## His words, 2026-08-18

> "next is to add a new arg "via" if via is set, the traceroute will go via that
> node, again this only applys to directional antennas"

## What `via` can and cannot mean

**It is an AIM OVERRIDE, not a route instruction.** Meshtastic offers no source
routing for a traceroute request, and mesh-gw's surface is
`send_traceroute(to: int)` — the target and nothing else
(`docs/gw/modules/ble_device.md:66`). There is no field in which a path could be
expressed.

The only way node-dash can make a traceroute *go via* a node is to put the beam
on that node, so its chance of hearing us and relaying rises. Which is exactly
why Peter's own sentence ends "this only applies to directional antennas": on an
omni there is no beam to point, so there is nothing `via` could do.

So: `via` replaces what `decideAim()` would have chosen. It does not change what
is transmitted, only where the antenna is pointed while transmitting it.

## Behaviour

| radio | `via` | what happens |
|---|---|---|
| omni (360°) | set | **ignored**, and the response says so. The traceroute still goes — it is a valid request, `via` simply has no meaning without a beam |
| directional | set, bearing resolves | aim at `via`. `aim_mode` = **`via`**, `aim_target` = the via node |
| directional | set, bearing does NOT resolve | **refuse.** Do not dispatch, do not fall back |
| directional | unset | unchanged: the relay if the last route was relayed, else the node |

### Why an unresolvable `via` refuses rather than falling back

Falling back to `decideAim()` would transmit while silently ignoring an explicit
instruction — the caller asked for the beam on X, and we would have pointed it
somewhere else and recorded a row that looks deliberate. That is the same class
of fault as the `'omni'` branch that returned the YAGI, and as a "verified" hop
badge that nothing could verify. An explicit argument that cannot be honoured is
an error, not a suggestion.

It fails the same way an unconfirmed aim does: no dispatch, an `aim_failed` row,
and the reason in the response.

### `via` is not validated against the route

If the caller says `via` some node that is not on any known path to the target,
we aim there anyway. That is the point: the operator is testing a hypothesis
about a corridor, and refusing to point at a node "because it isn't on the known
route" would make the argument useless for discovery — the known route is
precisely what is being challenged.

## Surface

```js
traceroute.run(radio, node, timeoutMs, { via })     // via is an OPTION
POST /traceroute { radio, node, timeout_ms, via }   // via is a body field
```

**Why `via` is an option and not a fourth positional.** Peter specified "min 3
args, 1 radio, 2 node, 3 timeout" and that contract is kept exactly — `via` is
optional, so making it positional would either sit awkwardly before `opts` or
force callers to pass a placeholder. `min` allows more; it does not require them
to be positional.

`via` accepts `!hex` or a node num, the same as `node`.

## Test notes

1. Directional + `via` with a resolvable bearing → `aim_mode 'via'`,
   `aim_target` is the via node, and `aim_az_req` is the via node's bearing —
   NOT the target's and NOT its relay's.
2. Directional + `via` that has no position → no dispatch, error names `via`.
3. Omni + `via` → dispatch proceeds, nothing points, response flags it ignored.
4. No `via` → the node/relay rule is unchanged.
5. On air: the rotator physically arrives at the via node's bearing.
