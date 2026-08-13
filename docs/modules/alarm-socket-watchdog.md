---
module: alarm-socket-watchdog
source: src/alarm-host.js
source_hash: 7841a932be55cd523b0b4c9620026e9e51b20ea0e07f25a224e24c53f1a7eeed
updated: 2026-08-13
---

# Module: alarm-socket-watchdog

## Purpose

Detect an alarm bridge socket that has stopped delivering, and force it to
reconnect. `_socket` had no liveness check at all.

## The incident

2026-08-13. Peter: node-dash reported the garage last heard **39 minutes ago**.
It had been heard **10.6 minutes ago**. Device's receptions for `!8cee336b`:

```
17:58:23   <- the reading the page was still showing
18:13:13   <- missed
18:28:13   <- missed
```

Exactly its declared 900 s beat. Device restarted the bridge at 18:22:53 —
**after** the 18:13 reception was already missed — so a socket dropped by their
restart is not the cause.

**The cause is here.** `_socket` reconnects on `'close'` and logs on `'error'`.
A TCP connection that dies without a FIN — a restarted peer, a NAT table
expiring, a dropped route — emits **neither**. node-dash held a socket it
believed was live, indefinitely, and the reconnect that re-primes the snapshot
never fired. The stall therefore had no natural end; it did not need device's
restart to begin, only to have begun once.

Device restarts that bridge **19 times a day**, which is exactly the workload
that produces half-open sockets.

## The measurement I got backwards, recorded because it is the lesson

I tapped both sockets for 900 s, logged **one frame**, saw `connected` on open,
and reported "the bridge feeds are near-silent" to Peter and to plugins. Device
measured **6 messages in 42 s** on the same feed.

One frame in 900 s on a socket that reports connected is not a quiet peer — it
is the signature of a dead-but-open socket. The evidence was in hand and the
conclusion was inverted. **A silent feed and a detached socket are the same
observation until something distinguishes them**, which is precisely what this
watchdog and device's `servedAt` exist to do.

## What the bridge now guarantees

Device, `tick-contract-confirm`, live since 18:22 BST (their commit `41a2e6c`):

- a `tick` message on `/events` and every core feed **at least every 10 s, even
  when the mesh is completely silent**;
- `servedAt` on every pushed core body — the instant it was built;
- the interval is `--feed-tick-ms`, **default 10000, and a setting rather than a
  constant**. Confirmed to them that it is not hard-coded here.

## Why pong alone is insufficient — both halves are needed

| failure | caught by pong? | caught by silence watchdog? |
|---|---|---|
| peer vanished, no FIN | **yes** | yes |
| socket attached, peer stopped publishing | **no** — the WS layer answers pings happily | **yes** |

A pong proves the *connection* is alive. It says nothing about whether data is
flowing. `/plugin/dash/live` is a **plugin** feed and is not covered by device's
core-feed tick guarantee, so the pong is what protects that one. Implementing
only one of the two would leave a real failure mode uncovered.

## Derived thresholds — not chosen

```
PING_MS     = 10_000   one probe per guaranteed tick interval
SILENCE_MS  = 30_000   3 x the tick interval
```

`SILENCE_MS` is **3×** the bridge's declared tick, per device's instruction to
use a multiple rather than the value itself:

- 1× would fire on ordinary scheduling jitter;
- 2× would fire on a GC pause or a slow event-loop turn;
- 3× at 30 s is beyond any plausible pause, and bounds staleness from a socket
  fault at ~30 s. Against a 900 s beat that is 3% of one cycle, versus the 30+
  minutes actually observed.

Any frame resets the clock, `tick` included — a tick is proof of attachment,
which is its entire purpose. It is **not** counted as a reception anywhere
(confirmed to device); it only feeds this watchdog.

## Public interface

No new exports. `_socket(path, onMessage, onOpen)` gains an internal watchdog and
its returned teardown clears it.

## Invariants

- **`terminate()`, never `close()`.** `close()` performs a handshake with a peer
  that is not there and can hang; `terminate()` destroys the socket immediately
  and synthesises the `'close'` event the existing reconnect path already
  handles. The re-prime on reconnect is already correct (`alarm-host.js:405`:
  a reconnect must retake the snapshot "because a reconnect means we missed
  events") — only the **detection** was missing, and nothing about the recovery
  path changes here.
- **The watchdog is cleared on teardown and on close**, or a reconnect leaves the
  previous socket's timer running and each cycle adds another.
- **10 s is never hard-coded as a threshold.** It appears once, as the derived
  base, with the multiple stated beside it.

## State

Per socket: `lastMsgAt`, `awaitingPong`, and one interval handle.

## Events emitted

None new. A detected stall logs at WARN with how long the socket was silent,
because "reconnecting" with no duration reads as routine churn — which is exactly
how 38 socket closes were dismissed as noise earlier in this session.

## Test notes

`tests/test_socket_watchdog.mjs` — pure, fake clock and a stub socket:

- silence past `SILENCE_MS` calls `terminate()` exactly once;
- any message, `tick` included, resets the clock and prevents termination;
- a pong resets `awaitingPong`; a missed pong terminates;
- teardown clears the interval — a stopped socket must not keep probing.

A live end-to-end test needs a peer that dies without a FIN, which is what
`Observe` does by killing the TCP connection rather than closing it.

## Out of scope

- **Surfacing `servedAt` staleness on the page.** Confirmed to device that it
  will be, and it belongs in the same family, but it is a Domain 1 + Domain 2
  change and no fix may span domains here. This task restores the connection;
  that one tells the operator when the data behind it is stale.
- Reading `--feed-tick-ms` from the bridge rather than using the declared
  default. Asked device to expose it; until it is, the default is the base and
  the multiple absorbs the error.
