#!/usr/bin/env python3
"""UI contract test for the Snapshot page.

Peter, 2026-08-05: "for every page, we have a test script, that script will test
every button and action on the page, and verify that the data shown matches what
should be shown."

This exists because metrics-only checks passed while the page was broken:

  - five hard-coded zeros passed every check (they rendered perfectly)
  - a commit DELETED the new-ground, productivity and health sections and every
    layout check still reported 0 overflow / 0 past-fold, because those checks
    only measure elements that EXIST

So it asserts three things no earlier check did:

  1. PRESENCE  every section is on the page. Deleting one fails loudly.
  2. ACTION    every button does something, and the render CHANGES.
  3. TRUTH     the number on screen equals the number the API served.

Run:  python tests/test_page_snapshot.py     (node-dash must be running)
Exit 0 pass, 1 fail.
"""
from __future__ import annotations
import asyncio, json, os, sys, urllib.request

BASE = os.environ.get("DASH_URL", "http://localhost:8000")
SIZES = [(1600, 1000), (1280, 800)]
THEMES = ["business", "corporate"]

# A page that renders beautifully with a third of it missing is what this catches.
SECTIONS = [
    ("hero",         "furthest heard"),
    ("ladder",       "Where the mesh lives"),
    ("new ground",   "first-ever contacts"),
    ("productivity", "Are we productive"),
    ("health",       "Is the machine working"),
]

fails: list[str] = []
def fail(what, detail): fails.append(what); print(f"  FAIL  {what}\n        {detail}")
def ok(what): print(f"  ok    {what}")

WS_URL = BASE.replace("http", "ws", 1) + "/events"


async def board(days):
    """Ask the server for the board, the same way the page does.

    Peter, 2026-08-13: "no HTTP GETS for live data, ws feeds for everything
    except static data / forms." The five /snapshot/* GET routes are gone.

    This matters for the test and not only for the page: a contract test that
    reads a route the page no longer uses proves nothing about the page. TRUTH
    below compares the screen against what the SERVER SENT THE BROWSER, which
    is now this message.
    """
    import websockets
    async with websockets.connect(WS_URL, open_timeout=5, max_size=8 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"type": "snapshot", "days": days}))
        # Read past anything that is not OUR reply. Two things arrive that look
        # like one: the socket REPLAYS the board on connect at the server's
        # default window, and only then answers the window we asked for. Taking
        # the first `snapshot` message compared the screen against the default
        # window's numbers and failed on every window but that one.
        for _ in range(80):
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if msg.get("type") == "snapshot" and int(msg.get("days", -1)) == int(days):
                return msg
    raise RuntimeError(f"no snapshot reply for days={days} on the socket")

PANEL = """() => {
  const a = document.querySelector('[x-text*="furthest_km"]');
  return a ? a.closest('div[x-init]') : null;
}"""

async def main():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": SIZES[0][0], "height": SIZES[0][1]})
        await pg.goto(BASE, wait_until="domcontentloaded")
        await pg.evaluate("() => Alpine.$data(document.querySelector('[x-data]')).setNav('snapshot')")
        await pg.wait_for_timeout(1600)

        # 1. PRESENCE
        body = await pg.evaluate("() => { const p = (%s)(); return p ? p.textContent : ''; }" % PANEL)
        for name, marker in SECTIONS:
            if marker in body: ok(f"present: {name}")
            else: fail(f"section MISSING: {name}", f'no "{marker}" — deleted?')

        # 2. TRUTH — screen must equal what was served
        for days in (1, 7, 0):
            served = (await board(days)).get("frontier") or {}
            await pg.evaluate("d => Alpine.$data(document.querySelector('[x-data]')).setSnapWindow(d)", days)
            await pg.wait_for_timeout(900)
            shown = await pg.evaluate("""() => {
              const q = s => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; };
              return { furthest: q('[x-text*="furthest_km"]'), heard: q('[x-text*="snapFrontier?.heard"]') };
            }""")
            want = "—" if served.get("furthest_km") is None else str(served["furthest_km"])
            if shown["furthest"] == want: ok(f"truth: furthest_km {want} at days={days}")
            else: fail(f"screen disagrees with API at days={days}",
                       f'screen "{shown["furthest"]}" vs served "{want}"')
            if shown["heard"] == str(served.get("heard")): ok(f"truth: heard {served.get('heard')} at days={days}")
            else: fail(f"heard disagrees at days={days}",
                       f'screen "{shown["heard"]}" vs served "{served.get("heard")}"')

        # 3. ACTION — every button must change the render
        renders = await pg.evaluate("""async () => {
          const p = (%s)(); const out = [];
          for (const b of p.querySelectorAll('.join button')) {
            b.click(); await new Promise(r => setTimeout(r, 800));
            out.push(p.textContent.replace(/\\s+/g,' ').slice(0,240));
          }
          return out;
        }""" % PANEL)
        if len(renders) >= 6 and len(set(renders)) == len(renders):
            ok(f"action: {len(renders)} window buttons -> {len(set(renders))} distinct renders")
        else:
            fail("a window button changed nothing",
                 f"{len(renders)} buttons produced {len(set(renders))} distinct renders — "
                 "a value identical across windows is not window-derived")

        # 4. LAYOUT at every size and theme
        for w, h in SIZES:
            await pg.set_viewport_size({"width": w, "height": h})
            for theme in THEMES:
                await pg.evaluate("t => document.documentElement.setAttribute('data-theme', t)", theme)
                await pg.wait_for_timeout(450)
                r = await pg.evaluate("""() => {
                  const p = (%s)(); const vh = innerHeight;
                  return {
                    cut: [...p.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 1).length,
                    pastFold: [...p.querySelectorAll('.card')].filter(c => c.getBoundingClientRect().bottom > vh + 0.5).length,
                    leafBelow: [...p.querySelectorAll('*')].filter(e => !e.children.length && e.textContent.trim()
                                 && e.getBoundingClientRect().bottom > vh + 0.5).length,
                    pageScroll: (document.documentElement.scrollHeight > document.documentElement.clientHeight
                              || document.documentElement.scrollWidth > document.documentElement.clientWidth) ? 1 : 0,
                    empty: [...p.querySelectorAll('[x-text]')].filter(e => {
                      const t = e.textContent.trim();
                      return (t === '' || t === 'undefined' || t === 'null') && e.offsetParent !== null; }).length,
                  };
                }""" % PANEL)
                bad = {k: v for k, v in r.items() if v}
                tag = f"{w}x{h} {theme}"
                if not bad: ok(f"layout: {tag} clean")
                else: fail(f"layout: {tag}", " · ".join(f"{k}={v}" for k, v in bad.items()))

        await b.close()

asyncio.run(main())
print(f"\n{len(fails)} failure(s)" if fails else "\nSnapshot page contract clean.")
sys.exit(1 if fails else 0)
