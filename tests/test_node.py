#!/usr/bin/env python3
"""
node-dash API test script — step 7 of api-sync-test plan.

Two parts:
 A. Static analysis — grep source files for known mismatches vs GW_API.md.
 B. Live — connect to node-dash WS /events, collect 30s, validate event schemas.
    Also validates node-dash REST endpoints.

Exits 0 if all PASS/SKIP, non-zero on any FAIL.
"""

import asyncio
import json
import os
import re
import sys
import time
import requests
import websockets

BASE         = "http://localhost:8000"
WS_URL       = "ws://localhost:8000/events"
SRC_DIR      = os.path.join(os.path.dirname(__file__), "..", "src")
PUBLIC_DIR   = os.path.join(os.path.dirname(__file__), "..", "public")
COLLECT_SECS = 30

# ─────────────────────────────────────────────────────────────────────────────
# Reporting
# ─────────────────────────────────────────────────────────────────────────────

results = []

def report(status, subject, detail=""):
    tag = {"PASS": "✓", "FAIL": "✗", "SKIP": "○", "WARN": "⚠"}.get(status, status)
    line = f"  [{tag}] {status:7s} {subject}"
    if detail:
        line += f"  — {detail}"
    results.append((status, subject, detail))
    print(line)

def section(title):
    print(f"\n{'─'*65}")
    print(f"  {title}")
    print(f"{'─'*65}")

# ─────────────────────────────────────────────────────────────────────────────
# File reading helpers
# ─────────────────────────────────────────────────────────────────────────────

def read_src(filename):
    path = os.path.join(SRC_DIR, filename)
    try:
        with open(path) as f:
            return f.read()
    except Exception as e:
        return ""

def read_pub(filename):
    path = os.path.join(PUBLIC_DIR, filename)
    try:
        with open(path) as f:
            return f.read()
    except Exception as e:
        return ""

# ─────────────────────────────────────────────────────────────────────────────
# A. Static analysis
# ─────────────────────────────────────────────────────────────────────────────

