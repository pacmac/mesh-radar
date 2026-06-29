"""
test_ops.py — Manifest-driven op registry test.

GET /ops/manifest drives the op list.
GET /sections drives the radio_config_section expansion — section names are
never hardcoded in this file.

Run: python3 tests/test_ops.py
"""
import asyncio
import json
import os
import sys
import time

import requests
import websockets

BASE    = os.environ.get("NODE_DASH_URL", "http://localhost:8000")
WS      = BASE.replace("http", "ws") + "/events"

# Op kinds skipped entirely.
SKIP_OPS = {
    # BLE lifecycle — changes connected device state
    "ble_connect",
    "ble_disconnect",
    # Destructive
    "wipe_nodedb",
    # Rotator hardware not always present
    "rotator_mode_pasv",
    "rotator_mode_actv",
    "rotator_move",
    "rotator_scan_start",
    "rotator_scan_abort",
    # Live network / RF side effects
    "send_message",
    "send_traceroute",
    # Fixed position changes radio state
    "fixed_position_push",
    "fixed_position_clear",
    # Overwrites real coordinates with placeholder
    "home_position",
    # Changes live radio channel
    "channel_config",
    # Requires SMTP to be configured
    "send_alert_test",
}

# Sections skipped within radio_config_section expansion.
# These sections always reboot the device even when values are unchanged,
# which disrupts the rest of the test run.
SKIP_SECTIONS = {
    "network",    # always reboots
    "bluetooth",  # always reboots
    "position",   # always reboots
}

TIMEOUT_S = int(os.environ.get("OP_TIMEOUT", "20"))


def get_active_node_id():
    """Return the first READY device node_id from node-dash /status, or None."""
    try:
        data = requests.get(f"{BASE}/status", timeout=5).json()
        for dev in data.get("bridge", {}).get("devices", []):
            if dev.get("state") == "READY" and dev.get("node_id"):
                return dev["node_id"]
    except Exception:
        pass
    return None



def resolve_target(example_target, active_node_id):
    """Replace placeholder !hex node_id with the active device."""
    if example_target is None:
        return None
    if isinstance(example_target, str) and example_target.startswith("!"):
        return active_node_id or example_target
    return example_target


def pre_read_section(base, node_id, section):
    """Fetch current section values to write back unchanged."""
    try:
        rb = requests.get(f"{base}/{node_id}/config/{section}", timeout=5).json()
        current = rb.get(section, rb) if isinstance(rb, dict) else {}
        return current if isinstance(current, dict) else {}
    except Exception:
        return {}


async def _submit_op(ws, kind, target, payload, timeout_s):
    """POST /ops and wait for terminal config_op WS event. Returns (state, error)."""
    r = requests.post(
        f"{BASE}/ops",
        json={"kind": kind, "target": target, "payload": payload},
        timeout=10,
    )
    if not r.ok:
        return "submit_error", f"HTTP {r.status_code}: {r.text[:100]}"
    op_id = r.json().get("op_id")
    if not op_id:
        return "submit_error", "no op_id in response"

    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
            ev = json.loads(raw)
            if ev.get("type") == "config_op" and ev.get("op_id") == op_id:
                if ev.get("state") in ("success", "error"):
                    return ev["state"], ev.get("error")
        except asyncio.TimeoutError:
            pass
    return "timeout", f"no terminal event within {timeout_s}s"


async def main():
    # ── Fetch manifest ────────────────────────────────────────────────────────
    try:
        manifest = requests.get(f"{BASE}/ops/manifest", timeout=5).json()
    except Exception as e:
        print(f"FATAL: cannot reach {BASE}/ops/manifest — {e}")
        sys.exit(1)

    # ── Fetch section list (SSOT — never hardcoded here) ─────────────────────
    try:
        sec_resp = requests.get(f"{BASE}/sections", timeout=5).json()
    except Exception as e:
        print(f"FATAL: cannot reach {BASE}/sections — {e}")
        sys.exit(1)

    all_sections = sec_resp.get("config", []) + sec_resp.get("module_config", [])

    active_node = get_active_node_id()
    print(f"Active device : {active_node}")
    print(f"Total sections: {len(all_sections)}")

    ops_by_kind = {op["kind"]: op for op in manifest.get("ops", [])}

    # ── Build test cases ───────────────────────────────────────────────────────
    # radio_config_section is expanded into one case per section using the
    # section list from GET /sections above.
    test_cases = []

    for kind, op in ops_by_kind.items():
        if kind in SKIP_OPS:
            continue

        if kind == "radio_config_section":
            for section in all_sections:
                if section in SKIP_SECTIONS:
                    continue
                values = pre_read_section(BASE, active_node, section) if active_node else {}
                test_cases.append({
                    "label": f"radio_config_section:{section}",
                    "kind": kind,
                    "target": active_node,
                    "payload": {"section": section, "values": values},
                    "timeout_s": op["timeout_s"],
                })
        else:
            example = op.get("example_payload") or {}
            test_cases.append({
                "label": kind,
                "kind": kind,
                "target": resolve_target(example.get("target"), active_node),
                "payload": {"values": dict(example.get("values") or {})},
                "timeout_s": op["timeout_s"],
            })

    skipped_ops  = [k for k in ops_by_kind if k in SKIP_OPS]
    skipped_secs = [s for s in all_sections if s in SKIP_SECTIONS]
    print(f"Test cases    : {len(test_cases)}")
    print(f"Skipped ops   : {len(skipped_ops)} ({', '.join(sorted(skipped_ops))})")
    print(f"Skipped secs  : {len(skipped_secs)} ({', '.join(sorted(skipped_secs))})")
    print()

    results = []

    async with websockets.connect(WS, open_timeout=10, max_size=10 * 1024 * 1024) as ws:
        for tc in test_cases:
            t0 = time.time()
            state, err = await _submit_op(ws, tc["kind"], tc["target"], tc["payload"], tc["timeout_s"])
            elapsed = time.time() - t0
            ok = state == "success"
            marker = "✓" if ok else "✗"
            detail = f" — {err}" if err else ""
            print(f"  {marker} {tc['label']:45} {state:12} ({elapsed:.1f}s){detail}")
            results.append((tc["label"], ok, state, err))

    passed = sum(1 for _, ok, _, _ in results if ok)
    failed = [(k, s, e) for k, ok, s, e in results if not ok]

    print()
    print("═" * 70)
    if failed:
        print(f"  RESULT: FAIL  ({passed} passed, {len(failed)} failed)")
        for k, s, e in failed:
            print(f"    ✗ {k}: {s} — {e}")
    else:
        print(f"  RESULT: PASS  ({passed}/{len(results)} cases succeeded)")
    print("═" * 70)

    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    asyncio.run(main())
