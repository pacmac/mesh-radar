#!/bin/bash
# Install node-dash as a systemd service ON WHATEVER HOST THIS REPO HAS BEEN CLONED TO.
#
#   bash deploy/install.sh            install (needs root)
#   bash deploy/install.sh --check    preflight only — writes nothing, needs no root
#
# Mirrors mesh-gw's own deploy/install.sh house style (readlink -f root derivation,
# --check, refuse-rather-than-half-work, a templated unit, a smoke test before
# enabling). node-dash is npm/Node, not pip/venv, so the dependency and smoke steps
# are this stack's equivalent rather than a line-for-line port. See
# docs/modules/deploy_install.md.

set -euo pipefail

# ── WHERE AM I ─────────────────────────────────────────────────────────────────────────
# readlink -f FIRST. Run through a symlink, a bare dirname gives the LINK's directory and
# the installer would configure a tree that is not the checkout.
REPO="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"

CHECK_ONLY=0
SMOKE_ONLY=0
case "${1:-}" in
  --check)       CHECK_ONLY=1 ;;
  --smoke-only)  SMOKE_ONLY=1 ;;  # test hook: runs preflight + the data dir + the
                                   # smoke step alone, skipping npm install and the
                                   # systemd unit entirely. Never used by a real
                                   # install — tests/test_deploy_install.mjs only.
esac

UNIT_SRC="$REPO/deploy/node-dash.service.in"
UNIT_DST="/etc/systemd/system/node-dash.service"

# Deliberately NOT the code's own default of 8000 — see docs/modules/deploy_install.md's
# "Port choice" section. This is the one place to change it for a host whose port map
# differs (a bare host with no mesh-gw could use 8000 instead, for instance).
PORT=8003

say()  { printf '%s\n' "$*"; }
step() { printf '\n=== %s\n' "$*"; }
die()  { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }

# ── PREFLIGHT — REFUSE RATHER THAN HALF-WORK ───────────────────────────────────────────
step "preflight"
say "  repo root   : $REPO"
say "  mode        : $([[ $CHECK_ONLY == 1 ]] && echo '--check (writes nothing)' || echo install)"

[[ -f "$REPO/package.json" ]] || die "no package.json at $REPO — is this really a node-dash checkout?"
[[ -f "$REPO/src/index.js" ]] || die "no src/index.js in $REPO — this does not look like node-dash"
[[ -f "$UNIT_SRC" ]] || die "no unit template at $UNIT_SRC"
grep -q '"node-dash"' "$REPO/package.json" || die "$REPO/package.json does not name node-dash"

command -v node >/dev/null || die "node is not installed"
command -v npm  >/dev/null || die "npm is not installed"
NODE_V="$(node -v)"
say "  node        : $NODE_V ($(command -v node))"
say "  npm         : $(npm -v) ($(command -v npm))"

command -v systemctl >/dev/null \
  || die "no systemctl. This installs a systemd unit and will not guess at another init."

if [[ $CHECK_ONLY == 0 && $SMOKE_ONLY == 0 && "${EUID:-$(id -u)}" -ne 0 ]]; then
  die "must run as root (it writes $UNIT_DST). Try: sudo bash $0"
fi

say "  unit        : $UNIT_SRC -> $UNIT_DST"
say "  port        : $PORT (not the code's default of 8000 — see docs/modules/deploy_install.md)"
say "  deps        : npm install (no package-lock.json in this repo, so not npm ci)"

if [[ $CHECK_ONLY == 1 ]]; then
  step "preflight passed — nothing was written"
  say "Run without --check, as root, to install."
  exit 0
fi

# ── DEPENDENCIES ────────────────────────────────────────────────────────────────────────
if [[ $SMOKE_ONLY == 0 ]]; then
  step "npm dependencies"
  ( cd "$REPO" && npm install --omit=dev --no-audit --no-fund )
  say "  installed via npm install"
fi

# ── DATA DIRECTORY ──────────────────────────────────────────────────────────────────────
# data/ is gitignored, so a fresh clone does not have it. better-sqlite3 can create the
# DB FILE but not a missing PARENT DIRECTORY — confirmed live on pimesh.home 2026-10-11,
# "Cannot open database because the directory does not exist" — so without this, the
# smoke step below (and the real first systemd start) fails before anything useful runs.
# idiot entry install-sh-assumes-data-dir-exists.
step "data directory"
mkdir -p "$REPO/data"
say "  $REPO/data ready"

