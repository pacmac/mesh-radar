# Peer succession — who to talk to, and how to read the old names

Peter, 2026-08-13: *"services is deprecated in favour of plugins. update all
references."*

This file exists so that **one** place records the succession and the ~60 dated
references scattered through `src/` and `docs/` stay readable without being
rewritten. A comment that says *"services, 2026-07-29: 15 of GARG's 131 sends
never left the radio"* is a record of who measured what and when. Changing the
name to `plugins` would make it false — plugins did not say it and did not exist
then — and would throw away the provenance that makes the comment worth keeping.

**So: names in dated attributions stay. Ownership follows this table.**

## The current map

| domain | talk to | channel |
|---|---|---|
| the mt-alarm bridge, its plugins and feeds | **plugins** | `node-dash--plugins` |
| the bridge core, firmware, decode, the pointer | **device** | `device--node-dash` |
| the mesh gateway and apiV2 | **mesh-gw** | `mesh-gw--node-dash` |
| ~~alarm backend, images, obs, align, queue~~ | ~~services~~ | **frozen — do not raise new items** |

## What happened

- **2026-08-12 09:35Z** — `pac-host` STOPPED under pm2 and `pm2 save`d. It will
  not return on a reboot. Verify: `curl -s -o /dev/null -w '%{http_code}'
  http://127.0.0.1:8787/v1/mesh/devices` → `000`.
- **2026-08-12** — plugins introduced themselves (`node-dash--plugins` #1):
  *"A new party, `plugins`, at mt-alarm/plugins. **Services is frozen.**
  Everything that used to be a pac-host route now either lives on device's bridge
  or comes from a plugin loaded INTO that bridge."*
- **2026-08-13 07:02Z** — plugins deleted seven GET routes on Peter's live-data
  rule and replaced them with WS feeds under `/plugin/<name>/<feed>`.

## Reading an old reference

| the comment says | read it as |
|---|---|
| "services, <date>: …" | a **historical measurement or statement**, still true unless re-measured. The party is gone; the fact is not |
| "services own X" / "services will …" | **stale ownership.** Look X up in the map above. These were corrected where found |
| "services' store" / "pac-host's route" | the route is gone. The bridge on `:8790` is the successor — `docs/modules/alarm-host.md` |
| "raised with services (#NN)" | the item is on `node-dash--services`, which is **frozen**. If it still matters, re-raise it on `node-dash--plugins` |

## The channel is not deleted

`node-dash--services` still holds 97 messages and is the only record of a long,
careful contract negotiation — the `grst` correction, the ms-everywhere unit
rule, the outcome-vocabulary change. **Read it; do not write to it.**

Their cursor sits at 90 of 97 as of 2026-08-13, so the last seven messages —
including node-dash's ack of the outcome-vocabulary change — were never read by
anyone. If any of it still matters, it must be re-raised with plugins rather than
assumed delivered.
