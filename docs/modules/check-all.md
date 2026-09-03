---
module: check-all
source:
  - scripts/check_all.mjs
  - package.json
source_hash: 9a0b363f270ccc643b74bef7c07d0244835a0c20e7e4d7693310fdc97da9b77c
updated: 2026-09-03
---

# Module: check-all

## Purpose

One command that runs every check this repo owns, names the ones it did not run,
and exits non-zero if any failed.

Ledger `B96`: eleven checks exist and **nothing invokes any of them**.
`package.json` had only `start` and `dev`; there is no Makefile, no justfile, no
`tox.ini`, no `.github/workflows`, and `ls .git/hooks | grep -v sample` is empty.
Three checks broke on 2026-08-13 and stayed broken for hours with no red signal
anywhere — they were found by a handover running them by hand, which is not a
mechanism.

## Responsibilities

- Run the checks, in groups, in cost order — cheapest first, so a broken repo
  fails in under a second rather than after six minutes of browser work.
- **Name what it did not run, and why.** A check omitted silently is a check that
  gets forgotten and then rewritten. This is the rule the whole file exists for.
- Exit 1 if any check fails. Never "expected failure", never a suppression list.

## Dependencies

- Nothing new. `node:child_process` and the checks themselves.

## Public interface

```
node scripts/check_all.mjs [--group fast|service|slow|all] [--list]
npm run check       # fast + service   (the default gate)
npm test            # alias of check
npm run check:all   # fast + service + slow
npm run check:list  # print the inventory and run nothing
```

## The inventory — all eleven, with what each needs

Runtimes measured 2026-08-13 on this machine, service up, warm 700 MB store.

| check | group | needs | measured | timeout |
|---|---|---|---|---|
| `scripts/check_specs.py` | fast | — | 82 ms | 30 s |
| `tests/test_observatory_boundary.mjs` | fast | — | 40 ms | 30 s |
| `tests/test_channel_write.mjs` | fast | — | 30 ms | 30 s |
| `tests/test_op_manager.mjs` | fast | — | 140 ms | 30 s |
| `tests/test_served_time.mjs` | fast | — | 120 ms | 30 s |
| `tests/test_channels.mjs` | fast | — | 67 ms | 30 s |
| `tests/test_send_channel.mjs` | fast | — | 212 ms | 30 s |
| `scripts/check_snapshot.mjs` | service | node-dash up | 3,889 ms | 30 s |
| `scripts/check_contract.mjs` | service | node-dash up | 5,148 ms | 60 s |
| `scripts/check_no_cache.mjs` | service | node-dash up | 200 ms | 30 s |
| `tests/test_node.py` | service | node-dash up | ~35 s | 180 s |
| `tests/test_doors.mjs` | service | the store | 150 ms | 30 s |
| `tests/test_page_snapshot.py` | slow | node-dash + browser | measured in Observe | 600 s |
| `tests/test_playwright.py` | slow | node-dash + browser | measured in Observe | 600 s |
| `tests/test_ops.py` | **unsafe** | **a live radio** | not run | — |

> `test_served_time.mjs` and `check_no_cache.mjs` were registered in
> `check_all.mjs` but missing from this table, and `test_channels.mjs` was added
> 2026-08-14. A table that claims to list the checks and does not is the same
> failure as a check nothing invokes — the reader trusts it and stops looking.
>
> This table has drifted repeatedly and is now materially behind the runner —
> `interval_tables`, `interval_options`, `no_channel_resolver`, `resolve`,
> `aim`, `traceroute_flow`, `transport_encoding`, `reply_snippet` and `doors`
> are all registered and only the last is listed (`radio_admin` was itself
> removed 2026-09-03, task `devices-removal-residue-cleanup` — its subject,
> src/radio-admin.js, is deleted). **The runner is the
> inventory; `npm run check:list` prints it.** Reconciling the table is a task of
> its own and is not attempted here — recorded rather than silently left, because
> the failure this file exists to prevent is exactly a list nobody notices is
> stale.

