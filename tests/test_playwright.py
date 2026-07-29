"""
Structured node-dash browser acceptance audit.

Passive by default. Set PLAYWRIGHT_LIVE_CHANNEL=3 (or 4) to enable the
guarded OMNI channel write/read-back/restore test.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urlparse

from playwright.async_api import BrowserContext, Page, async_playwright


BASE = os.environ.get("NODE_DASH_URL", "http://localhost:8000").rstrip("/")
HEADLESS = os.environ.get("PLAYWRIGHT_HEADLESS", "1") != "0"
TIMEOUT = int(os.environ.get("PLAYWRIGHT_TIMEOUT", "15000"))
ARTIFACT_DIR = Path(os.environ.get("PLAYWRIGHT_ARTIFACT_DIR", ".playwright-mcp/audit"))
LIVE_CHANNEL = os.environ.get("PLAYWRIGHT_LIVE_CHANNEL", "").strip()
OMNI_NODE_ID = os.environ.get("PLAYWRIGHT_OMNI_NODE_ID", "!2687afb1")
OMNI_MAC = os.environ.get("PLAYWRIGHT_OMNI_MAC", "E9:B0:3F:17:27:91").upper()
# Plugin-boundary audit. ALARM = a unit pac-host knows about; CORE = an ordinary
# mesh node it does not. Env-overridable so the test is not wired to one install.
ALARM_NODE_ID = os.environ.get("PLAYWRIGHT_ALARM_NODE_ID", "!987ab80f")
# A real mesh node: NOT a gateway radio and NOT an alarm unit. Both matter — a
# gateway would not prove the plugin leaves ordinary nodes alone. The route
# takes !hexid, never a decimal num.
CORE_NODE_ID = os.environ.get("PLAYWRIGHT_CORE_NODE_ID", "!30327710")
VISUAL = os.environ.get("PLAYWRIGHT_VISUAL", "1") != "0"

VIEWPORTS = {
    "desktop": {"width": 1440, "height": 900},
    "iphone": {"width": 390, "height": 844},
}


@dataclass(frozen=True)
class RouteCase:
    path: str
    tab: str | None
    tokens: tuple[str, ...]
    name: str


ROUTES = (
    RouteCase("/", "overview", ("Live Event Feed",), "overview-root"),
    RouteCase("/overview", "overview", ("Live Event Feed",), "overview"),
    RouteCase("/radar", "radar", ("PASV", "ACTV", "SCAN"), "radar"),
    RouteCase("/nodes", "nodes", ("NodeDB",), "nodes"),
    RouteCase("/messages", "messages", ("Send Text", "Message Feed"), "messages"),
    RouteCase("/config", "cfg", ("Bridge", "Rotator", "Modes", "Radar", "Alerts"), "config"),
    RouteCase("/device-config", "devices", ("Connected radios",), "device-config-legacy"),
    RouteCase("/devices", "devices", ("Connected radios",), "devices"),
    RouteCase("/range", "range", ("Range Test Log",), "range"),
    RouteCase("/performance", "perf", ("Performance", "Traceroute History"), "performance"),
    # /control was absent from this list entirely — a real page with six
    # sub-tabs, never audited. Tokens are the sub-tab labels, which exist
    # whether or not a given sub-tab is built out yet.
    RouteCase("/control", "control", ("Command", "Config", "Yagi Align"), "control"),
    RouteCase(f"/node/{OMNI_NODE_ID}", "node", (), "node-focus"),
    RouteCase("/debug", None, ("mt-radar debug", "mesh-gw", "node-dash"), "debug"),
)

ALLOWED_HOST = (urlparse(BASE).hostname or "").lower()
BLOCKED_REMOTE = re.compile(r"(^|\.)((jsdelivr|tailwindcss|googleapis|gstatic)\.com)$", re.I)


class Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.failures: list[str] = []

    def check(self, ok: bool, label: str, detail: str = "") -> bool:
        if ok:
            self.passed += 1
            print(f"  PASS  {label}")
            return True
        self.failed += 1
        msg = f"{label}: {detail}" if detail else label
        self.failures.append(msg)
        print(f"  FAIL  {msg}")
        return False


RESULTS = Results()


def app_state_js() -> str:
    return """() => {
      const root = document.querySelector('[x-data="dashboard()"]');
      const d = root?._x_dataStack?.[0];
      return {
        tab: d?.tab ?? null,
        cfgTab: d?.cfgTab ?? null,
        wsConnected: d?.wsConnected ?? false,
        bridgeConnected: d?.bridgeConnected ?? false,
        devices: (d?.availableDevices || []).map(x => ({
          addr: x.addr, node_id: x.node_id, label: x.cfg?.label,
          ble_state: x.ble_state
        })),
        nodeCount: d?.nodeCount ?? null,
        nodeStatus: d?.nodeStatus ?? null
      };
    }"""


async def settle_app(page: Page, debug: bool = False) -> dict:
    if debug:
        await page.wait_for_selector("#grid", timeout=TIMEOUT)
        await page.wait_for_timeout(500)
        return {}
    await page.wait_for_function(
        """() => {
          const d=document.querySelector('[x-data="dashboard()"]')?._x_dataStack?.[0];
          return !!d && d.wsConnected === true && d.availableDevices?.length > 0;
        }""",
        timeout=TIMEOUT,
    )
    await page.wait_for_timeout(350)
    return await page.evaluate(app_state_js())


async def geometry(page: Page, debug: bool = False) -> dict:
    return await page.evaluate(
        """(debug) => {
          const shown = e => {
            const s=getComputedStyle(e), r=e.getBoundingClientRect();
            return s.display !== 'none' && s.visibility !== 'hidden' &&
              r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
          };
          const bad = [...document.querySelectorAll('button,a,input,select,textarea,.badge')]
            .filter(e => shown(e))
            .filter(e => !e.closest('.drawer-side'))
            .filter(e => !e.closest('dialog:not([open])'))
            .filter(e => !e.closest('details:not([open]) .dropdown-content'))
            .map(e => ({e, r:e.getBoundingClientRect()}))
            .filter(x => x.r.left < -1 || x.r.right > innerWidth + 1)
            .map(x => (x.e.innerText || x.e.getAttribute('aria-label') ||
              x.e.getAttribute('title') || x.e.tagName).trim().slice(0,60));
          const main = debug ? document.documentElement :
            document.querySelector('.drawer-content > .flex-1');
          const active = debug ? document.querySelector('#grid') :
            document.querySelector('.drawer-content > .flex-1 > div');
          return {
            viewport: [innerWidth, innerHeight],
            documentOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
            mainOverflowX: !!main && main.scrollWidth > main.clientWidth + 1,
            blank: !active || active.getBoundingClientRect().height < 2 ||
              (!debug && !active.innerText.trim() && !active.querySelector('canvas,svg')),
            clipped: bad
          };
        }""",
        debug,
    )


def install_observers(page: Page, errors: list[str], remote: set[str]) -> None:
    page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
    page.on(
        "console",
        lambda msg: errors.append(f"console {msg.type}: {msg.text}")
        if msg.type == "error"
        else None,
    )

    def on_request(request) -> None:
        host = (urlparse(request.url).hostname or "").lower()
        if host and host != ALLOWED_HOST and BLOCKED_REMOTE.search(host):
            remote.add(request.url)

    page.on("request", on_request)


async def screenshot(page: Page, viewport: str, case: str, theme: str) -> None:
    if not VISUAL:
        return
    target = ARTIFACT_DIR / viewport / case
    target.mkdir(parents=True, exist_ok=True)
    await page.evaluate(
        "(theme) => document.documentElement.setAttribute('data-theme', theme)", theme
    )
    await page.wait_for_timeout(100)
    await page.screenshot(path=str(target / f"{theme}.png"), full_page=False)


async def audit_routes(browser) -> None:
    print("\nROUTES / DATA / GEOMETRY")
    for viewport_name, viewport in VIEWPORTS.items():
        context = await browser.new_context(viewport=viewport)
        page = await context.new_page()
        page.set_default_timeout(TIMEOUT)
        errors: list[str] = []
        remote: set[str] = set()
        install_observers(page, errors, remote)

        for case in ROUTES:
            errors.clear()
            before_remote = set(remote)
            response = None
            try:
                response = await page.goto(BASE + case.path, wait_until="domcontentloaded")
                state = await settle_app(page, case.tab is None)
                body = await page.locator("body").inner_text()
                geo = await geometry(page, case.tab is None)
                prefix = f"{viewport_name}/{case.name}"
                RESULTS.check(
                    response is not None and response.status == 200,
                    f"{prefix} HTTP 200",
                    f"HTTP {response.status if response else 'none'}",
                )
                if case.tab is not None:
                    RESULTS.check(
                        state.get("tab") == case.tab,
                        f"{prefix} tab",
                        f"expected {case.tab}, got {state.get('tab')}",
                    )
                    RESULTS.check(state.get("wsConnected"), f"{prefix} WebSocket live")
                    RESULTS.check(
                        len(state.get("devices", [])) >= 1,
                        f"{prefix} device_list data",
                    )
                for token in case.tokens:
                    RESULTS.check(
                        token.lower() in body.lower(),
                        f"{prefix} surface {token}",
                    )
                RESULTS.check(not geo["blank"], f"{prefix} non-blank main")
                RESULTS.check(
                    not geo["documentOverflowX"] and not geo["mainOverflowX"],
                    f"{prefix} horizontal containment",
                    json.dumps(geo),
                )
                RESULTS.check(
                    not geo["clipped"],
                    f"{prefix} controls in viewport",
                    ", ".join(geo["clipped"]),
                )
                RESULTS.check(not errors, f"{prefix} console/page errors", " | ".join(errors))
                RESULTS.check(
                    remote == before_remote,
                    f"{prefix} same-origin runtime assets",
                    ", ".join(sorted(remote - before_remote)),
                )
                await screenshot(page, viewport_name, case.name, "corporate")
                await screenshot(page, viewport_name, case.name, "business")
            except Exception as exc:
                RESULTS.check(False, f"{viewport_name}/{case.name} completed", str(exc))
                target = ARTIFACT_DIR / viewport_name / case.name
                target.mkdir(parents=True, exist_ok=True)
                try:
                    await page.screenshot(path=str(target / "failure.png"), full_page=False)
                except Exception:
                    pass
        await context.close()


async def audit_invalid_persisted_tab(browser) -> None:
    print("\nPERSISTED NAVIGATION MIGRATION")
    context = await browser.new_context(viewport=VIEWPORTS["desktop"])
    await context.add_init_script(
        """localStorage.setItem('ui_prefs', JSON.stringify({
          activeTab:'control', cfgTab:'radio'
        }));"""
    )
    page = await context.new_page()
    await page.goto(BASE + "/", wait_until="domcontentloaded")
    state = await settle_app(page)
    prefs = await page.evaluate("() => JSON.parse(localStorage.getItem('ui_prefs') || '{}')")
    RESULTS.check(state.get("tab") == "overview", "removed control tab falls back to Overview")
    RESULTS.check(prefs.get("activeTab") == "overview", "invalid activeTab is replaced")

    await page.goto(BASE + "/config", wait_until="domcontentloaded")
    state = await settle_app(page)
    RESULTS.check(state.get("cfgTab") == "bridge", "removed Radio config subtab maps to Bridge")
    await context.close()


async def audit_safe_interactions(browser) -> None:
    print("\nSAFE INTERACTIONS")
    context = await browser.new_context(viewport=VIEWPORTS["desktop"])
    page = await context.new_page()
    page.set_default_timeout(TIMEOUT)

    await page.goto(BASE + "/config", wait_until="domcontentloaded")
    await settle_app(page)
    for label in ("Bridge", "Rotator", "Modes", "Radar", "Alerts"):
        tab = page.locator("a.tab", has_text=label).first
        await tab.click()
        await page.wait_for_timeout(250)
        RESULTS.check(await tab.is_visible(), f"Config subtab {label} opens")
    RESULTS.check(
        await page.locator("a.tab", has_text="Radio").count() == 0,
        "Config has no dead Radio subtab",
    )

    await page.goto(BASE + "/devices", wait_until="domcontentloaded")
    state = await settle_app(page)
    omni = next((d for d in state["devices"] if d.get("label") == "OMNI"), None)
    RESULTS.check(omni is not None, "OMNI device is present")
    if omni:
        strip = page.locator('div[role="button"]', has_text="OMNI").first
        await strip.click()
        for label in ("Settings", "Radio", "Channels", "Owner", "Firmware", "Maintenance"):
            button = page.get_by_role("button", name=label, exact=True).first
            await button.click()
            await page.wait_for_timeout(350)
            RESULTS.check(await button.is_visible(), f"OMNI Devices tab {label} opens")
        RESULTS.check(
            await page.get_by_role("button", name="Wipe node DB", exact=True).is_visible(),
            "dangerous maintenance controls are visible but untouched",
        )

    await page.goto(BASE + "/performance", wait_until="domcontentloaded")
    await settle_app(page)
    await page.get_by_role("button", name="Expert", exact=True).click()
    RESULTS.check(
        await page.get_by_text("EIRP", exact=True).is_visible(),
        "Performance Expert display toggles",
    )
    await page.get_by_role("button", name="Simple", exact=True).click()
    await context.close()


def channel_at(payload: dict, index: int) -> dict:
    channels = payload.get("channels", [])
    if isinstance(channels, list):
        return channels[index] if index < len(channels) else {}
    return channels.get(str(index), {})


async def api_json(page: Page, path: str) -> dict:
    return await page.evaluate(
        """async (path) => {
          const r=await fetch(path);
          if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
          return await r.json();
        }""",
        path,
    )


async def api_request(page: Page, path: str, method: str, body: dict | None = None) -> dict:
    return await page.evaluate(
        """async ({path,method,body}) => {
          const opts={method, headers:{}};
          if (body !== null) {
            opts.headers['Content-Type']='application/json';
            opts.body=JSON.stringify(body);
          }
          const r=await fetch(path, opts);
          const data=await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(`${path} HTTP ${r.status}: ${data.detail || data.error || ''}`);
          return data;
        }""",
        {"path": path, "method": method, "body": body},
    )


async def wait_op(page: Page, op_id: str, timeout: float = 90.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = await api_json(page, f"/ops/{op_id}")
        if result.get("state") in ("success", "error"):
            return result
        await asyncio.sleep(0.5)
    raise TimeoutError(f"operation {op_id} did not finish")


async def restore_channel(page: Page, index: int, original: dict) -> None:
    values = {
        "index": index,
        "settings": dict(original.get("settings") or {}),
        "role": original.get("role") or "DISABLED",
    }
    op_id = await page.evaluate(
        """async ({target,index,values}) => {
          const r=await fetch('/ops', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
              kind:'channel_config', target,
              payload:{index, values}
            })
          });
          if (!r.ok) throw new Error(`restore submit HTTP ${r.status}`);
          return (await r.json()).op_id;
        }""",
        {"target": OMNI_NODE_ID, "index": index, "values": values},
    )
    outcome = await wait_op(page, op_id)
    if outcome.get("state") != "success":
        raise RuntimeError(outcome.get("error") or "channel restore failed")


async def wait_omni_ready(page: Page) -> None:
    await page.wait_for_function(
        """({target,mac}) => {
          const d=document.querySelector('[x-data="dashboard()"]')?._x_dataStack?.[0];
          const dev=d?.availableDevices?.find(x =>
            x.node_id === target && x.addr?.toUpperCase() === mac);
          return dev?.ble_state === 'ready';
        }""",
        {"target": OMNI_NODE_ID, "mac": OMNI_MAC},
        timeout=120_000,
    )
    await page.wait_for_timeout(1000)


async def resync_omni(page: Page) -> None:
    encoded = quote(OMNI_MAC, safe="")
    await api_request(page, f"/devices/{encoded}", "DELETE")
    await page.wait_for_timeout(500)
    await api_request(
        page, f"/ble_devices/{encoded}", "PATCH", {"auto_connect": True}
    )
    await wait_omni_ready(page)


async def audit_live_channel(browser) -> None:
    if not LIVE_CHANNEL:
        print("\nLIVE CHANNEL: SKIP (set PLAYWRIGHT_LIVE_CHANNEL=3 or 4)")
        return
    print("\nLIVE CHANNEL")
    if LIVE_CHANNEL not in ("3", "4"):
        RESULTS.check(False, "live channel guard", "only channel 3 or 4 is allowed")
        return
    index = int(LIVE_CHANNEL)
    context: BrowserContext = await browser.new_context(viewport=VIEWPORTS["desktop"])
    page = await context.new_page()
    page.set_default_timeout(90_000)
    attempted = False
    original: dict = {}
    try:
        await page.goto(BASE + "/devices", wait_until="domcontentloaded")
        state = await settle_app(page)
        omni = next((d for d in state["devices"] if d.get("label") == "OMNI"), None)
        yagi = next((d for d in state["devices"] if d.get("label") == "YAGI"), None)
        guards = (
            omni is not None
            and omni.get("node_id") == OMNI_NODE_ID
            and omni.get("ble_state") == "ready"
            and (not OMNI_MAC or omni.get("addr", "").upper() == OMNI_MAC)
            and (not yagi or yagi.get("node_id") != OMNI_NODE_ID)
        )
        if not RESULTS.check(guards, "OMNI identity/ready guard"):
            return

        payload = await api_json(page, f"/{OMNI_NODE_ID}/channels")
        original = channel_at(payload, index)
        unused = not (original.get("settings") or {}) and not original.get("role")
        if not RESULTS.check(unused, f"OMNI channel {index} is unused"):
            return

        strip = page.locator('div[role="button"]', has_text="OMNI").first
        await strip.click()
        await page.get_by_role("button", name="Channels", exact=True).first.click()
        collapse = page.locator(".collapse", has_text=f"Channel {index}").first
        await collapse.locator('input[type="checkbox"]').first.check()
        await page.wait_for_selector(f"#ch_{index} [data-field='name']")

        audit_name = f"PW{int(time.time()) % 100000:05d}"[:8]
        await page.locator(f"#ch_{index} [data-field='name']").fill(audit_name)
        await page.locator(f"#ch_{index} [data-field='role']").select_option("SECONDARY")
        save = collapse.get_by_role("button", name="Save", exact=True)
        attempted = True
        await save.click()
        await page.wait_for_function(
            """({index,target}) => {
              const d=document.querySelector('[x-data="dashboard()"]')?._x_dataStack?.[0];
              const op=d?.ops?.[`ch_${index}_${target}`];
              return !!op && (op.ok === true || !!op.err);
            }""",
            {"index": index, "target": OMNI_NODE_ID},
            timeout=90_000,
        )
        op_state = await page.evaluate(
            """({index,target}) => {
              const d=document.querySelector('[x-data="dashboard()"]')?._x_dataStack?.[0];
              return d?.ops?.[`ch_${index}_${target}`] || null;
            }""",
            {"index": index, "target": OMNI_NODE_ID},
        )
        RESULTS.check(bool(op_state and op_state.get("ok")), "channel Save reaches success UI")

        local = await page.evaluate(
            """({index,target,name}) => {
              const d=document.querySelector('[x-data="dashboard()"]')?._x_dataStack?.[0];
              const ch=d?.channels?.find(x => x.index === index)?.data;
              return ch?.role === 'SECONDARY' && ch?.settings?.name === name;
            }""",
            {"index": index, "target": OMNI_NODE_ID, "name": audit_name},
        )
        RESULTS.check(local, "channel UI retains accepted values")

        # mesh-gw's bulk channel cache is stale until the next device sync.
        # Resync OMNI only, then verify what the radio persisted.
        await resync_omni(page)
        readback = await api_json(page, f"/{OMNI_NODE_ID}/channels")
        changed = channel_at(readback, index)
        RESULTS.check(
            changed.get("role") == "SECONDARY"
            and (changed.get("settings") or {}).get("name") == audit_name,
            "channel bulk read-back matches saved values",
            "read-back did not contain audit name/role",
        )
    except Exception as exc:
        RESULTS.check(False, "OMNI channel round-trip completed", str(exc))
    finally:
        if attempted and original is not None:
            try:
                await wait_omni_ready(page)
                await restore_channel(page, index, original)
                await resync_omni(page)
                restored = channel_at(
                    await api_json(page, f"/{OMNI_NODE_ID}/channels"), index
                )
                clean = not (restored.get("settings") or {}) and not restored.get("role")
                RESULTS.check(clean, f"OMNI channel {index} restored unused")
            except Exception as exc:
                RESULTS.check(False, f"OMNI channel {index} restoration", str(exc))
        if OMNI_MAC:
            try:
                await api_request(
                    page,
                    f"/ble_devices/{quote(OMNI_MAC, safe='')}",
                    "PATCH",
                    {"auto_connect": True},
                )
                await wait_omni_ready(page)
            except Exception as exc:
                RESULTS.check(False, "OMNI final ready/auto-connect restoration", str(exc))
        await context.close()


async def _node_page_facts(page, path: str) -> dict:
    """Section ids on a node page, plus whether any stat-desc is truncated."""
    await page.goto(BASE + path, wait_until="domcontentloaded")
    await settle_app(page)
    await page.wait_for_timeout(1200)  # node_status is an RPC — let the reply land
    return await page.evaluate(
        """() => {
            const d = Alpine.$data(document.querySelector('[x-data]'));
            const s = d.nodeStatus || {};
            return {
              found: !!s.found,
              sections: (s.sections || []).map(x => x.id),
              headerFields: ((s.header || {}).fields || []).map(f => f.label),
              clippedDescs: [...document.querySelectorAll('.stat-desc')]
                .filter(e => e.scrollWidth > e.clientWidth + 1)
                .map(e => e.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60)),
            };
        }"""
    )


async def audit_plugin_boundary(browser) -> None:
    """The alarm is a PLUGIN: additive, and it must never alter core.

    Peter, 2026-07-29: "node-dash exists with or without the alarm. alarm is
    addative, it changes nothing about node communications, stats, messages."

    Verified from the browser without unwiring anything: an alarm unit gains a
    section an ordinary node does not, and every CORE section behaves the same
    on both. If a future change makes core branch on the plugin, the core-node
    assertions here are what break.

    Also guards `stat-desc` truncation (2dd2540): a clipped desc silently hides
    the provenance qualifier — that is how "886 failed since" disappeared.
    """
    print("\nPLUGIN BOUNDARY (alarm is additive)")
    context = await browser.new_context(viewport=VIEWPORTS["desktop"])
    page = await context.new_page()
    page.set_default_timeout(TIMEOUT)
    try:
        alarm = await _node_page_facts(page, f"/node/{ALARM_NODE_ID}")
        core = await _node_page_facts(page, f"/node/{CORE_NODE_ID}")

        RESULTS.check(alarm["found"], "alarm node page found", json.dumps(alarm))
        RESULTS.check(core["found"], "core node page found", json.dumps(core))

        # The plugin ADDS.
        RESULTS.check(
            "reachability" in alarm["sections"],
            "alarm node has plugin section",
            f"sections={alarm['sections']}",
        )
        # ...and only for its own units.
        RESULTS.check(
            "reachability" not in core["sections"],
            "core node has NO plugin section",
            f"sections={core['sections']}",
        )
        # ...and never alters core. Every core section a node qualifies for is
        # present regardless of whether the plugin contributed anything.
        core_only = [s for s in alarm["sections"] if s != "reachability"]
        RESULTS.check(
            "device_vitals" in core_only,
            "core sections unaffected on an alarm node",
            f"sections={alarm['sections']}",
        )
        RESULTS.check(
            "device_vitals" in core["sections"],
            "core sections present on a core node",
            f"sections={core['sections']}",
        )
        # The plugin contributes SECTIONS, never header fields. Asserting a
        # specific field would be wrong: `Least hops` comes from `messages`, so
        # a node that sends no text has none — that is correct behaviour, and an
        # earlier version of this check failed on it. The real property is that
        # NO plugin-owned label ever reaches the header, on either node.
        plugin_labels = {
            "Delivery", "Next window", "Beat", "Window",
            "Wake reliability", "Awake", "TX radio",
        }
        for label, facts in (("alarm", alarm), ("core", core)):
            leaked = sorted(plugin_labels.intersection(facts["headerFields"]))
            RESULTS.check(
                not leaked,
                f"{label} node header free of plugin fields",
                f"leaked={leaked} fields={facts['headerFields']}",
            )
            RESULTS.check(
                bool(facts["headerFields"]),
                f"{label} node header has core fields",
                f"fields={facts['headerFields']}",
            )

        # Provenance qualifiers must be readable, not ellipsised away.
        for label, facts in (("alarm", alarm), ("core", core)):
            RESULTS.check(
                not facts["clippedDescs"],
                f"{label} node stat-desc not truncated",
                " | ".join(facts["clippedDescs"]),
            )
    except Exception as exc:
        RESULTS.check(False, "plugin boundary audit completed", str(exc))
    await context.close()


def root_artifacts() -> list[str]:
    suffixes = {".png", ".jpg", ".jpeg", ".webp", ".zip", ".trace"}
    return [p.name for p in Path(".").iterdir() if p.is_file() and p.suffix.lower() in suffixes]


async def main() -> int:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"node-dash Playwright audit — {BASE}")
    print(f"artifacts: {ARTIFACT_DIR}")
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=HEADLESS)
        await audit_routes(browser)
        await audit_plugin_boundary(browser)
        await audit_invalid_persisted_tab(browser)
        await audit_safe_interactions(browser)
        await audit_live_channel(browser)
        await browser.close()

    RESULTS.check(not root_artifacts(), "no root-level browser artifacts", ", ".join(root_artifacts()))
    print(f"\nRESULT: {RESULTS.passed} passed, {RESULTS.failed} failed")
    if RESULTS.failures:
        for failure in RESULTS.failures:
            print(f"  - {failure}")
    return 0 if RESULTS.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