def static_checks():
    section("Static Analysis — Source Mismatches")

    # ── index.js ──────────────────────────────────────────────────────────────
    index = read_src("index.js")

    # 1. ev.device used for packet events — should be ev.addr || ev.device
    # GW_API.md: packet events use 'addr' not 'device'
    # Lines doing ev.device on a packet context (no || ev.addr fallback)
    device_only = re.findall(r'ev\.device(?!\s*\|\|)', index)
    if device_only:
        count = len(device_only)
        report("FAIL", "index.js: ev.device (no fallback)",
               f"{count} occurrence(s) — packet events use ev.addr; use (ev.addr || ev.device)")
    else:
        report("PASS", "index.js: ev.device fallback", "all uses have || ev.addr fallback")

    # Check specifically the known bad lines (668, 669, 689, 693)
    lines = index.splitlines()
    bad_lines = []
    for i, line in enumerate(lines, 1):
        if 'ev.device' in line and '|| ev.device' not in line and 'ev.addr' not in line and '??' not in line:
            if any(kw in line for kw in ['device', 'rotatorId', 'touchLastHeard', 'handlePacket', 'setTraceroute', 'yagiOnly']):
                bad_lines.append((i, line.strip()))
    if bad_lines:
        detail = "; ".join(f"L{n}: {l[:60]}" for n, l in bad_lines)
        report("FAIL", "index.js: packet handler uses ev.device without addr fallback",
               f"{len(bad_lines)} line(s): {detail}")
    else:
        report("PASS", "index.js: packet ev.device lines", "no issues found")

    # 2. node_info event type check (dead code)
    if "ev.type === 'node_info'" in index:
        report("WARN", "index.js: node_info dead code",
               "ev.type === 'node_info' found — new gw never emits this; handler is dead code")
    else:
        report("PASS", "index.js: node_info", "not referenced")

    # ── passive-tracer.js ──────────────────────────────────────────────────────
    tracer = read_src("passive-tracer.js")

    # 3. !ev.device guard in passive-tracer V1 path blocks all dispatches
    if "!ev.device" in tracer:
        report("FAIL", "passive-tracer.js: !ev.device guard",
               "Line 95: `if (!pkt?.from || !ev.device)` — ev.device always undefined with new gw; "
               "V1 passive trace dispatch is permanently blocked")
    else:
        report("PASS", "passive-tracer.js: !ev.device guard", "not found")

    # ── traceroute.js ──────────────────────────────────────────────────────────
    traceroute = read_src("traceroute.js")

    # 4. traceroute.js portnum check — portnum IS string from gw (MessageToDict normalises enums)
    # Check that traceroute.js gets CALLED with route_discovery data (it doesn't via raw packet)
    if "route_discovery" in traceroute:
        # Check if index.js handles the typed 'traceroute' event to feed traceroute.handlePacket
        has_typed_traceroute_handler = "ev.type === 'traceroute'" in index or "'traceroute'" in index and "handlePacket" in index
        if has_typed_traceroute_handler:
            report("PASS", "traceroute.js: typed traceroute event handled", "index.js routes traceroute → handlePacket")
        else:
            report("FAIL", "traceroute.js: typed traceroute event not handled in index.js",
                   "gw emits 'traceroute' typed event with data.route_discovery; "
                   "raw packet has no route_discovery; index.js must handle typed event and call traceroute.handlePacket")
    else:
        report("PASS", "traceroute.js: route_discovery", "not referenced (unexpected)")

    # ── ws-relay.js ────────────────────────────────────────────────────────────
    relay = read_src("ws-relay.js")

    # 5. device_removed handled but never emitted by new gw
    if "device_removed" in relay:
        report("WARN", "ws-relay.js: device_removed",
               "Handles ev.type === 'device_removed' but new gw never emits this event; "
               "deleted devices stay in device_list until WS reconnect")
    else:
        report("PASS", "ws-relay.js: device_removed", "not present")

    # 6. STATE_EVENT_TYPES: device_state and device_data should not fall through to broadcast
    if "STATE_EVENT_TYPES" in relay:
        idx = relay.find("STATE_EVENT_TYPES.has(ev.type)")
        block = relay[idx:idx+3000] if idx >= 0 else ""
        # Find the closing brace of the if block (the return is after broadcastDeviceList)
        if "broadcastDeviceList();" in block and "return;" in block:
            # Check return comes after broadcastDeviceList in the block
            bi = block.find("broadcastDeviceList();")
            ri = block.find("return;", bi)
            if ri > bi and ri - bi < 40:
                report("PASS", "ws-relay.js: STATE_EVENT_TYPES", "has early return after device_list broadcast")
            else:
                report("WARN", "ws-relay.js: STATE_EVENT_TYPES no early return",
                       "device_state/device_data events update device_list but ALSO fall through to broadcast(ev) — "
                       "browser receives both device_list and raw event")
        else:
            report("WARN", "ws-relay.js: STATE_EVENT_TYPES no early return",
                   "device_state/device_data events update device_list but ALSO fall through to broadcast(ev) — "
                   "browser receives both device_list and raw event")

    # ── app-ws.js (browser) ────────────────────────────────────────────────────
    appws = read_pub("app-ws.js")

    # 7. Browser portnum comparisons — gw uses string enums (MessageToDict), so string comparisons are CORRECT
    portnum_strings = re.findall(r"portnum\s*===?\s*'([A-Z_]+_APP)'", appws)
    if portnum_strings:
        report("PASS", "app-ws.js: portnum comparisons",
               f"String comparisons {portnum_strings} are correct — gw normalises portnum to enum name string")
    else:
        report("PASS", "app-ws.js: portnum comparisons", "no portnum comparisons found")

    # 8. Browser old state event type list (_applyStateEvent)
    old_states = re.findall(r"'(snapshot|ready|connecting|syncing|sync_progress|reconnecting|idle|ota_bootloader|mqtt_proxy_up|mqtt_proxy_down)'", appws)
    if old_states:
        unique = sorted(set(old_states))
        report("WARN", "app-ws.js: old state event types in _applyStateEvent",
               f"Browser handles: {unique} — new gw emits device_state with .state field; "
               "_applyStateEvent never called; loraCfg/mqttCfg/my_info not populated")
    else:
        report("PASS", "app-ws.js: old state event types", "not found")

    # 9. Browser ev.device in packet handler (only flag unguarded uses)
    lines_with_device = [(i+1, l.strip()) for i, l in enumerate(appws.splitlines())
                          if 'ev.device' in l and '|| ev.device' not in l and '?? ev.device' not in l
                          and not l.strip().startswith('//')]
    if lines_with_device:
        report("WARN", "app-ws.js: ev.device without addr fallback",
               f"{len(lines_with_device)} line(s) — "
               "packet events from new gw use ev.addr; ev.device will be undefined; "
               "affects message src tracking and dedup")
    else:
        report("PASS", "app-ws.js: ev.device", "all uses guarded or no issues found")

    # 10. OTA flash event types — browser handles them; check ws-relay now translates device_state OTA transitions
    ota_flash_types = [t for t in ["ota_start", "ota_progress", "ota_complete", "ota_error"]
                       if f"ev.type === '{t}'" in appws or f"type: '{t}'" in appws]
    relay_translates = all(f"type: '{t}'" in relay for t in ["ota_start", "ota_progress", "ota_complete", "ota_error"])
    if ota_flash_types and relay_translates:
        report("PASS", "app-ws.js: OTA flash events",
               "ws-relay.js translates device_state OTA_FLASHING/COMPLETE/ERROR → ota_start/progress/complete/error for browser")
    elif ota_flash_types:
        report("FAIL", "app-ws.js: OTA flash events",
               f"Browser handles {ota_flash_types} but neither new gw NOR ws-relay emit these — "
               "OTA flash progress expressed via device_state.state = OTA_FLASHING+pct but not translated; "
               "OTA flash UI progress bar never fires")
    else:
        report("PASS", "app-ws.js: OTA flash events", "not referenced")

    # 11. text_message typed event — not required: packet path works (portnum IS string; b64ToUtf8 decodes)
    # Typed event lacks pkt.id needed for dedup with the packet path, so adding it risks duplicates.
    if "ev.type === 'text_message'" not in appws and "type === 'text_message'" not in appws:
        report("WARN", "app-ws.js: text_message typed event",
               "Browser has no handler for ev.type === 'text_message' — "
               "not required since packet path works (portnum IS string); "
               "typed handler would need dedup vs. packet path")
    else:
        report("PASS", "app-ws.js: text_message handler", "found")

    # 12. routing_ack event not emitted by new stack
    if "routing_ack" in appws:
        report("WARN", "app-ws.js: routing_ack",
               "Browser handles routing_ack but new gw/node-dash does not emit it — "
               "DM ack status never advances past 'sent'; always times out to 'no_ack'")
    else:
        report("PASS", "app-ws.js: routing_ack", "not present")


