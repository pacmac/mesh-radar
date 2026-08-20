---
module: tab-messages
source:
  - public/partials/tab-messages.html
  - public/app-messages.js
  - src/filters.js
source_hash: 2af1427c0ba3cf59c5b9cbc8ef7548d92957506f29bfb091eece7155031f6dc3
updated: 2026-08-20
---

# The messages page is a chat, not a log

Peter, 2026-08-20:

> the order that messages are displayed seems to be completely random. in fact
> this whole page is not very intuitive at all and needs re-designing

> we should display messages like the phone app does it

## First, the ordering is not random

Measured before changing anything — the served list is strictly descending by
`ts`, **0 out-of-order transitions across 15 rows**. Two things make it *look*
random, and only one of them is this page's fault:

1. **Three YAGI rows dated in the future** (up to ~14 h ahead) sit pinned at the
   top and never move. Registered separately as
   `messages-carry-timestamps-hours-in-the-future`; **not fixed here**.
2. **Nothing anchors the eye.** One flat firehose of 12,779 rows with no
   conversation boundary, no sender continuity, no date break, and replies drawn
   with no visible relationship to what they answer. Correct order, unreadable
   presentation. That is what this task fixes.

**No `display_stamp` column.** Peter proposed one — a stored sort key that a reply
bumps — and asked for a better way. The app's answer is better, and the app does
not reorder anything at all. A bump-on-reply key is a second source of truth for
"when" (we already have one open timestamp defect), it mutates the past so a
message you read at position 20 jumps to position 1 hours later, it does not
compose for reply-to-a-reply, and it destroys "position means time".

## What the app actually does

From `feature/messaging/`, read rather than inferred from the screenshot:

| behaviour | evidence |
|---|---|
| newest at the **bottom**, oldest above | `MessageListPaged.kt:226` — `reverseLayout = true` |
| *(we deliberately differ — see below)* | |
| **per-conversation**, never one global list | `viewModel.getMessagesFromPaged(contactKey)` |
| a reply renders **a snippet of its parent** above itself | `MessageScreenComponents.kt:178` — `ReplySnippet(originalMessage, …)` |
| reactions attach to their message | `message.emojis`, `onSendReaction(emoji, replyId)` |
| an unread divider, not a badge | `UnreadMessagesDivider` |
| full timestamps are a **toggle**, not always on | `showFullMessageTimestamps` |

The screenshot shows the consequence: the same parent quoted twice, above each of
the two replies to it, while the parent itself stays where it was sent.

## The conversation model

A conversation is the app's `contactKey`. Ours is derivable from what is already
served — no new storage:

- **a channel** — `is_dm = 0`, grouped by `channel_name`
- **a direct message** — `is_dm = 1`, grouped by the *other* node
  (`from_num` when they sent it, `to_num` when we did)

Measured: 11,202 broadcast rows, 1,577 DM rows across **13** distinct partners.

The page becomes a **list of conversations**, each showing its latest line and
time, and an **open conversation** rendered as a chat.

## NEWEST AT THE TOP — the one place we do not copy the app

Peter, 2026-08-20, asked directly and answered directly: **"no newest at the TOP"**.

The app is bottom-anchored (`reverseLayout = true`) because it is a phone
messenger you talk *into*. This is a dashboard you *read*, usually to see what
just happened, and the newest line should be where the eye lands without
scrolling. That is a product decision about his dashboard, not a correctness
question, and it is his.

**The consequence, stated because it changes what the quote is for.** With newest
first, a reply is rendered **above** the message it answers — the parent is
further *down* the page, not up. So the quoted snippet is not a convenience here;
it is the only thing carrying the context, because scrolling toward the parent
means scrolling the wrong way through time. Every reply must show its quote.

Everything else in this document follows the app.

## The message row

Newest first, oldest below — the reverse of the app, per the section above.

- **sender heading** — `short_name` and `!id`, shown only when the sender changes,
  so a run from one node reads as one block
- **own messages** align right and are tinted; others align left
- **quoted parent** above any message with `reply_id`, showing the parent's sender
  and text, muted and outlined — the `ReplySnippet` shape
- **date separator** when the day changes
- **status** — the existing `status` field, on our own messages only
- **signal** — `snr`/`rssi`/`hops` stay available but are secondary, not part of
  the bubble line

## The one backend change

`src/filters.js` gains a resolved `reply_to` on each row: `{ packet_id,
short_name, text }` for the message this one answers, or `null`.

**Resolved server-side deliberately.** The browser could match `reply_id` against
`packet_id` within the loaded window, but the parent is frequently outside it —
3,595 rows carry a `reply_id`, and a reply to something older than the window
would silently render with no quote. Serving it means the quote is present or
explicitly absent, and the browser continues to decide nothing
(`docs/BROWSER_CONTRACT.md`).

## Explicitly NOT in this task

- **The future-timestamp rows.** Registered; fixing them here would mix a data
  defect into a presentation change.
- **Reactions.** The app has them; we have no emoji-reaction data on the wire yet.
  Rendering an empty affordance would imply a feature that does not exist.
- **Unread tracking.** There is no read state stored, so an unread divider would
  be invented rather than shown.
- **Sending.** The compose box, its channel words and its guards were changed
  hours ago in `2f381eb` and are not touched.
- **Search within a conversation.** The app has it; it is a separate task.

## Test notes

- a conversation list appears, with one entry per channel and one per DM partner
- opening a conversation shows only that conversation's messages
- within it, `ts` **decreases** downward: newest first, per Peter's instruction —
  the opposite of the app, and asserted so a later "make it match the app" change
  cannot silently flip it
- a message with `reply_id` renders a quote of its parent above it, with the
  parent's sender name
- a reply whose parent is outside the window still renders, with no quote rather
  than a broken one
- consecutive messages from one sender show the heading once
- the page renders at 1600x1000 and 1280x800, in both themes, with no horizontal
  overflow and nothing clipped
