---
module: imap-receiver
source: src/imap-receiver.js
source_hash: 5261265266917408583d0a12bc188dd3dbd7e248f1ebb9ca1af29063e3d654a5
updated: 2026-06-30
---

# Module: imap-receiver

## Purpose

IMAP polling bridge. Reads unread emails from the gateway inbox every 60 seconds,
identifies replies to alert emails via the embedded `[reply:<token>]` subject tag,
strips quoted text from the reply body, and forwards the plain reply text back to
the originating mesh node via the bridge REST API.

## Responsibilities

- Poll IMAP inbox every 60 s for unseen messages
- Extract the reply token from the email subject (or `References`/`In-Reply-To` headers)
- Resolve the token to a reply context (device, mesh sender, channel) via `db.js`
- Strip email quoting and threading artifacts from the reply body
- Truncate reply text to 228 UTF-8 bytes (Meshtastic payload limit)
- POST the reply text to `BRIDGE_URL/<from_node_id>/messages`
- Consume the reply token after a successful send (one-use)
- Mark all processed messages as `\Seen` regardless of whether they carried a valid token

## Dependencies

- `imapflow` — IMAP client
- `mailparser` — email parsing (`simpleParser`)
- `db.js` — `getConfig`, `getReplyToken`, `consumeReplyToken`
- `BRIDGE_URL` — `process.env.BRIDGE_URL` (default `http://localhost:8001`)

## Exports

```js
export function startImapReceiver()   // start 60 s poll interval — call once at startup
export function stopImapReceiver()    // clear interval and close IMAP connection
```

## Config keys read (`alerts.*`)

| Key | Default | Meaning |
|---|---|---|
| `alerts.imap_host` | `''` | IMAP server hostname |
| `alerts.imap_port` | `993` | IMAP port (993 → TLS) |
| `alerts.smtp_user` | `''` | Username (shared with SMTP) |
| `alerts.smtp_pass` | `''` | Password (shared with SMTP) |

Config is read on every poll. No caching — credential changes take effect on next poll.

Note: IMAP uses `smtp_user`/`smtp_pass` config keys — IMAP and SMTP share the same mailbox credentials.

## `startImapReceiver()`

Sets `_pollTimer = setInterval(pollInbox, 60_000)`. Does not poll immediately on call — first poll fires after 60 s.

## `stopImapReceiver()`

Clears the interval and calls `_client?.close()` (silently ignores errors). `_client` is the active `ImapFlow` instance; it may be null if no poll is in progress.

Note: `stopImapReceiver` is exported but is not called anywhere in the current codebase. It exists for graceful shutdown support.

## Poll flow (`pollInbox → _processInbox → _handleMessage`)

```
pollInbox()
  → if _running: return (re-entrancy guard)
  → if !host or !user: return (unconfigured)
  → _running = true
  → _processInbox(cfg)
  → _running = false

_processInbox(cfg)
  → new ImapFlow({ secure: port===993, logger: false })
  → client.connect()
  → lock = getMailboxLock('INBOX')
  → uids = search({ seen: false })
  → if !uids.length: return
  → for each msg in fetch(uids, { source: true }):
      → _handleMessage(msg)     [errors logged, not thrown]
      → messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true })
  → lock.release()
  → client.logout()

_handleMessage(rawMsg)
  → parsed = simpleParser(rawMsg.source)
  → tokenMatch = subject.match(/\[reply:([0-9a-f-]{36})\]/i)
               || references.match(/reply-([0-9a-f-]{36})/i)
               || inReplyTo.match(/reply-([0-9a-f-]{36})/i)
  → if no match: return  (not a reply to our alert)
  → ctx = getReplyToken(token)
  → if !ctx: warn and return  (expired or unknown token)
  → replyText = _extractReplyBody(parsed.text)
  → if empty: warn and return
  → body = { text: truncateUtf8Bytes(replyText, 228), channel: ctx.channel ?? 0 }
  → if ctx.to_num != 0xffffffff: body.to = ctx.to_num
  → if ctx.reply_id: body.reply_id = ctx.reply_id
  → POST BRIDGE_URL/{ctx.from_node_id}/messages
  → if ok: consumeReplyToken(token); log
  → if error: log error (token NOT consumed — retry possible on next poll)
```