# ─────────────────────────────────────────────────────────────────────────────
# B. Live — WS event schema validation
# ─────────────────────────────────────────────────────────────────────────────

# Events that must appear in the initial burst
REQUIRED_ON_CONNECT = {
    "device_list", "node_list", "known_nodes", "tilt_cal",
    "message_history", "tilt_history", "env_history",
    "range_test_log", "range_test_timer", "traceroute_history",
}

# Expected event schemas (required top-level fields)
SCHEMAS = {
    "bridge_connected":       {"required": ["type"]},
    "bridge_disconnected":    {"required": ["type"]},
    "device_list":            {"required": ["type", "devices"]},
    "node_list":              {"required": ["type", "nodes"]},
    "known_nodes":            {"required": ["type", "nodes"]},
    "tilt_cal":               {"required": ["type"]},
    "message_history":        {"required": ["type", "messages"]},
    "tilt_history":           {"required": ["type", "rows"]},
    "env_history":            {"required": ["type", "rows"]},
    "range_test_log":         {"required": ["type", "log"]},
    "range_test_timer":       {"required": ["type", "active"]},
    "traceroute_history":     {"required": ["type", "rows"]},
    "tilt_update":            {"required": ["type", "data"]},
    "telemetry_update":       {"required": ["type", "from_num", "variant", "data"]},
    "range_test_entry":       {"required": ["type", "data"]},
    "route_discovered":       {"required": ["from", "route"]},
    "passive_trace_start":    {"required": ["type", "from"]},
    "rotator":                {"required": ["type", "data"]},
    "signal_update":          {"required": ["type", "data"]},
    "scan_start":             {"required": ["type", "data"]},
    "scan_progress":          {"required": ["type", "data"]},
    "scan_contact":           {"required": ["type", "data"]},
    "scan_end":               {"required": ["type"]},
    "radar_context":          {"required": ["type", "mode"]},
}

CONDITIONAL = {
    "bridge_disconnected":  "only on bridge disconnect",
    "tilt_update":          "only if tilt node active and sending",
    "telemetry_update":     "only if telemetry packet received",
    "range_test_entry":     "only during range test",
    "route_discovered":     "only after traceroute completes",
    "passive_trace_start":  "only in PASV mode with active trace",
    "signal_update":        "only during SCAN mode",
    "scan_start":           "only if scan started",
    "scan_progress":        "only during active scan",
    "scan_contact":         "only when node heard during scan",
    "scan_end":             "only when scan ends",
    "radar_context":        "only if FF.SSOT_ROUTE_RENDER enabled",
}