# ── DOES IT ACTUALLY RUN? ───────────────────────────────────────────────────────────────
#
# THE STEP THAT MUST NOT BE SKIPPED (mesh-gw's deploy/install.sh found four separate
# startup defects this way, each invisible to "npm install exited 0"). A dependency
# resolving is not the same claim as the app starting — better-sqlite3 is a native
# module and a host with no prebuilt binary for its arch/Node version needs to compile
# it from source; npm reports that failure as part of the install, but a corrupt or
# half-built native module can still leave `npm install` at exit 0 and die only on
# `require`/import at runtime.
#
# A throwaway port, never the real one: a re-run while a real instance is already
# listening on $PORT must not collide with it and kill the live process.
step "does it run"
# A port and pidfile unique to THIS run ($$) — a fixed path/port let one run's
# leftover process collide with the next (measured here: an earlier run's node
# outlived its `kill`, so a later run's bind failed with EADDRINUSE on the very
# port meant to be a safe, re-run-proof throwaway).
SMOKE_PORT=$((18000 + ($$ % 1000)))
rm -f "$REPO/data/.smoke-test.db" "$REPO/data/.smoke-test.db-wal" "$REPO/data/.smoke-test.db-shm"
SMOKE_LOG="$(mktemp)"
# A SIMPLE backgrounded command in THIS shell, never `( cd X && CMD & )` — that
# compound/subshell form left $! pointing at the wrong process here (measured:
# it captured a PID one less than node's real one), so `kill` hit nothing and
# node ran on forever, orphaned, holding the port for every later run.
( cd "$REPO" && exec env PORT="$SMOKE_PORT" DB_PATH="$REPO/data/.smoke-test.db" \
    node src/index.js ) > "$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!
SMOKE_OK=0
for _ in $(seq 1 20); do
  sleep 0.5
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then break; fi
  if curl -fsS -o /dev/null "http://localhost:$SMOKE_PORT/" 2>/dev/null \
     || curl -s -o /dev/null -w '%{http_code}' "http://localhost:$SMOKE_PORT/" 2>/dev/null | grep -qE '^[0-9]+$'; then
    SMOKE_OK=1
    break
  fi
done
# SIGTERM first, SIGKILL if it is still alive after a moment — a kill that is not
# verified is exactly how the stale process above got left running.
kill "$SMOKE_PID" 2>/dev/null || true
for _ in $(seq 1 6); do
  kill -0 "$SMOKE_PID" 2>/dev/null || break
  sleep 0.5
done
kill -9 "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true
rm -f "$REPO/data/.smoke-test.db" "$REPO/data/.smoke-test.db-wal" "$REPO/data/.smoke-test.db-shm"

if [[ $SMOKE_OK == 1 ]]; then
  say "  node-dash started and answered on :$SMOKE_PORT"
else
  say "  --- smoke log ---"
  sed 's/^/  /' "$SMOKE_LOG"
  rm -f "$SMOKE_LOG"
  die "node-dash did not come up within 10s (above). Nothing has been enabled — a unit
         that cannot start is worse than no unit: systemd would retry it forever and the
         real cause would be buried in the journal."
fi
rm -f "$SMOKE_LOG"

if [[ $SMOKE_ONLY == 1 ]]; then
  step "smoke-only passed — nothing else was done"
  exit 0
fi

# ── THE UNIT, GENERATED FROM THE DERIVED ROOT ──────────────────────────────────────────
step "systemd unit"
sed -e "s|@@REPO@@|$REPO|g" -e "s|@@PORT@@|$PORT|g" "$UNIT_SRC" > "$UNIT_DST"
grep -q '@@' "$UNIT_DST" && die "unit still contains an unsubstituted placeholder: $(grep -o '@@[A-Z_]*@@' "$UNIT_DST" | sort -u | tr '\n' ' ')"
systemctl daemon-reload
systemctl enable node-dash -q
say "  wrote $UNIT_DST and enabled node-dash"

# ── DONE. ENABLED, NOT STARTED, AND THAT IS DELIBERATE ─────────────────────────────────
# mesh_gw.send_key is specific to THIS host's own mesh-gw instance and cannot be seeded
# by this script (see docs/modules/deploy_install.md). Starting now would come up fine
# for receiving, but every send would be refused by mesh-gw's send_auth with no
# indication from this installer of why.
step "done"
cat <<EOF
node-dash is installed and enabled, but NOT started.

  1. start it once to create data/node-dash.db:
       systemctl start node-dash
  2. get an x-mesh-gw-key from this host's mesh-gw (send_auth) — there is no HTTP
     route for this key (deliberately: config-api.js only exposes keys it knows
     about, and this one is not registered there), so it is set directly, the same
     way it was on the dev box (config.value is a JSON-encoded string):
       sqlite3 $REPO/data/node-dash.db \\
         "INSERT OR REPLACE INTO config (key, value) VALUES ('mesh_gw.send_key', '\"<key>\"');"
     (until then, node-dash receives and displays normally; every outbound send is
      refused by mesh-gw with 401)
  3. restart to pick it up, and check the log:
       systemctl restart node-dash
       systemctl status node-dash
       journalctl -u node-dash -f

  the HTTP API will be on port $PORT.
EOF
