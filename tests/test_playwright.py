"""
Structured node-dash browser acceptance audit.

Passive only. The guarded OMNI channel write/read-back/restore test and the
Devices-page safe-interaction check were removed 2026-09-03 (task
devices-removal-residue-cleanup) — the page and the write path they drove
(Devices -> Channels -> Save, channel_config op) are gone. mesh-gw's own
dashboard owns radio config editing now; there is nothing left here to
exercise it through.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import Page, async_playwright


BASE = os.environ.get("NODE_DASH_URL", "http://localhost:8000").rstrip("/")
HEADLESS = os.environ.get("PLAYWRIGHT_HEADLESS", "1") != "0"
TIMEOUT = int(os.environ.get("PLAYWRIGHT_TIMEOUT", "15000"))
ARTIFACT_DIR = Path(os.environ.get("PLAYWRIGHT_ARTIFACT_DIR", ".playwright-mcp/audit"))
OMNI_NODE_ID = os.environ.get("PLAYWRIGHT_OMNI_NODE_ID", "!2687afb1")
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
    # No /messages case: the compose/read UI left 2026-09-03
    # (messages-frontend-and-browser-route-removed) — mesh-gw's own dashboard
    # Messages page is the only UI now.
    RouteCase("/config", "cfg", ("Bridge", "Rotator", "Modes", "Radar", "Alerts"), "config"),
    # No /device-config or /devices case: the Devices page left 2026-09-03
    # (devices-management-removed-meshgw-owns-it) — mesh-gw's own Radios page
    # owns device management now. `/devices` still exists as a backend
    # device-listing endpoint (test_node.py exercises its WS-only guard
    # directly), but there is no browser page or tab for it any more.
    RouteCase("/range", "range", ("Range Test Log",), "range"),
    # "Traceroute History" dropped 2026-08-18: the surface was stripped from this
    # page on 2026-08-17 (86400ab, docs/modules/traceroute-removal-browser.md)
    # because its buttons were still transmitting. The assertion outlived it.
    RouteCase("/performance", "perf", ("Performance",), "performance"),
    # NO /control CASE, and this absence is deliberate — do not re-add it.
    # The alarm left node-dash in e8a6745 (2026-08-17) and the Control page now
    # serves from mt-alarm-1 on :8791. Peter, 2026-08-18: "alarm should have left
    # node dash and should be removed."
    # `audit_invalid_persisted_tab` asserts the removal from the other side —
    # a persisted activeTab:'control' must fall back to Overview.
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

    await page.goto(BASE + "/performance", wait_until="domcontentloaded")
    await settle_app(page)
    # No Simple/Expert toggle since 2026-08-17 (traceroute-removal-browser) —
    # the page dropped every traceroute-derived measurement and now shows
    # link-budget theory only. Nothing left to toggle; assert the theory
    # heading that replaced it instead.
    RESULTS.check(
        await page.get_by_text("Link budget — theory", exact=True).is_visible(),
        "Performance link-budget theory section renders",
    )
    await context.close()


# channel_at, api_json, api_request, wait_op, restore_channel, wait_omni_ready,
# resync_omni, and audit_live_channel — the OMNI channel write/read-back/
# restore apparatus — were removed 2026-09-03 (task
# devices-removal-residue-cleanup). They drove the write through the Devices
# page's Channels UI and the channel_config op, both deleted
# (devices-management-removed-meshgw-owns-it). mesh-gw's own dashboard owns
# radio config editing now; this suite has no write path left to guard.


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
    """The alarm has LEFT, and an alarm unit is now an ordinary node.

    Peter, 2026-07-29: "node-dash exists with or without the alarm. alarm is
    addative, it changes nothing about node communications, stats, messages."
    That was proven the additive way while the plugin lived here.

    It no longer does — e8a6745 (2026-08-17) moved the alarm out to its own
    service on :8791, and Peter, 2026-08-18: "alarm should have left node dash
    and should be removed." So the same property is now asserted from the other
    direction: an alarm unit must show NO plugin section, while every CORE
    section behaves identically on an alarm unit and an ordinary one.

    That the alarm units still appear here at all is not a leftover. Our radios
    hear them, so they are nodes like anyone else's — see
    docs/ALARM_TRANSPORT_BOUNDARY.md. Meshtastic is their transport, never their
    application, and nothing about their behaviour follows from it.

    If a future change makes core branch on a plugin, or drags alarm UI back into
    core, the assertions here are what break.

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

        # THE PLUGIN IS GONE, AND THIS ASSERTION WAS INVERTED RATHER THAN DELETED
        # (2026-08-18). It used to read `"reachability" in alarm["sections"]`,
        # because the alarm plugin ADDED that section. The alarm left node-dash in
        # e8a6745 and now runs as its own service on :8791, so the section is
        # correctly absent — and deleting the check would have thrown away the
        # coverage. Inverted, it guards the REMOVAL: if alarm UI ever creeps back
        # into core, this goes red.
        RESULTS.check(
            "reachability" not in alarm["sections"],
            "alarm node has NO plugin section",
            f"sections={alarm['sections']}",
        )
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
        await browser.close()

    RESULTS.check(not root_artifacts(), "no root-level browser artifacts", ", ".join(root_artifacts()))
    print(f"\nRESULT: {RESULTS.passed} passed, {RESULTS.failed} failed")
    if RESULTS.failures:
        for failure in RESULTS.failures:
            print(f"  - {failure}")
    return 0 if RESULTS.failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
