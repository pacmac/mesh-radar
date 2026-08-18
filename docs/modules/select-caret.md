---
module: select-caret
source:
  - public/style.css
source_hash: 0684184ea9b7f4727602823e012bad107fbe2cadcd728b1b58c06770398c081e
updated: 2026-08-18
---

# A dropdown must look like a dropdown

Peter, 2026-08-18: *"`<select>` in the app renders with appearance:none and no
caret - may as well fix that while its in memory"*.

Every `<select>` in the app — the radio config forms, and anything else using
daisyUI's `.select` — renders as a plain bordered box, visually identical to a
text input. There is nothing to indicate it can be opened.

## Cause: the `background` shorthand, not `appearance: none`

The ledger entry that raised this named `appearance: none` as the defect. That was
wrong, and correcting it matters, because "fixing" `appearance` would restore the
*native* arrow on top of daisyUI's and give two.

daisyUI draws its own caret, and `appearance: none` is what makes room for it —
`public/vendor/daisyui-4.12.14.min.css`:

```css
.select {
  appearance: none;
  background-image: linear-gradient(45deg,  transparent 50%, currentColor 50%),
                    linear-gradient(135deg, currentColor 50%, transparent 50%);
  background-position: calc(100% - 20px)   calc(1px + 50%),
                       calc(100% - 16.1px) calc(1px + 50%);
  background-size: 4px 4px, 4px 4px;
  background-repeat: no-repeat;
}
```

Two triangles forming a chevron, in `currentColor` so it follows the text colour
into either theme.

`public/style.css` then wipes it:

```css
.input, .select, .textarea {
  background: rgba(255,255,255,0.04) !important;
}
```

**`background` is the shorthand.** It resets every `background-*` longhand it does
not name, so `background-image` becomes `none` — and `!important` guarantees it
beats daisyUI. A rule that only ever meant to set a translucent tint deletes the
caret as a side effect.

## The change

Four rules, one edit each: `background` → `background-color`. Nothing else about
them changes, including the `!important`, which is still doing real work against
daisyUI's own background-color.

| line | selector | before | after |
|---|---|---|---|
| 354 | `.input, .select, .textarea` | `background:` | `background-color:` |
| 362 | `.input:focus, .select:focus, .textarea:focus` | `background:` | `background-color:` |
| 649 | `[data-theme="corporate"] .input, .select, .textarea` | `background:` | `background-color:` |
| 655 | `[data-theme="corporate"] …:focus` | `background:` | `background-color:` |

`.input` and `.textarea` ride along in the same rules and are unaffected in
practice: neither has a `background-image` to preserve, so shorthand and longhand
produce the same computed style for them. Switching to the longhand is still the
right call there — it stops the same trap being re-sprung if either ever gains
one.

### Explicitly NOT changed

- **`appearance: none`** stays. It is daisyUI's, it is deliberate, and removing it
  would produce two carets.
- **`.select:hover` (369) and `.select:disabled` (373)** set `border-color` and
  `opacity` only. Read, not inferred from proximity — they never touch
  `background`, so they cannot be implicated.
- **The vendored daisyUI CSS.** It is correct as shipped; the bug is ours.

## Test notes

The check is a computed-style assertion, because the failure is invisible to
markup — the `<select>` element, its classes and its options were all correct
throughout. Only `getComputedStyle` shows it.

- `getComputedStyle(select).backgroundImage` contains `linear-gradient`, in **both
  themes**
- it holds for a `type=enum` select (`role`) **and** a `type=choice` select
  (`device_update_interval`) — two different render paths, so a fix that only
  reached the new controls would be caught
- `appearance` is still `none` — the native arrow must not come back
- `backgroundColor` is still the tint the rules intend, i.e. the fix did not
  restore the caret by dropping the styling it was fighting with