## Reply token resolution

`getReplyToken(token)` returns a context object stored when the original alert was sent:

| Field | Meaning |
|---|---|
| `from_node_id` | `!hexid` of the gateway radio to send from |
| `to_num` | Numeric node num to reply to (`0xffffffff` = broadcast) |
| `channel` | Meshtastic channel index |
| `reply_id` | Original `packet_id` for threading (optional) |

Token is a UUID created by `alerts.js` and stored in `db.js`. `consumeReplyToken` deletes it — tokens are single-use.

## `_extractReplyBody(text)` — quote stripping

Strips lines that:
- Start with `>` (standard email quoting)
- Match `/^On .+ wrote:$/i` (Gmail / Outlook "On Mon, 23 Jun wrote:" attribution line)

Trailing blank lines are then removed. The result is the human-written reply body only.

## `truncateUtf8Bytes(str, maxBytes)` — payload truncation

Encodes the string to a UTF-8 `Buffer`, slices to `maxBytes` (228), then decodes back to a string. Strips any trailing replacement character (`�`) from incomplete multi-byte sequences at the cut boundary.

228 bytes matches the Meshtastic maximum text message payload.

## Invariants

- `_running` is a re-entrancy guard: if a poll takes longer than 60 s, the next interval tick is skipped.
- All messages are marked `\Seen` after processing regardless of whether they matched a valid token. This prevents re-processing unknown or malformed emails on subsequent polls.
- Reply tokens are consumed only on a successful bridge POST. A failed send leaves the token unconsumed — the next poll will attempt delivery again if the email is still unseen (but the message has already been marked `\Seen`, so this retry only works if the IMAP mark is somehow reverted, which it won't be). Effectively: failed sends are not retried.
- `_client` in the module scope is not assigned in the current implementation (`_client = null` is set at shutdown, but `new ImapFlow` is created locally in `_processInbox` rather than being stored in `_client`). `stopImapReceiver` calls `_client?.close()` which is always null — the active connection is not closed on stop if a poll is in progress. This is a minor resource-management issue.
- IMAP `secure` is inferred from port: 993 → TLS. Other ports use unencrypted (STARTTLS not configured).

## Callers

| Caller | Usage |
|---|---|
| `index.js` | `startImapReceiver()` at startup |

`stopImapReceiver` is exported but has no callers — graceful shutdown is not wired.

## Test notes

- **unconfigured host**: `alerts.imap_host = ''` → `pollInbox` returns without connecting
- **no unseen messages**: IMAP `search({ seen: false })` returns `[]` → `_processInbox` returns early
- **no token in subject**: email with unrelated subject → `_handleMessage` returns; message still marked `\Seen`
- **expired token**: `getReplyToken` returns null → warn and return; message marked `\Seen`
- **valid token → DM**: `ctx.to_num = 0x12345678` → POST body includes `to: 0x12345678`
- **valid token → broadcast**: `ctx.to_num = 0xffffffff` → `to` field omitted from POST body
- **reply body extraction**: input with `> quoted line\n\nActual reply` → strips quote, returns `'Actual reply'`
- **truncation**: 300-char ASCII reply → capped at 228 bytes; multi-byte UTF-8 boundary does not produce `�`
- **bridge error**: POST returns 500 → logs error; `consumeReplyToken` NOT called
- **successful send**: POST returns 200 → `consumeReplyToken` called; token no longer in DB
- **re-entrancy**: poll fires while prior poll is running → `_running` guard skips it

## Out of scope

- Alert email sending — `mailer.js` owns that
- Reply token creation — `alerts.js` owns that
- Mesh message storage — `persist.js` and `db.js` own that
- SMTP credentials management — `mailer.js` and config API own that
