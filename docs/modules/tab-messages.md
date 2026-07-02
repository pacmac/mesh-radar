---
module: tab-messages
source: public/partials/tab-messages.html
source_hash: de7b8cd7fe6cb5c4b813ed20f0bb3e8769709ebf6aab100361e2430368342911
updated: 2026-07-02
---

# Module: tab-messages

## Purpose

Messages page: compose card (device/recipient/channel selection, @mention
autocomplete, quick emoji) and message feed card. Presentation only.

## Scope

**STYLE_GUIDE.md compliance refactor (task `messages-refactor`).** Zero logic
changes.

Files in scope (style task): `public/partials/tab-messages.html`.
Files in scope (message-flow-audit): `public/partials/tab-messages.html`,
`public/app-ws.js` (packet dedupe — see docs/modules/app-ws.md),
`public/app.js` (msgHistory seed removed),
`public/app-messages.js` (msgHistory localStorage write removed).
NOT changed: `src/messages-api.js`, `src/ws-relay.js` (backend verified
correct against the gw V2 contract).

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

## Message-flow fixes (task `message-flow-audit`)

**Live RX dedupe (fixes frozen feed):** with multiple radios the same mesh
packet arrives as one `packet` event per radio. The handler now dedupes by
`pktId`: the first arrival appends; later arrivals merge their source device
into `src` and fill missing rssi/snr — never a second entry. Duplicate feed
entries previously produced duplicate `x-for` keys, crashing Alpine's keyed
renderer and freezing the feed until reload.

**Feed keys:** `:key` composes `_txKey || pktId + '_' + direction` so a key
collision is structurally impossible.

**V2 status vocabulary:** the ACK indicator maps the gw V2 `message_status`
states (API_SSE §message_status): `sent`/`queued` → ✓ (dim), `relayed` → ↻
(warning), `delivered` → ✓✓ (success, with ack node), `failed`/`no_ack`/
`queue_failed` → ✕ (error), `no_ack_needed` → ✓ (broadcast terminal — no
receipt possible). "awaiting ACK…" shows for DMs in non-terminal states.
Legacy V1 names (acked/confirmed/sending/retrying) removed.

**localStorage msgHistory seed removed** (BROWSER_ARCH messages[] writer
consolidation): `messages[]` is written only by `message_history` (replace),
the live `packet` append, and the optimistic TX entry (sanctioned deviation:
reconciled via the `pkt_id` hint sent to the gw, so status events match).

## Invariants

- Zero changes to Alpine expressions/handlers; send flow untouched
- No raw colors; the only remaining `text-[...]` arbitrary sizes are removed

## Test notes

Playwright, both themes (guide §8): compose controls legible, joins at sm,
feed renders; data check — first rendered feed texts/senders match
`GET /messages`; 0 console errors.