# device_list item schema
DEVICE_LIST_FIELDS = ["addr", "ble_state", "node_id", "state"]


def validate(ev, schema):
    for f in schema.get("required", []):
        if f not in ev:
            return False, f"missing field '{f}'"
    return True, "ok"


async def collect_events(secs):
    events = []
    deadline = time.time() + secs
    try:
        async with websockets.connect(WS_URL, open_timeout=5) as ws:
            while time.time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=min(deadline - time.time(), 5))
                    ev = json.loads(raw)
                    events.append(ev)
                except asyncio.TimeoutError:
                    continue
    except Exception as e:
        print(f"  WS connection failed: {e}")
    return events


def live_checks():
    section(f"Live — WS /events collect {COLLECT_SECS}s")
    print(f"  Connecting to {WS_URL} ...")
    events = asyncio.run(collect_events(COLLECT_SECS))
    print(f"  Received {len(events)} events")

    by_type = {}
    for ev in events:
        t = ev.get("type", "__unknown__")
        by_type.setdefault(t, []).append(ev)

    print(f"  Types seen: {sorted(by_type.keys())}")

    section("Live — Event Schema Validation")

    for ev_type, schema in SCHEMAS.items():
        cond = CONDITIONAL.get(ev_type)
        if ev_type not in by_type:
            if ev_type in REQUIRED_ON_CONNECT:
                report("FAIL", f"WS:{ev_type}", "required on connect but never received")
            elif cond:
                report("SKIP", f"WS:{ev_type}", cond)
            else:
                report("SKIP", f"WS:{ev_type}", "not seen")
            continue

        sample = by_type[ev_type][0]
        ok, reason = validate(sample, schema)
        count = len(by_type[ev_type])
        if ok:
            report("PASS", f"WS:{ev_type}", f"{count} seen")
        else:
            report("FAIL", f"WS:{ev_type}", f"schema error: {reason}")

    # device_list content check
    if "device_list" in by_type:
        dl = by_type["device_list"][0]
        devices = dl.get("devices", [])
        for i, dev in enumerate(devices):
            missing = [f for f in DEVICE_LIST_FIELDS if f not in dev]
            if missing:
                report("FAIL", f"device_list.devices[{i}]",
                       f"missing fields: {missing} — sample: {json.dumps(dev)[:150]}")
            else:
                addr = dev.get("addr", f"[{i}]")
                state = dev.get("ble_state", "?")
                report("PASS", f"device_list.devices[{i}] ({addr})", f"ble_state={state}")

    # node_list content check
    if "node_list" in by_type:
        nl = by_type["node_list"][0]
        nodes = nl.get("nodes", [])
        report("PASS", "node_list content", f"{len(nodes)} nodes, total={nl.get('total')}")


def rest_check(method, path, expect_status=200, expect_keys=None, skip_reason=None):
    label = f"{method} {path}"
    if skip_reason:
        report("SKIP", label, skip_reason)
        return None
    try:
        if method == "GET":
            r = requests.get(BASE + path, timeout=10)
        elif method == "POST":
            r = requests.post(BASE + path, json={}, timeout=10)
        elif method == "DELETE":
            r = requests.delete(BASE + path, timeout=10)
        else:
            report("SKIP", label, f"method {method} not tested")
            return None
    except Exception as e:
        report("FAIL", label, f"error: {e}")
        return None

    if r.status_code != expect_status:
        report("FAIL", label, f"HTTP {r.status_code} (expected {expect_status})")
        return None

    if expect_keys:
        try:
            data = r.json()
            missing = [k for k in expect_keys if k not in data]
            if missing:
                report("FAIL", label, f"missing keys: {missing}")
                return None
        except Exception:
            report("FAIL", label, "response not JSON")
            return None

    report("PASS", label, f"HTTP {r.status_code}")
    try:
        return r.json()
    except Exception:
        return r.text


