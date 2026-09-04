---
module: radar-traceroute-overlay
source:
  - public/app-radar.js
  - public/app-ws.js
  - public/app.js
  - public/partials/tab-radar.html
source_hash: cbccc1296be7684b48db079960bd9973461caca043620842098bb80f20caa6f5
updated: 2026-09-04
---

# The radar watches a traceroute happening

## The rule I got wrong, and the one that actually applies

Peter, 2026-08-18:

> "the point in making traceroute a callable func and having its own ws feed is
> that things like radar can show it happening WITHOUT commanding it, same as it
> also shows the yagi's aim position and movement."

The standing rule is **the browser must not COMMAND a traceroute**. On 2026-08-17
(`86400ab`) I applied it as *the browser must not SHOW traceroutes* and deleted
189 lines of `app-radar.js` — the route chain, the per-hop SNR labels, the age
fade and the animated dots — along with the TRACE button.

The button was right to go: that was the browser deciding to transmit. The
overlay was not. The radar's relationship to the rotator is the model — it has
always rendered `rotator.status` continuously and has never been able to point
the antenna.

| stays gone (COMMANDS) | comes back (OBSERVES) |
|---|---|
| the TRACE button | the route chain and its hops |
| the auto-traceroute scheduler | the in-flight animation |
| any POST from `public/` | the aim bearing and beam movement |

## Driven ENTIRELY by `traceroute_status`

The browser makes no enquiries of its own — no lookup, no history fetch, no
derivation. Everything it draws arrives on the feed:

| drawn | from |
|---|---|
| the believed path, before anything moves | `known_route.route` + `known_route.relay_positions` |
| the answered path | `result.route` on `phase: answered` |
| which node is being traced | `target.num`, `target.label` |
| where the beam went | `aim.az_requested` / `aim.az_arrived`, `radio.beam_deg` |
| whether it is still running | `phase` |
| why nothing was transmitted | `phase: aim_failed` + `error.reason` |

`relay_positions` is what makes "no enquiries" true rather than nearly true: only
80 of 109 relays seen in stored routes have a position in the node list.

## No timers, and none needed

The standing rule is *"NO TIMERS, NO POLLING FULL STOP"*, and the browser
currently carries 41 of them (ledger `park-browser-timers-and-derivation`). This
adds none:

- **The animation is SMIL** — `<animateMotion>` inside the SVG. The browser does
  not tick it; the renderer does. This is what the original used and the reason
  it was safe.
- **Nothing expires on a clock.** A finished trace stops animating and stays
  drawn as the last known path, until the feed replaces it. There is no
  "fade out after 30 s", because that would need a timer and would also throw
  away the most recent thing we know.

The deleted version had a `_passiveTraceTimer` doing exactly that. It is not
coming back.

## State

`traceroutes: {}` — keyed by the feed's `id`, holding the last event for each
run. A Map rather than a single value because more than one trace can be in
flight, and because a terminal entry is worth keeping to draw.

## Two details that were bug fixes, not decoration

Both are recorded in `86400ab`'s removal comment and must survive the rebuild:

1. **Per-hop SNR labels skip nulls.** An unmeasured hop was once drawn as a
   confident `-32.0`, because the old code divided by 4 with no sentinel guard.
   SNR now arrives already in dB with `null` for unmeasured hops.
2. **The dash pattern distinguishes an adjacent hop from a gap** where a relay's
   position is unknown — so a chain with a hole does not read as a direct link.

## Test notes

1. A real traceroute renders: chain visible, target highlighted, dots animating
   while in flight.
2. `answered` redraws from `result.route` and stops animating.
3. `aim_failed` shows the target as attempted-but-not-transmitted, with the
   reason available.
4. `grep setInterval|setTimeout` in the changed files returns nothing new.
5. Both themes, 1600x1000 and 1280x800, no console errors, nothing clipped.
