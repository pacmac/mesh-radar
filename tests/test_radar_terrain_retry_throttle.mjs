// app-radar.js's _drawRadarTerrain() retries _loadTerrain() whenever
// terrainData is null, and the retry's .finally() calls drawRadar() again —
// which re-enters _drawRadarTerrain(), finds terrainData still null (terrain
// was never sampled), and retries again. Nothing throttles this: on a fresh
// deployment where nobody has ever run POST /terrain/sample (the Pi), this
// is an unthrottled async retry loop that starves the browser's event loop
// completely — confirmed live via Playwright: even a trivial `1+1`
// page.evaluate() hung on http://192.168.0.97:8003/radar, while the root
// page and a raw WS connection both worked fine. This is almost certainly
// what Peter saw as "the page won't load at all" on the fresh Pi deployment
// (which has no sampled terrain), independent of the ws-relay memory leak
// fixed earlier in this session. idiot entry
// radar-terrain-retry-loop-wedges-browser. Spec: docs/modules/app-radar.md.
import assert from 'node:assert/strict';

global.document = {
  getElementById(id) {
    if (id === 'radar-terrain-img') {
      return { _href: '', getAttribute() { return this._href; }, setAttribute(_, v) { this._href = v; } };
    }
    return null; // radar-horizon-path: code uses `path?.setAttribute`, null is fine
  },
  createElement() {
    return { width: 0, height: 0, getContext() { return { beginPath(){}, arc(){}, closePath(){}, fill(){}, set fillStyle(_){} }; }, toDataURL() { return 'data:image/png;base64,'; } };
  },
};

const { radarMixin } = await import('../public/app-radar.js');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };

const SAFETY_CAP = 50; // real code must stay at 1; this only exists so a still-broken
                        // retry loop terminates THIS test instead of hanging it forever,
                        // exactly as it hangs the real browser's event loop.

function freshComponent() {
  const comp = Object.create(radarMixin);
  comp.terrainData = null;         // never sampled — the Pi's actual state
  comp.radarLogScale = false;
  comp.radarLayers = [];
  let wsSendCount = 0;
  comp.wsSend = () => {
    wsSendCount++;
    // _loadTerrain() wraps this call in its own try/catch ("a failed nudge is
    // not fatal"), which would silently swallow a thrown Error and let the
    // loop run forever — process.exit() bypasses that entirely, which is the
    // whole point: it terminates THIS test the instant an unbounded retry is
    // confirmed, rather than letting it hang exactly as the real browser does.
    if (wsSendCount > SAFETY_CAP) {
      console.log(`FAIL: SAFETY_CAP exceeded — unthrottled retry loop confirmed (>${SAFETY_CAP} sends with no real data ever arriving)`);
      process.exit(1);
    }
  };
  // Real recursive wiring: drawRadar() re-entering _drawRadarTerrain is
  // exactly the mechanism that makes this a LOOP rather than one retry.
  comp.drawRadar = () => comp._drawRadarTerrain(50);
  return { comp, wsSendCount: () => wsSendCount };
}

{
  const { comp, wsSendCount } = freshComponent();
  comp._drawRadarTerrain(50);
  // Give a few real event-loop turns a chance to run — enough for a FIXED,
  // one-shot implementation to settle at 1. If the retry is still
  // unthrottled, wsSend's process.exit(1) above fires well before this
  // resolves, so reaching this line at all is already partial evidence.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 200));
  ok(wsSendCount() <= 1,
     `terrain nudge is sent at most once per page load while terrain stays unsampled, not retried in an unthrottled loop (saw ${wsSendCount()} sends)`);
}

console.log(`radar terrain retry throttle: ${checks} checks passed`);