`doors` is in the **service** group because it reads the live store, not because
it needs HTTP — same placement and same reason as `transport_encoding`. It exits
127 when the db or driver is missing, which the register reads as a mistrial
rather than a conviction.

**Timeouts are derived, with a floor.** Each is ~6-12x the measured runtime,
except that anything under a second gets a 30 s floor: below that, process
startup dominates and a tighter bound would be testing the machine rather than
the code.

## Invariants

- **`tests/test_ops.py` is never run by the runner.** It writes real radio config
  — `radio_config_section:*` and `owner_info` PUTs, unconditional, no guard and
  no dry-run. On 2026-08-13 every write returned `503 Device not connected
  (state=RECONNECTING)`, so nothing was written; the test was saved by the
  device being down, not by any safety in the test. It is listed by the runner
  as excluded, with that reason, and must be invoked by hand and on purpose
  (ledger `B94`).
- **`tests/test_node.py` is read-only as invoked**, and this was checked rather
  than assumed: its `rest_check` helper has POST and DELETE branches but is never
  called with either, and the one destructive block (`POST /purge-nodedb`) is
  gated behind `PURGE_TEST=1`. The runner never sets it. Control: 1,034 rows in
  `nodes` before and after a full run on 2026-08-13.
- **A failing check makes the run red.** `test_node.py` fails today for `B92`
  (the ~13.2 MB WS connect replay disconnects any client on default frame
  limits) and `B93` (typed `traceroute` event unhandled in `index.js`). The
  runner prints those ledger ids beside the failure so the reader knows the cause
  is recorded — and still counts it as a failure. Annotating why something failed
  is not the same as excusing it, and there is no mechanism here that could grow
  into a suppression list.
- **Nothing under `reference/` is run.** `reference/alarm-integration/` holds
  three `.mjs` tests, and its own `INVENTORY.md` states: *"Nothing in this
  directory is loaded, served, tested, or imported by node-dash."* They no longer
  execute (`node tests/test_capture_api.mjs` from that directory exits on a
  module error). Archive, not check.

## State

_N/A — a process runner. It holds nothing between runs._

## Events emitted

_N/A_

## Test notes

The runner's own correctness has one requirement that matters: **it must fail
when a check fails.** A runner that reports green regardless is worse than no
runner, because it converts an absent signal into a false one. Proven by
breaking a check and confirming the runner goes red and exits 1 — see the task's
Observe phase.

## Out of scope

- Making anything invoke the runner automatically — a git hook, a cron, a CI
  file. That is a separate decision with a blast radius (a pre-commit hook that
  needs the service up would block commits whenever node-dash is down), and it is
  Peter's call. The runner is the prerequisite either way.
- Fixing `B92` or `B93`. The runner exists to make them visible, and they stay
  red until they are fixed.
- `tests/test_ops.py`'s lack of a dry-run mode (`B94`).

---

## Implementation

### NEW `scripts/check_all.mjs`

A declared table of the eleven checks — `cmd`, `args`, `group`, `needs`,
`timeoutMs`, and for the excluded one a `reason`. Then:

1. `--list` prints the table and exits 0 without running anything.
2. For the selected groups, spawn each check in order with its own timeout,
   inheriting stdio suppressed to a buffer; print one line per check as it
   finishes — `ok` / `FAIL` / `TIMEOUT`, with elapsed ms.
3. On failure, print the check's last 15 lines of output, so the run is
   actionable without a second invocation.
4. Print the excluded checks by name and reason, every time, including on a
   fully green run.
5. Summary: counts, then exit 1 if any failed.

### `package.json`

```
"scripts": {
  "start":      "node src/index.js",
  "dev":        "node --watch src/index.js",
  "check":      "node scripts/check_all.mjs --group fast,service",
  "check:all":  "node scripts/check_all.mjs --group all",
  "check:list": "node scripts/check_all.mjs --list",
  "test":       "npm run check"
}
```

`start` and `dev` are unchanged.

## Files deliberately NOT changed

- Every check itself. This task adds an invoker; it does not touch what is
  invoked.
- `.git/hooks/`, and no CI file is created — see Out of scope.
