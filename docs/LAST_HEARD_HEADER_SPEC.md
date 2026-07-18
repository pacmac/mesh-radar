# Last heard — promote to a header display value

Backlog #17. Peter: *"something missing from the header is the last Heard. that
is VERY important"*.

Names `docs/STYLE_GUIDE.md` (§8.6).

## Precisely what is wrong

Last heard is **not missing** — it renders under the node name as caption text:

```html
<div class="text-xs text-base-content/50">
  Last heard <span x-text="…last_heard.text"></span> · <span x-text="…ago"></span>
</div>
```

It is present but is the **least prominent element on the page**, while battery
and voltage get the 26 px display-value role. On a page whose job is *what is
this node doing*, whether it is still alive is the first question — and it is
currently a footnote.

## The change

Last heard becomes the **first field in the vitals row**, using the §3
display-value role like the others:

```
LAST HEARD   BATTERY  VOLTAGE  UPTIME   BOOTS  CHAN UTIL  AIR UTIL TX  SIGNAL
3s ago       100%     4.29 V   40m 10s  1      22.7%      10.4%        ▂▄▆█ -29 dBm
2026-07-18 14:45:12
```

- The **relative age** is the display value — that is the at-a-glance answer.
- The **absolute timestamp** sits beneath as a caption, so the exact moment is
  still available without a second lookup.
- The duplicate caption line under the node name is removed.

Both strings are already computed server-side (`fmtAgo`, `fmtTimestamp`) and
already travel in `header.last_heard` as `{raw, text, ago}` — this is a
presentation change only. **No backend change.**

## Why first rather than alongside

The vitals answer "how is it"; last heard answers "is it there at all". A stale
battery reading from six hours ago is misleading unless the reader sees the age
first, so it leads the row.

## Files

| File | Change |
|---|---|
| `public/partials/tab-node.html` | render last heard as the leading display-value field; drop the caption line |
| `docs/modules/app-node-status.md` | note the header ordering |

## NOT changed

- `src/node-status.js` — the payload already carries everything needed.
- No live-ticking of the relative age. The server computes `ago` at emission and
  the page re-requests on `node_status_update`; a browser timer recomputing it
  would be the browser computing a displayed value (iron rule 1), which is the
  same reason the "1s liveness tick" in the original step title was never built.

## Invariants

- Values still bound verbatim from the server; no date maths in the browser.
- Absent `last_heard` omits the field rather than rendering a placeholder.
- Type roles per §3: display value for the age, caption for the timestamp.

## Done when

- Last heard leads the vitals row at display-value size
- The absolute timestamp remains visible as its caption
- 1440×900, both themes, zero console errors
- `check_specs.py` green
