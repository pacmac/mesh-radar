"""
test_playwright.py — Browser smoke test via Playwright.

Tests the full end-to-end save pipeline:
  click button → Alpine handler → submitOp → POST /ops → WS config_op → toast

Prerequisites:
  pip install playwright && playwright install chromium

Run: python3 tests/test_playwright.py
"""
import asyncio
import json
import os
import sys

from playwright.async_api import async_playwright, Page, expect

BASE = os.environ.get("NODE_DASH_URL", "http://localhost:8000")
HEADLESS = os.environ.get("PLAYWRIGHT_HEADLESS", "1") != "0"
TIMEOUT_MS = int(os.environ.get("PLAYWRIGHT_TIMEOUT", "15000"))

TESTS_PASSED = 0
TESTS_FAILED = 0


async def wait_for_op_success(page: Page, timeout_ms: int = TIMEOUT_MS) -> dict | None:
    """Wait for a config_op WS event with state='success'. Returns the event or None."""
    result = {}

    async def on_websocket(ws):
        async def on_message(msg):
            try:
                ev = json.loads(msg)
                if ev.get("type") == "config_op" and ev.get("state") == "success":
                    result["ev"] = ev
            except Exception:
                pass
        ws.on("framereceived", lambda f: asyncio.ensure_future(on_message(f.payload)) if f.is_text else None)

    page.on("websocket", on_websocket)

    deadline_ms = asyncio.get_event_loop().time() * 1000 + timeout_ms
    while asyncio.get_event_loop().time() * 1000 < deadline_ms:
        if "ev" in result:
            return result["ev"]
        await asyncio.sleep(0.2)
    return None


async def assert_toast(page: Page, label: str):
    """Assert a success toast appears within TIMEOUT_MS."""
    global TESTS_PASSED, TESTS_FAILED
    toast = page.locator("#op-toast-container .alert-success")
    try:
        await expect(toast.first).to_be_visible(timeout=TIMEOUT_MS)
        print(f"  ✓ {label}: success toast appeared")
        TESTS_PASSED += 1
    except Exception as e:
        print(f"  ✗ {label}: no success toast — {e}")
        TESTS_FAILED += 1


async def navigate_config_bridge(page: Page):
    """Navigate to /config then click Bridge sub-tab and wait for form to load."""
    await page.goto(f"{BASE}/config", timeout=10000)
    await page.wait_for_load_state("networkidle", timeout=10000)
    await asyncio.sleep(1.0)
    # Click Bridge sub-tab — locator by text inside the config tabs
    await page.click('.tab:text("Bridge")', timeout=5000)
    # Wait for bridge_cfg_form to be populated
    await page.wait_for_selector("#bridge_cfg_form", timeout=8000)
    await asyncio.sleep(1.2)


async def wait_ws_and_radar_config(page: Page):
    """After nav, wait for WS connection AND /config/radar response, then click Radar."""
    # Use Playwright WS interception: ARM listener BEFORE navigating so we don't miss the connect
    ws_connected = asyncio.Event()

    def on_ws(ws):
        ws_connected.set()

    page.on("websocket", on_ws)

    # Navigate
    await page.goto(f"{BASE}/config", timeout=10000)
    await page.wait_for_load_state("networkidle", timeout=10000)

    # Wait for WS connection
    try:
        await asyncio.wait_for(ws_connected.wait(), timeout=8.0)
    except asyncio.TimeoutError:
        pass  # proceed anyway

    await asyncio.sleep(0.5)

    # Now click Radar tab and wait for the config fetch
    async with page.expect_response(lambda r: "/config/radar" in r.url, timeout=8000) as resp_info:
        await page.click('.tab:text("Radar")', timeout=5000)
    await resp_info.value
    await asyncio.sleep(0.3)


async def navigate_config_radar(page: Page):
    """Navigate to /config then click Radar sub-tab. Wait for WS + radar config fetch."""
    await wait_ws_and_radar_config(page)


async def test_bridge_config_save(page: Page):
    """Click the bridge config save button and assert a success toast."""
    await navigate_config_bridge(page)
    btn = page.locator('[data-op-kind="bridge_config"]')
    await expect(btn).to_be_visible(timeout=5000)
    await btn.click()
    await assert_toast(page, "bridge_config save")


async def test_radar_config_save(page: Page):
    """Click the radar config save button and assert a success toast."""
    await navigate_config_radar(page)
    btn = page.locator('[data-op-kind="radar_config"]')
    await expect(btn).to_be_visible(timeout=5000)
    await btn.click()
    await assert_toast(page, "radar_config save")


async def main():
    global TESTS_PASSED, TESTS_FAILED

    print(f"Playwright smoke — {BASE}  headless={HEADLESS}")
    print()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=HEADLESS)
        page = await browser.new_page()

        # Capture browser console errors
        console_errors = []
        page.on("console", lambda m: console_errors.append(f"[{m.type}] {m.text}") if m.type in ("error", "warning") else None)

        # Load dashboard and wait for Alpine to initialise
        await page.goto(BASE, timeout=15000)
        await page.wait_for_load_state("networkidle", timeout=15000)
        await asyncio.sleep(1.5)

        # Sanity check — page title
        title = await page.title()
        print(f"  Page title: {title!r}")

        # Run tests
        try:
            await test_bridge_config_save(page)
            await test_radar_config_save(page)
        except Exception as e:
            print(f"  ✗ Unexpected error: {e}")
            TESTS_FAILED += 1

        if console_errors:
            print(f"  Console errors/warnings ({len(console_errors)}):")
            for e in console_errors[-10:]:
                print(f"    {e}")

        await browser.close()

    print()
    print("═" * 55)
    if TESTS_FAILED == 0:
        print(f"  RESULT: PASS  ({TESTS_PASSED} tests passed)")
    else:
        print(f"  RESULT: FAIL  ({TESTS_PASSED} passed, {TESTS_FAILED} failed)")
    print("═" * 55)
    sys.exit(0 if TESTS_FAILED == 0 else 1)


if __name__ == "__main__":
    asyncio.run(main())
