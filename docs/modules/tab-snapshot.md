---
module: tab-snapshot
source: public/partials/tab-snapshot.html
source_hash: 1353b160c546494f936847eb610005e4da91e918bcdc842c77e63867ce027539
updated: 2026-08-06
---

# Module: tab-snapshot

## Purpose

The Snapshot board: one screen answering *how far can we get · what is new · are
we productive · is the machine working*. Presentation only.

## Sized by the shell — `h-full`, and no padding of its own

`h-full`, no `p-3`. This was `h-[calc(100vh-5.2rem)] p-3` and both halves were
wrong. Measured 2026-08-06 at 1280x800:

```
panel parent   .flex-1.min-h-0 > .h-full.p-3     top 39  bottom 800   <- ends AT the viewport
panel (old)    h-[calc(100vh-5.2rem)] p-3        top 52  bottom 764   <- 36px thrown away
```

The 5.2rem was a guess at the chrome above; the parent chain already resolves to
the viewport, so the guess only cost height. The parent also already applies
`p-3`, so the panel's own `p-3` was a second helping — another 25px. Together
that is 61px, and the cards below paid for all of it.

**The old spec said `h-full` "hung off screen by exactly the header height".**
That was true of an earlier shell and false of this one, and it was carried
forward for weeks as if it were a measurement. Re-measure before restoring any
calc: confirm the panel's parent bottom equals `innerHeight`. If a shell change
ever breaks that, fix the SHELL — every full-height page has the same need.

Rows are content-driven. Fixed `basis-[42%]` fractions broke at 1280x800 because
the card CONTENTS do not scale with the viewport.

## The two bands are not symmetric — `flex-[1.15]` and `flex-1`

Band 1 carries the ladder, whose rows are a fixed height each. Band 3 carries a
sparkline that shrinks freely and a health list with room to spare. An even split
starved the one that cannot shrink. Measured at 1280x800:

```
even split (flex-1 / flex-1)      ladder headroom  7px   health slack  86px
flex-[1.15] / flex-1              ladder headroom 28px   health slack  65px
```

Re-measure both if either card gains a row. A layout that fits with 7px to spare
is not fixed, it is about to break.

## Density, not deletion — how the 1280x800 overflow was actually closed

At 1280x800 the ladder needed 387px in 251 and the health list 295 in 179. **No
row was dropped and no scroll container was removed.** The height came from:

| change | why |
|---|---|
| bands wrapped in their own `gap-1` | a list of bars is not a stack of sections; the card-body `gap-3` was separating all twelve rows |
| ladder + health `!p-3 gap-2` | these two cards are the tightest on the page |
| ladder counts, both headings → `text-sm` | matches the labels already beside them |
| health rows → `text-sm`, `py-1` dropped | at 1280 this column is narrow enough that text-base label + text-base value could not share a line, so "Alert email" and "Last alert sent" WRAPPED — 61px rows against 35px. The `border-b` already separates rows; the padding added nothing it did not. |
| new-ground tiles `!p-3`, `text-3xl` | the caption wrapped at 245px wide, growing the strip 74px → 67px after |

Doors stay itemised at 2 with the remainder STATED. A third row costs ~22px of
the 28px headroom, which is not a margin. Raise the slice only against a fresh
measurement.

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

As of 2026-08-06 it does not need to: `tests/test_page_snapshot.py` reports
`cut 0` at 1600x1000 and 1280x800 in both themes. The `overflow-y-auto` stays as
the failure mode of last resort — a scrollbar is recoverable, a crop is not.

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
