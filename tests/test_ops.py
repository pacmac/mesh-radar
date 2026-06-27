"""
test_ops.py — Manifest-driven op registry test.

Reads GET /ops/manifest, submits every op in SAFE_TO_TEST with its example_payload,
waits for a terminal WS event, and asserts success.

Run: python3 tests/test_ops.py
"""
import asyncio
import json
import os
import sys
import time

import requests
import websockets

BASE     = os.environ.get("NODE_DASH_URL", "http://localhost:8000")
MESH_GW  = os.environ.get("MESH_GW_URL", "http://localhost:8001")
WS       = BASE.replace("http", "ws") + "/events"

# Ops skipped because they reboot the radio (always or conditionally with the
# example values), affect live BLE state, require hardware not present, or have
# destructive side effects that need explicit intent.
SKIP = {
    # Rebooting radio configs
    "radio_config_network",
    "radio_config_bluetooth",
    "radio_config_position",
    "radio_config_lora",
    "radio_config_device",
    "radio_config_display",
    "radio_config_power",
    "radio_config_security",
    # BLE state
    "ble_connect",
    "ble_disconnect",
    "ble_scan",
    "ble_remove",
    # Destructive / OTA
    "wipe_nodedb",
    "flash_firmware",
    "upload_ota_file",
    "download_ota_asset",
    # Rotator hardware not always present
    "rotator_mode_pasv",
    "rotator_mode_actv",
    "rotator_move",
    "rotator_scan_start",
    "rotator_scan_abort",
    "rotator_calibrate",
    "rotator_firmware_config",
    "manual_target",
    # Live network side effects
    "send_message",
    "send_traceroute",
    "restart_mqtt_proxy",
    # Fixed position changes radio state (skip unless explicitly requested)
    "fixed_position_push",
    "fixed_position_clear",
    # Channel config changes live radio channel (skip unless explicitly requested)
    "channel_config",
    # Alert test requires SMTP to be configured
    "send_alert_test",
}

TIMEOUT_S = int(os.environ.get("OP_TIMEOUT", "20"))


async def _wait_device_ready(node_id, timeout_s=60):
    """Wait for the device to be READY in mesh-gw.

    Sleeps 5s first to let any firmware-triggered reconnect begin, then polls
    mesh-gw status every 2s until READY or timeout. One full reconnect cycle
    typically takes ~7s (RECONNECTING→DISCOVERING→SYNCING→READY).
    """
    await asyncio.sleep(5.0)
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            data = requests.get(f"{MESH_GW}/status", timeout=3).json()
            for dev in data.get("devices", []):
                if dev.get("node_id") == node_id and dev.get("state") == "READY":
                    return True
        except Exception:
            pass
        await asyncio.sleep(2.0)
    return False


def _infer_section(kind):
    """Infer the config section name from a Radio op kind, for pre-read merge."""
    if kind.startswith("radio_config_"):
        return kind[len("radio_config_"):]
    if kind.startswith("module_config_"):
        name = kind[len("module_config_"):]
        return {"canned_msg": "canned_message", "neighbor": "neighbor_info"}.get(name, name)
    return None


def get_active_node_id():
    """Return the first READY device node_id, or None."""
    try:
        data = requests.get(f"{BASE}/status", timeout=5).json()
        for dev in data.get("bridge", {}).get("devices", []):
            if dev.get("state") == "READY" and dev.get("node_id"):
                return dev["node_id"]
    except Exception:
        pass
    return None


def resolve_target(example_target, active_node_id):
    """Replace placeholder node_id in example_payload with the active device."""
    if example_target is None:
        return None
    # If it looks like a node_id (!hex), replace with active
    if isinstance(example_target, str) and example_target.startswith("!"):
        return active_node_id or example_target
    return example_target


_TRANSIENT_BLE_ERRORS = ("Service Discovery has not been performed yet", "UNLIKELY_ERROR", "Device not connected")


async def _submit_op(ws, kind, target, values, timeout_s):
    """Submit one op and wait for terminal WS event. Returns (state, error_str)."""
    r = requests.post(
        f"{BASE}/ops",
        json={"kind": kind, "target": target, "payload": {"values": values}},
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
                state = ev.get("state")
                if state in ("success", "error"):
                    return state, ev.get("error")
        except asyncio.TimeoutError:
            pass
    return "timeout", f"no terminal event within {timeout_s}s"


async def run_op(ws, kind, target, values, timeout_s, node_id=None):
    """Submit op with one automatic retry on transient BLE errors."""
    state, err = await _submit_op(ws, kind, target, values, timeout_s)
    if state == "error" and err and any(t in err for t in _TRANSIENT_BLE_ERRORS):
        # BLE transient error — wait for device to return READY then retry once
        if node_id:
            await _wait_device_ready(node_id)
        state, err = await _submit_op(ws, kind, target, values, timeout_s)
    return state, err


async def main():
    # Fetch manifest
    try:
        manifest = requests.get(f"{BASE}/ops/manifest", timeout=5).json()
    except Exception as e:
        print(f"FATAL: cannot reach {BASE}/ops/manifest — {e}")
        sys.exit(1)

    ops = manifest.get("ops", [])
    active_node = get_active_node_id()
    print(f"Active device: {active_node}")
    print(f"Total ops in registry: {len(ops)}")

    to_run = [op for op in ops if op["kind"] not in SKIP]
    skipped = [op["kind"] for op in ops if op["kind"] in SKIP]
    print(f"Testing: {len(to_run)}  Skipping: {len(skipped)}")
    if skipped:
        print(f"  Skipped: {', '.join(sorted(skipped))}")
    print()

    results = []

    async with websockets.connect(WS, open_timeout=10) as ws:
        for op in to_run:
            kind = op["kind"]
            example = op.get("example_payload") or {}
            raw_target = example.get("target")
            values = dict(example.get("values") or {})
            target = resolve_target(raw_target, active_node)

            # Radio module config ops require a full section payload.
            # Pre-read the current section and merge example overrides into it.
            section = _infer_section(kind)
            if op["class"] == "Radio" and section and active_node:
                rb_url = f"{BASE}/{active_node}/config/{section}"
                try:
                    rb = requests.get(rb_url, timeout=5).json()
                    current = rb.get(section, rb) if isinstance(rb, dict) else {}
                    if isinstance(current, dict):
                        values = {**current, **values}
                except Exception:
                    pass

            t0 = time.time()
            state, err = await run_op(ws, kind, target, values, TIMEOUT_S, node_id=active_node)
            elapsed = time.time() - t0
            # After Radio writes, wait for device to return READY (mqtt write
            # triggers a broker reconnect that briefly drops the BLE state).
            if op.get("class") == "Radio" and active_node:
                await _wait_device_ready(active_node)

            ok = state == "success"
            marker = "✓" if ok else "✗"
            detail = f" — {err}" if err else ""
            print(f"  {marker} {kind:40} {state:10} ({elapsed:.1f}s){detail}")
            results.append((kind, ok, state, err))

    passed = sum(1 for _, ok, _, _ in results if ok)
    failed = [(k, s, e) for k, ok, s, e in results if not ok]

    print()
    print("═" * 65)
    if failed:
        print(f"  RESULT: FAIL  ({passed} passed, {len(failed)} failed)")
        for k, s, e in failed:
            print(f"    ✗ {k}: {s} — {e}")
    else:
        print(f"  RESULT: PASS  ({passed}/{len(results)} ops succeeded)")
    print("═" * 65)

    sys.exit(0 if not failed else 1)


if __name__ == "__main__":
    asyncio.run(main())
