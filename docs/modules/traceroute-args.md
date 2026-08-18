---
module: traceroute-args
source:
  - src/traceroute.js
  - src/aim.js
  - src/traceroute-api.js
  - src/config-api.js
source_hash: b9d1844a7d7dff2089e3a3837e88d05f09c2ede2806ce57925b16e23c98e2666
updated: 2026-08-18
---

# The corrected argument contract

## What was misread, and by whom

Peter, 2026-08-18:

> "I misled you, when I said 3 args min, I did not mean those 3 should always be
> provided, I mean that it need at least 3. if timeout is not set, then it should
> have a default. that should be a config and not hard coded, meaning you can
> have via_node or via_bearing."

The earlier spec (`traceroute-flow.md`) read "min 3 args" as *three required
positionals*, and built `timeout` as mandatory — `run()` threw `timeout required
(ms)` and `POST /traceroute` answered 400 without it. That was wrong. "At least
three" describes what the function needs to KNOW, not what a caller must type.

## The contract

```js
run(radio, node, timeoutMs?, { via_node, via_bearing })
POST /traceroute { radio?, node, timeout_ms?, via_node?, via_bearing? }
```

| argument | required | default |
|---|---|---|
| `node` | **yes** | — there is nothing to trace without it |
| `radio` | no | `'auto'` — the mode's transmitter, via `resolve()` |
| `timeout_ms` | no | **`traceroute.timeout_sec` × 1000**, config |
| `via_node` / `via_bearing` | no | none — the node/relay rule applies |

`node` stays required because no default could be right: tracing "something" is
not a request.

## The timeout default is CONFIG, and it is the number that already existed

New flat key **`traceroute.timeout_sec`**, default **60**, sitting beside the
`traceroute.enabled` that is already there.

**60 is not a new number.** It is what `PASV_DEFAULTS.timeout_sec` has always
been, and `dispatch()` already used it as its fallback. This moves the same value
to a correctly-named key and makes ONE place own it, which is the rule
`dispatch()` already stated in its own comment: *"NO SECOND COPY OF THE NUMBER …
the value is declared exactly once."*

Why not keep reading `pasv_config.timeout_sec`? Because PASV is gone — the
passive tracer was deleted on 2026-08-17 — so the key now names a mode that no
longer does anything, and a general traceroute default hiding under it is exactly
the sort of misfiled constant that gets lost.

Both `run()` and `dispatch()` read the new key, so a caller that supplies no
timeout and a caller that reaches `dispatch()` directly get the same answer.

## `via` splits into `via_node` and `via_bearing`

Peter's own point: named arguments make the overloaded `via` unnecessary.

**This DELETES machinery rather than adding it.** The previous commit resolved
"is this number a bearing or a node?" with a magnitude rule (0–360 = bearing,
above = node), explicit `{node:}` / `{bearing:}` escape forms, and a collision
guard for a number that could be both. All of that existed only to disambiguate a
single overloaded field. Two named fields cannot be ambiguous, so the rule, the
escapes and the guard all go.

| field | accepts |
|---|---|
| `via_node` | `!hex` or a node num — aim at that node's bearing |
| `via_bearing` | degrees, 0–360 (360 normalises to 0) — aim there |

- **Both set → refused.** They are contradictory instructions and picking one
  would be guessing, which is the thing this change exists to stop.
- Everything else is unchanged: directional radios only, an omni ignores it and
  says so, an unresolvable `via_node` refuses rather than falling back, and the
  row records `aim_mode 'via'` (target = the node) or `'bearing'`
  (target = NULL).

## Test notes

1. `run(radio, node)` with no timeout → uses `traceroute.timeout_sec × 1000`.
2. Changing `traceroute.timeout_sec` changes the effective timeout — proving it
   is read from config and not a literal.
3. `POST` with no `timeout_ms` → 200/504 rather than 400.
4. `via_node` and `via_bearing` each behave as the old `via` did in that form.
5. Both together → 400.
6. A bare `via` is no longer accepted as a field; nothing guesses.

## Out of scope, recorded rather than done

`pasvConfig()` and `PASV_DEFAULTS` lose their last consumer with this change. The
passive tracer they were named for is already deleted. Removing them is a
separate tidy — it touches the config form's surface — and is filed in the bug
ledger rather than swept in here.
