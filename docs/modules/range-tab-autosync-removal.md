---
module: range-tab-autosync-removal
source:
  - public/app-nav.js
  - public/app-range.js
source_hash: e5af728c06810e27a77ba32c9225390b620f645d5f01f2981a9a1cf8aaa81ce7
updated: 2026-08-18
---

# Removal: `_startRangeAutoSync()` is called and has never existed

## The defect

`public/app-nav.js:77`:

```js
else if (t === 'range') { this.loadRangeTest(); this.loadRangeTimer(); this._startRangeAutoSync(); }
```

`_startRangeAutoSync` is defined **nowhere in `public/`**. Opening the Range tab
throws `TypeError: this._startRangeAutoSync is not a function`.

## Evidence

Found 2026-08-18 by walking every tab in a real browser and catching per tab:

```
range: "THREW: this._startRangeAutoSync is not a function"
```

Every other tab (overview, radar, nodes, messages, perf, cfg, devices) returned
clean.

**Pre-existing, not introduced by tonight's traceroute work.** At `3b39449`
(before any of it) the call is present at `app-nav.js:76` and
`grep -c _startRangeAutoSync public/app-range.js` returns `0`. `git log -S` shows
the identifier last moved in `26fa060`; it has never been defined in
`app-range.js`.

## What the throw costs

`setNav()` runs the plugin activation loop **after** the per-tab chain:

```js
else if (t === 'range') { …throws here… }
…
for (const plugin of (window.__dashPlugins || [])) plugin.onTab?.[t]?.call(this, c);
```

So the throw aborts `setNav` before any plugin's `onTab` hook runs. The tab still
switches (`this.tab = t` happens earlier) and `loadRangeTest()` /
`loadRangeTimer()` have already run, which is why the page looks fine and the
fault has survived: it costs a plugin hook and an uncaught error, not the page.

## The change

Delete the call. One line, in `public/app-nav.js`.

**Not replaced with an implementation.** The name says "auto sync", which would
mean a timer polling range-test state — forbidden outright: *"NO TIMERS, NO
POLLING FULL STOP. WS OR NOTHING."* Range-test state already arrives on the WS
(`range_test_log`, `range_test_timer`, both replayed on connect and broadcast on
change), so there is nothing for an auto-sync to add. Writing one to satisfy the
call site would introduce the violation the call site's name implies.

## Out of scope

- `app-range.js:19`'s `setInterval` countdown. It is a browser timer deriving a
  value the server could serve, which is the same standing violation — but it is
  one of the six already recorded under `serve-time-so-the-browser-never-ticks`
  and belongs to that task, not this one.

## Test notes

Walk every tab in a real browser inside a `try`, and assert none throws. Range
must open with the log and timer populated and no console error.
