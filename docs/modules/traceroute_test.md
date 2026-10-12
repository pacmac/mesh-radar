---
module: traceroute_test
source: scripts/traceroute_test.py
source_hash: 5438c63ab68a82f1a50a7c95b2977ff192e6b5e308589bca5c0b615f668ebd72
updated: 2026-09-10
---

# Module: traceroute_test

## Purpose

A standalone, re-runnable script — not part of the running service — that
answers "does a real traceroute via each radio actually work, and did the
YAGI aim before it transmitted?" in one command, against a real target node.
It is not a passive analysis: it transmits real RF on both radios each run.

Built the moment after the 2026-09-10 live investigation that found the
unaimed-transmit bug (`resolve-directional-ignores-meshgw-live-antenna-flag`)
— Peter asked for a script so that check doesn't have to be rebuilt by hand
from curl and sqlite3 every time.

## Responsibilities

- POST `/traceroute` on node-dash's own API (`radio: 'primary'` then
  `radio: 'rotator'`, in that order — sequential, never parallel, because the
  rotator/BLE session is shared) against one target node.
- Print the raw API response for each.
- Read back the resulting row from `traceroute_history` and print
  `aim_mode`/`aim_target`/`aim_az_req`/`rotator_az` alongside it — a bare
  `ok`/`timeout` result does not say whether the directional radio was
  actually pointed, which is exactly what the 2026-09-10 bug hid.
- Warn explicitly if a `rotator` run comes back with `aim_mode` empty/`none`
  — the signature of that same bug recurring.

## Dependencies

- node-dash's own running service (`http://localhost:8000`), specifically
  `POST /traceroute` (`src/traceroute-api.js`).
- `data/node-dash.db` (`traceroute_history`), read-only.

## Public interface

```
python3 scripts/traceroute_test.py                  # default target (see below)
python3 scripts/traceroute_test.py !02d4cd04         # !hex node id
python3 scripts/traceroute_test.py 47500548          # or a plain node num
```

`DEFAULT_TARGET` at the top of the file is Preston~Bowyer (`!02d4cd04`, 5.3 km)
— the node used in the 2026-09-10 investigation. `TIMEOUT_MS` is left `None`
deliberately, so the test uses the same `traceroute.timeout_sec` config every
other caller does rather than a second copy of the number.

## State

None — read-only against the DB. It DOES transmit real RF and move the
rotator; that is the point of the script, not a side effect to avoid.

## Events emitted

N/A — prints to stdout only.

## Invariants

- Never runs the two radios in parallel — the rotator (and mesh-gw's BLE
  session) is shared, and a second command mid-aim is exactly the race this
  whole investigation was about.
- Never overrides the configured timeout with a literal — see `TIMEOUT_MS`
  above.
- Not wired into any schedule or dashboard automation
  (`docs/modules/traceroute-flow.md`: "no dashboard automation will be added
  for this yet").

## Test notes

Run 2026-09-10 against Preston~Bowyer: OMNI succeeded (6.5 s, one relay hop);
YAGI's `aim_mode` correctly showed `relay`/212° (post-fix) rather than `none`
— confirms the script surfaces exactly what the manual investigation found.

## Out of scope

- Does not pick a target automatically — the caller names one. Pairing it with
  `scripts/rf_hw_compare.py`'s candidate list (real, fixed, distant, non-own
  nodes) is a natural next step but not built here.
- Does not retry, queue, or run on a cadence.
