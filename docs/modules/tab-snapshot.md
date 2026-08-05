---
module: tab-snapshot
source: public/partials/tab-snapshot.html
source_hash: c4939741e4ec32f6526d1608a28a8fb91f3fd32bd9d8a9a91625e5b0706bc629
updated: 2026-08-05
---

# Module: tab-snapshot

## Purpose

The Snapshot board: one screen answering *how far can we get · what is new · are
we productive · is the machine working*. Presentation only.

## Sized to the viewport, not the parent

`h-[calc(100vh-5.2rem)]`. `h-full` resolves to the PARENT, which starts below the
top bar, so the page hung off screen by exactly the header height — and the "no
scroll" check passed because the container fits *itself*.

Rows are content-driven. Fixed `basis-[42%]` fractions broke at 1280x800 because
the card CONTENTS do not scale with the viewport.

**The layout check, all three levels:**

```
per .card-body   scrollHeight > clientHeight   content cropped
per .card        rect.bottom > innerHeight     off screen
per leaf         rect.bottom > innerHeight     text cut
```

Measuring only `.card` reported clean while `.card-body` was cropping. Adding
`overflow-hidden` earlier converted a visible overlap into a silent crop, which
is worse.

## Scroll inside a card beats losing rows

"No scrolling" governs the PAGE. The ladder/doors card scrolls as one region when
it cannot fit; an earlier version deleted door rows to make them fit, which is
discarding data to fix CSS.

## Nothing on this page may be invented

Every value is bound to a served field. Removed as fabrication: six health rows
("sent 11:38", "within budget"), four header badges, a hand-plotted sparkline, a
"beam misaligned" marker placed by eye, and the ruler's typed tick positions —
the density was the whole point of the instrument, so inventing it was the worst
of them.

The ruler now maps served `ticks` (one per heard node) to a percentage of the
served `scale_max_km`. Solid = heard with no relay.

## SVG must not be stretched

`preserveAspectRatio="none"` distorts. The sparkline uses `xMidYMid meet`; the
ruler is CSS percentages, which cannot distort at any width.

## Style

DaisyUI tokens only, no raw hex, no px font sizes (`STYLE_GUIDE` §2/§4). Type is
scaled to the card it sits in — the first pass had `0.58rem` captions inside
viewport-height cards.
