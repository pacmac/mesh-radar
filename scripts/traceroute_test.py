#!/usr/bin/env python3
"""traceroute_test.py — quick, reusable OMNI-vs-YAGI live traceroute test.

Runs a real traceroute via each radio (OMNI/primary, then YAGI/rotator) against
one target node, and reports both the RESULT and whether the YAGI actually
aimed before transmitting — the second half is what a bare "did it work"
answer hides, and is exactly what caught the 2026-09-10 unaimed-transmit bug.

REAL AIRTIME EACH RUN, and the YAGI call physically moves the rotator (shared
with the garage alarm) and holds it for the duration. Not for automation —
matches traceroute-api.js's own "no dashboard automation added for this yet"
rule (docs/modules/traceroute-flow.md). Run it deliberately, not on a timer.

Usage:
    python3 scripts/traceroute_test.py                  # default target below
    python3 scripts/traceroute_test.py !02d4cd04         # !hex node id
    python3 scripts/traceroute_test.py 47500548          # or a plain node num
"""
import json
import sqlite3
import sys
import urllib.request
from pathlib import Path

NODE_DASH_URL = "http://localhost:8000"
DB_PATH = Path(__file__).resolve().parent.parent / "data" / "node-dash.db"

# TWEAK: the default target when none is given on the command line.
DEFAULT_TARGET = "!02d4cd04"  # Preston~Bowyer (T4), 5.3 km, num 47500548

# How long to wait for a reply before giving up, per radio. traceroute.js's
# own default (traceroute.timeout_sec config) applies when this is omitted —
# deliberately not overridden here so this test uses the same timeout as
# every other caller, rather than a second copy of the number.
TIMEOUT_MS = None


def post_traceroute(radio, node):
    body = {"radio": radio, "node": node}
    if TIMEOUT_MS is not None:
        body["timeout_ms"] = TIMEOUT_MS
    req = urllib.request.Request(
        f"{NODE_DASH_URL}/traceroute",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def latest_row(cur, to_num):
    return cur.execute(
        "SELECT id, ts, status, tx_device, rotator_az, aim_mode, aim_target, aim_az_req "
        "FROM traceroute_history WHERE to_num=? ORDER BY id DESC LIMIT 1",
        (to_num,),
    ).fetchone()


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TARGET
    to_num = int(target[1:], 16) if target.startswith("!") else int(target)

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()

    for radio in ("primary", "rotator"):
        print(f"\n=== radio={radio} -> {target} ===")
        result = post_traceroute(radio, target)
        print(json.dumps(result, indent=2))

        row = latest_row(cur, to_num)
        if row:
            _id, ts, status, tx_device, rotator_az, aim_mode, aim_target, aim_az_req = row
            print(
                f"  traceroute_history: status={status} tx_device={tx_device} "
                f"aim_mode={aim_mode} aim_target={aim_target} "
                f"aim_az_req={aim_az_req} rotator_az={rotator_az}"
            )
            if radio == "rotator" and aim_mode in (None, "", "none"):
                print(
                    "  WARNING: aim_mode is 'none' on a directional radio — this "
                    "transmitted WITHOUT aiming. See resolve-directional-ignores-"
                    "meshgw-live-antenna-flag if this recurs."
                )


if __name__ == "__main__":
    main()