def rest_checks():
    section("Live — REST Endpoints")

    rest_check("GET", "/status",           expect_keys=["bridge_connected", "bridge"])
    rest_check("GET", "/nodes",            expect_keys=["nodes"])
    rest_check("GET", "/messages")
    rest_check("GET", "/rotator/status")
    rest_check("GET", "/tilt_history")
    rest_check("GET", "/env_history")
    rest_check("GET", "/range_test/log")
    rest_check("GET", "/range_test/timer", expect_keys=["active"])
    rest_check("GET", "/traceroute_history")
    rest_check("GET", "/auto-purge",       skip_reason="requires ?device= param; tested indirectly via device list")

    # Purge nodedb — skipped by default (25s + physical radio reboot).
    # Set PURGE_TEST=1 env var to run: PURGE_TEST=1 python3 test_node.py
    if os.environ.get("PURGE_TEST") == "1":
        primary = next((d for d in requests.get(BASE + "/devices").json().get("devices", [])
                        if d.get("state") == "ready"), None)
        if not primary:
            report("SKIP", "POST /purge-nodedb", "no READY device found")
        else:
            node_id = primary["node_id"]
            try:
                r = requests.post(BASE + "/purge-nodedb",
                                  json={"device": node_id}, timeout=70)
                if r.status_code == 200:
                    d = r.json()
                    nc = d.get("node_count")
                    if d.get("ok") and nc is not None:
                        report("PASS", "POST /purge-nodedb",
                               f"node_count={nc} (expected 1) ok={d['ok']}")
                    else:
                        report("FAIL", "POST /purge-nodedb",
                               f"missing ok/node_count in response: {d}")
                else:
                    report("FAIL", "POST /purge-nodedb",
                           f"HTTP {r.status_code}: {r.text[:120]}")
            except Exception as e:
                report("FAIL", "POST /purge-nodedb", f"error: {e}")
    else:
        report("SKIP", "POST /purge-nodedb",
               "set PURGE_TEST=1 to run (25s, reboots radio)")
    rest_check("GET", "/alerts/config")
    rest_check("GET", "/alerts/rules")
    rest_check("GET", "/schema/rotator_config")
    rest_check("GET", "/schema/bridge_config")

    # /devices should return 410 for browser-style GET (we send as sec-fetch-dest: empty)
    try:
        r = requests.get(BASE + "/devices",
                         headers={"sec-fetch-dest": "empty"}, timeout=10)
        if r.status_code == 410:
            try:
                d = r.json()
                report("PASS", "GET /devices (browser)",
                       f"HTTP 410 — {d.get('error', '')} — ws={d.get('ws', '')}")
            except Exception:
                report("PASS", "GET /devices (browser)", "HTTP 410")
        else:
            report("FAIL", "GET /devices (browser)",
                   f"HTTP {r.status_code} — expected 410 (ws_only enforcement)")
    except Exception as e:
        report("FAIL", "GET /devices (browser)", f"error: {e}")

    # Bridge proxy — /!hexid endpoints should reach mesh-gw
    rest_check("GET", "/bridge_config")


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main():
    print(f"\n{'═'*65}")
    print(f"  node-dash API Test  —  {BASE}")
    print(f"  Collect window: {COLLECT_SECS}s")
    print(f"{'═'*65}")

    # Reachability check
    section("Reachability")
    try:
        r = requests.get(BASE + "/status", timeout=5)
        if r.status_code != 200:
            print(f"  FATAL: node-dash returned HTTP {r.status_code}. Aborting.")
            sys.exit(1)
        data = r.json()
        report("PASS", "GET /status", f"node_dash={data.get('node_dash', '?')}")
    except Exception as e:
        print(f"  FATAL: node-dash not reachable at localhost:8000: {e}. Aborting.")
        sys.exit(1)

    static_checks()
    live_checks()
    rest_checks()

    section("Summary")
    total   = len(results)
    passed  = sum(1 for r in results if r[0] == "PASS")
    failed  = sum(1 for r in results if r[0] == "FAIL")
    warned  = sum(1 for r in results if r[0] == "WARN")
    skipped = sum(1 for r in results if r[0] in ("SKIP",))

    print(f"  Total:   {total}")
    print(f"  PASS:    {passed}")
    print(f"  FAIL:    {failed}")
    print(f"  WARN:    {warned}")
    print(f"  SKIP:    {skipped}")

    if failed or warned:
        print(f"\n  FAILED / WARNED items:")
        for status, subject, detail in results:
            if status in ("FAIL", "WARN"):
                tag = "✗" if status == "FAIL" else "⚠"
                print(f"    {tag} [{status}] {subject}")
                if detail:
                    print(f"          {detail}")

    print(f"\n{'═'*65}")
    if failed:
        print(f"  RESULT: FAIL  ({failed} failure(s), {warned} warning(s))")
    elif warned:
        print(f"  RESULT: WARN  (0 failures, {warned} warning(s))")
    else:
        print(f"  RESULT: PASS")
    print(f"{'═'*65}\n")

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
