---
module: deploy_install
source:
  - deploy/install.sh
  - deploy/node-dash.service.in
source_hash: a1cda7724f2da31242059492e0b01adadd1402f28271403cee43c02d892fc70d
updated: 2026-10-11
---

# Module: deploy_install

## Purpose

Install node-dash as a systemd service ON WHATEVER HOST THIS REPO HAS BEEN CLONED TO.
Mirrors mesh-gw's own `deploy/install.sh` house style exactly (`docs/gw/` — same
repo-relative-root derivation, `--check` preflight mode, refuse-rather-than-half-work,
a templated unit file, a smoke test before enabling). node-dash is npm/Node, not
pip/venv, so the dependency and smoke-test steps are the Node equivalents rather than
a line-for-line port.

```
bash deploy/install.sh            install (needs root)
bash deploy/install.sh --check    preflight only — writes nothing, needs no root
```

## Responsibilities

- Verify this host has Node.js and npm, and that the checkout looks like node-dash
  (refuses otherwise, never guesses).
- `npm install` (not `npm ci` — no `package-lock.json` exists in this repo).
- Prove the install actually runs — start node-dash briefly, poll its own HTTP port,
  kill it — BEFORE writing or enabling the systemd unit. An install that reports
  success and cannot start is worse than no install (same principle as mesh-gw's
  `deploy/smoke.py` step).
- Generate `/etc/systemd/system/node-dash.service` from `deploy/node-dash.service.in`
  by substituting `@@REPO@@`, `@@PORT@@`.
- Enable, but do NOT start, the unit. Two things only the operator knows are not yet
  set, and starting now would just confirm that with a wall of errors: `mesh_gw.send_key`
  (this host's own mesh-gw instance issues its own key — the dev box's will not work
  here) and, if this host's mesh-gw core is not on `localhost:8001`, `BRIDGE_URL`.

## Dependencies

- `node`, `npm` (checked; refuses if absent)
- `systemctl` (checked; refuses if absent — this installs a systemd unit and will not
  guess at another init)
- build tools (`python3`, `make`, `g++`) are NOT installed by this script — they are
  only needed if `better-sqlite3` has no prebuilt binary for this host's arch/Node
  version, and `npm install` fails with a clear node-gyp error if that happens and
  they are missing. Not pre-emptively apt-installed the way mesh-gw installs its own
  (always-needed) C-extension toolchain, because node-dash usually does NOT need them
  — most hosts get a prebuilt `better-sqlite3` binary and paying the apt cost
  unconditionally would be pure waste.

## Port choice — `PORT=8003` on a Pi running mesh-gw, not the code's own default of 8000

`src/index.js`/`src/op-manager.js` default `PORT` to **8000** when unset. On a bare
host that is fine. On a host that ALSO runs mesh-gw (this install script's actual use
case, measured on `pimesh.home`), 8000 is mesh-gw's OWN reserved port for its
`mesh-dashboard.service` (a static file server, currently uninstalled on that Pi but
documented and real in mesh-gw's own repo) and 8001 is mesh-gw's core HTTP API,
already running there. `deploy/node-dash.service.in` hardcodes `PORT=8003` via the
unit's `Environment=` line, leaving 8000/8001/8002 (the latter mesh-gw's own
documented second-instance/emulator convention — see node-dash's `src/emulator.js`
comment) to mesh-gw. This is NOT configurable by this script — it is one value in
the `.service.in` template, changed there if a host's port map differs.

## What is NOT seeded, and why

- **`mesh_gw.send_key`.** Stored in node-dash's own SQLite `config` table
  (`mesh_gw.send_key`, JSON-string-encoded — see `docs/modules/bridge.md`), not an
  env var, not a file this installer can template. It is specific to the mesh-gw
  instance a given node-dash talks to; the dev box's key is meaningless to a
  different mesh-gw instance. Node-dash starts and receives perfectly well without
  it — only transmits (`bridge.js`, `mesh-send.js`) are refused by mesh-gw's
  `send_auth` until it is set. The installer prints this as the first follow-up step.
- **`BRIDGE_URL`/`BRIDGE_WS_URL`.** Default to `http://localhost:8001`/
  `ws://localhost:8001` (`src/bridge.js`), which is correct whenever node-dash and
  its mesh-gw run on the same host (the Pi case this was written for). Left
  unset in the unit; a host where mesh-gw lives elsewhere overrides them there.
- **`DB_PATH`.** Defaults to `<repo>/data/node-dash.db` (`src/db.js`), which is
  always correct for a single-instance-per-host deploy. The DEV box's pm2 process
  happens to point at a different, historical path — that is dev-box cruft, not a
  convention to replicate, and this installer does not carry it forward.
- **`ROTATOR_WS_URL`/`ROTATOR_V5_WS_URL`.** Present in the dev box's
  `ecosystem.config.cjs` but DEAD — zero references anywhere in `src/*.js` (checked
  2026-10-11; `rotator.js` was deleted, mesh-gw's `aim` plugin owns rotator
  commanding now). Not carried into the unit.

## Invariants

- Refuses rather than half-installs: a missing `node`/`npm`/`systemctl`, a checkout
  that does not look like node-dash, or an app that cannot actually start all stop
  the script before anything is written.
- The systemd unit is never enabled until the smoke step has proven the app starts
  in THIS checkout, on THIS host.
- Idempotent: safe to re-run. `npm install` is naturally idempotent; the unit file
  is regenerated and re-written every run (it carries no host-specific state a
  re-run could destroy, unlike mesh-gw's `bridge_config.yaml`).
- Installed, enabled, **not started** — the operator sets `mesh_gw.send_key` (and
  `BRIDGE_URL` if needed) and starts it themselves, exactly as mesh-gw's own
  installer leaves BLE radio addresses for the operator rather than starting on
  placeholders.

## Test notes

- `bash deploy/install.sh --check` on a clean checkout: writes nothing, reports
  Node/npm versions and the smoke-step plan, exits 0.
- A full install on `pimesh.home`: `npm install` completes, the smoke step starts
  node-dash, confirms a response on its own port, kills it cleanly, writes
  `/etc/systemd/system/node-dash.service` with no unsubstituted `@@` markers,
  `systemctl daemon-reload` + `enable` succeed, service is enabled and inactive.
- `tests/test_deploy_install.mjs` simulates a real fresh clone (a scratch copy
  with `node_modules` symlinked but **no `data/` directory at all**, exactly
  what `git clone` produces since `data/` is gitignored) via a `--smoke-only`
  test hook that runs preflight + the data dir + the smoke step alone, never
  touching systemd. This caught two real defects live against `pimesh.home`
  before they could have stopped a real install:
  - **`data/` did not exist.** better-sqlite3 cannot create a missing PARENT
    directory, only the db file inside one. Fixed: `mkdir -p "$REPO/data"`
    before the smoke step. idiot entry `install-sh-assumes-data-dir-exists`.
  - **A fresh database had no `nodeinfo.address` column**, and a one-time
    migration assumed it did — `docs/modules/db.md`'s Geocode cache section,
    idiot entry `geocode-cache-backfill-breaks-fresh-database`. Nobody had
    started node-dash against a truly empty database before this smoke test
    did.
  - (fixed during the same investigation, no separate idiot entry: the smoke
    step's own process-management was backgrounding via `( cd X && CMD & )`,
    a compound/subshell form that left `$!` pointing at the wrong PID, so
    `kill` silently missed the real node process and it ran on orphaned,
    holding the throwaway port for every subsequent run. Rewritten as a
    simple backgrounded command with `exec` inside its subshell, SIGTERM then
    SIGKILL, and a run-unique port derived from `$$`.)
