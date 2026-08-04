#!/usr/bin/env python3
"""
ws_monitor.py — watch a device's OTA_* progress live over mesh-gw's /events WebSocket.

Usage:
    python scripts/ws_monitor.py <address> [--host HOST] [--port PORT]

Prints each OTA_* state transition as it arrives, with pct/eta_s/
total_run_time_s, and exits after printing the final result on
OTA_COMPLETE or OTA_ERROR.

Two things learned the hard way, both handled here:
1. The first payload sent on connect is an unfiltered device_snapshot
   covering every tracked device's full state — this can exceed the
   `websockets` client's default 1MB frame limit and kill the connection
   immediately. Fixed by passing a generous max_size.
2. The server's ?subscribe=<topic> query param filters on each message's
   top-level "type" field. OTA progress data is not a top-level
   type: "device_state" message — it arrives nested inside "state_event"
   within a top-level type: "device_data" (or similar) merged snapshot
   message. Passing subscribe=device_state silently discards every OTA
   progress update. Fixed by not setting subscribe at all (wildcard) and
   filtering client-side on msg["state_event"]["state"].
"""
import argparse
import asyncio
import json
import sys
import time

import websockets


async def watch(address: str, host: str, port: int) -> None:
    url = f"ws://{host}:{port}/events?device={address}"
    async with websockets.connect(url, max_size=32 * 1024 * 1024) as ws:
        async for raw in ws:
            msg = json.loads(raw)
            se = msg.get("state_event")
            if not se:
                continue
            state = se.get("state")
            if not state or not str(state).startswith("OTA"):
                continue
            now = time.strftime("%H:%M:%S")
            line = f"{now}  state={state}"
            if se.get("pct") is not None:
                line += f" pct={se['pct']}"
            if se.get("eta_s") is not None:
                line += f" eta_s={se['eta_s']}"
            if se.get("total_run_time_s") is not None:
                line += f" total_run_time_s={se['total_run_time_s']}"
            print(line, flush=True)
            if state == "OTA_COMPLETE":
                print(f"DONE total_run_time_s={se.get('total_run_time_s')}", flush=True)
                return
            if state == "OTA_ERROR":
                print(f"ERRORED message={se.get('message')!r}", flush=True)
                return


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("address", help="BLE address of the device to watch")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    try:
        asyncio.run(watch(args.address, args.host, args.port))
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
