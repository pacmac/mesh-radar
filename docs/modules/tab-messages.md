---
module: tab-messages
source: public/partials/tab-messages.html
source_hash: 54bbc5d01e2e7e708085a575f8c04f2769eb9e57cec7c052db67e3effc4e55f1
updated: 2026-07-02
---

# Module: tab-messages

## Purpose

Messages page: compose card (device/recipient/channel selection, @mention
autocomplete, quick emoji) and message feed card. Presentation only.

## Scope

**STYLE_GUIDE.md compliance refactor (task `messages-refactor`).** Zero logic
changes.

Files in scope: `public/partials/tab-messages.html` only.
NOT changed: `public/app-messages.js`, all other files.

## Changes

| Location | Before | After |
|---|---|---|
| Form row labels From/To/Ch (l.10, 23, 41) | `text-xs text-base-content/60` | `text-sm text-base-content/60` |
| From/To segmented joins (l.13, 25–26) | `btn-xs` | `btn-sm` (compose form controls, not dense rows) |
| Direct-recipient select (l.28) | `select-xs` | `select-sm` (matches channel select) |
| Reply indicator strip (l.50) | `text-xs` | `text-sm` (interactive element) |
| Direction dot (l.110) | `w-3.5 h-3.5 … text-[9px]` | `w-4 h-4 … text-xs` (banned px size; dot grows 2px) |

Kept as-is (sanctioned):
- `:style` reply-depth indent — runtime-computed from data (§7)
- Mention autocomplete `menu-xs` + `text-xs` — dense list
- Ack status / device badges `text-xs`/`badge-xs` — feed metadata captions
- Message body `text-base` — user content, not UI chrome; deliberate emphasis
- "→ node" hint `text-xs` — caption

## Invariants

- Zero changes to Alpine expressions/handlers; send flow untouched
- No raw colors; the only remaining `text-[...]` arbitrary sizes are removed

## Test notes

Playwright, both themes (guide §8): compose controls legible, joins at sm,
feed renders; data check — first rendered feed texts/senders match
`GET /messages`; 0 console errors.
