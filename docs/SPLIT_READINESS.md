# Split readiness — what it actually costs to make `public/` its own repo

Peter, 2026-08-04: *"I am considering making this it's own repo, it has grown too
much to be managed as node dash."*

This is the cost, measured rather than estimated. Every item is a thing that
breaks, gets duplicated, or becomes an API on the day the repo separates.

Measured 2026-08-04 against the live tree.

---

## Verdict up front

**Three structural blockers, one large logic debt, and a contract that is already
most of the way to being an API.**

Nothing here is fatal, and the WS contract is in better shape than expected. The
work is concentrated in two files.

| # | blocker | severity | cost |
|---|---|---|---|
| 1 | `src/utils.js` served to the browser | **hard** | small — decide once |
| 2 | server assembles the browser's HTML | **hard** | medium |
| 3 | RF physics in `app-perf.js` | **hard** | medium–large |
| 4 | radar's quantile scale | soft | small |
| 5 | verdict strings scattered in `public/` | soft | small, but repeats |
| 6 | 54 WS types + ~20 REST routes | already an API | document it |

---

## 1. A source file lives on both sides of the boundary — HARD

`src/index.js:152`:

```js
// Serve src/utils.js to the browser as a classic script — true SSOT.
app.get('/utils.js', ...)
```

`public/index.html` loads `/utils.js`, and `public/app-helpers.js` re-exports its
window globals (`haversine`, `bearing`, `signalQuality`, `numToNodeId`,
`nodeIdToNum`). One file, two domains, today resolved by serving backend source
into the browser.

**This is not hypothetical.** It already caused a defect: the first attempt at
moving the SNR decoder out of the browser put it in `utils.js`, which would have
shipped the Meshtastic wire format straight back. Peter caught it — *"but this is
supposed to be a stand alone module and NOT mixed in with core?"*

Three options, and the choice is a real fork:

- **duplicate** — simplest, and they drift. `haversine` drifting between repos
  means two different answers to "how far away is it", which is the number this
  whole project exists to produce.
- **publish as a package** — correct, adds release machinery to a two-person
  project.
- **push it server-side** — the browser stops computing distance and renders the
  km it is given. Most aligned with `BROWSER_CONTRACT`, and the largest change.

Not a decision to take by accident, which is what happens if the split proceeds
without naming it.

## 2. The server assembles the browser's HTML — HARD

`src/index.js:167-176`. The backend reads `public/index.html`, finds
`<!-- include: filename -->` markers, and splices in `public/partials/*` **at
request time**. Plugin partials resolve relative to `public/`, core partials to
`public/partials/`.

So the backend is currently the browser repo's **build step**. After a split it
cannot read those files at all.

Options: move assembly into the browser repo as a real build; serve pre-built
static assets; or keep node-dash serving files it does not own, which is the
coupling being removed.

Note this also affects the plugin mechanism — `window.__dashPlugins` and the
alarm's partials — so `browser-plugin-boundary` (already parked) is entangled
with this one.

## 3. Radio physics in the presentation layer — HARD

`public/app-perf.js` computes, in the browser:

```js
sensitivity = -174 + 10*log10(bwHz) + RX_NOISE_FIGURE_DB + snrLimit   // Friis
fspl        = 20*log10(distKm) + 20*log10(freqMhz) + 32.45            // free-space path loss
noiseFloor  = -174 + 10*log10(bwHz) + RX_NOISE_FIGURE_DB
range       = 10^((lb - fspl1km) / (10*n))                            // inverted link budget
```

Thermal noise, receiver noise figure, EIRP, path loss, boosted-gain correction.
**A dashboard repo would ship LoRa link-budget physics.** It is also the same
class of defect as the SNR decoder just relocated (`3385c9a`) — protocol and RF
knowledge below the presentation line — only larger.

720 lines, ~10 sites of real maths, 7 verdict strings.

Cost: the backend must serve `snrTx`, `snrRx`, `marginTx`, `gapTx`, `validTx` and
the labels per row. That is a payload change plus deleting the maths — not
conceptually hard, but it is the biggest single item here.

## 4. The radar's adaptive scale — SOFT

`public/app-radar.js`, `_radarNorm` and `_radarScaleCtrl`: piecewise-linear
quantile scale computed from the displayed node distances, with 15% hysteresis.
13 sites of maths.

`docs/modules/app-radar.md` argues this is *"sanctioned display arithmetic
(derived from the displayed list, same class as the existing auto-range
computation) — no backend state"*, and that argument is defensible: it maps data
to screen space and decides nothing about the mesh.

**But the quantiles are a property of the data, not the screen.** The backend
already computes distances; computing their distribution twice invites the two
sides to disagree. Recommend the backend emit the control points and the browser
interpolate — small change, removes the ambiguity.

## 5. Verdict strings still forming in the browser — SOFT, but recurring

`app-observatory.js` (9), `app-perf.js` (7), `app-nodes.js` (4) contain ternaries
producing user-facing classifications.

Individually trivial. Collectively this is the rule that keeps being re-broken —
it is why `park-strip-browser-logic` exists, and I added five helpers to
`app-observatory.js` myself on 2026-08-03 while that item sat parked.

**A split makes this self-policing**: with the browser in another repo, a new
verdict string is visibly in the wrong place. That is an argument *for* splitting
rather than against.

## 6. The contract is already most of an API — GOOD NEWS

- **54 WS message types** consumed by `public/app-ws.js`
- **~20 REST routes**, nearly all `/config/*` writes plus device operations
- **`public/` imports nothing from `src/`** — verified, zero direct imports

The WS feed is already the transport for page data (`BROWSER_CONTRACT` §Transport
makes GET form-only), and observatory/alarm messages already route through
registered plugin hooks rather than named branches in core.

So the split does not require inventing an interface. It requires **writing down
the one that exists** and freezing it. `docs/API_WS.md` is listed in `CLAUDE.md`
as Phase 2 work and does not yet describe these 54 types.

---

## Recommended order

1. **Write `docs/API_WS.md`** from the 54 live types. Cheap, and it is the
   artefact both repos need whatever else is decided.
2. **Decide the `utils.js` fork** (§1). Everything else is easier once the shared
   file is resolved, and it is one decision rather than a body of work.
3. **Move the perf maths server-side** (§3). Largest item, clearest win, and it
   retires the last of the RF knowledge in `public/`.
4. **Radar control points** (§4) and **verdict strings** (§5) — do these with the
   split, not before it; they are cheap and the boundary will surface any missed.
5. **HTML assembly** (§2) last, with the plugin mechanism, since the two are
   entangled.

## What is already clean

Worth stating, because it is most of the recent work:

- `src/snr.js` — the wire format is backend-only and applied at the emit boundary
- `board.frontier` — `strip`, `reach`, `tone`, `kind`, `first_ever`, colour
  classes and window labels are all decided server-side
- `relayUsage` — `role`, `kind`, `is_router` decided server-side
- node labels, places, bearings and ages — resolved server-side, after an earlier
  breach where the browser resolved names from a filtered list and got four
- no direct `src/` imports from `public/`
