---
module: message-type
source: src/message-type.js
source_hash: f680537b9dcf44cd152d81ea6b49c33ca17e1623510a3173de418cd450c6bd21
updated: 2026-07-20
---

# Module: message-type

## Purpose

The single classifier that maps a message-feed row to one of **5 display buckets**
for the message-feed type filter (task `message-feed-filters`). Server-side only —
the browser renders the pushed bucket and never re-derives it (BROWSER_CONTRACT).

Buckets (Peter, 2026-07-20): **chat · command · alarm · camera · diagnostics**.
Ping is a command, not its own bucket ("ping is just another command").

## Public interface

```js
export const MESSAGE_BUCKETS = ['chat', 'command', 'alarm', 'camera', 'diagnostics'];

export function messageBucket(category, text) : string   // one of MESSAGE_BUCKETS
```

`messageBucket(category, text)`:
1. **Outbound wins.** If `category` is an outbound tag: `'chat'` → `chat`;
   `'command'` or `'ping'` → `command` (ping is a command sub-type).
2. **Received** (`category` null): if `text` is a JSON payload (`{…}`), read its
   `type` field and bucket it:
   - `detect` / `alarm` / `cleared` / `env` / `wedge` → **alarm**
   - `cam` / `chunk` → **camera**
   - `diag` / `ext` → **diagnostics**
   - any other JSON `type` (pong, status, config, interval, sleepfor, reboot, set,
     name, lname, simenv, schema, help, err, sleep, …) → **command**
   - unparseable JSON → **chat**
3. Plain text (not a JSON payload) → **chat**.

Enumerated from 7 days of live data: ~20 distinct received `type` values; the
alarm/camera/diagnostics sets are explicit, everything else machine-JSON is a
command, and human text is chat.

## State / Events

_N/A_ — pure function.

## Invariants

- **Every row maps to exactly one bucket in `MESSAGE_BUCKETS`.** The unknown-JSON
  default is `command` (machine traffic), never a dropped/blank bucket.
- **The bucket vocabulary is fixed and small** (5). The browser filter renders
  these five; new firmware `type`s are absorbed by the defaults, no browser change.
- **Ping is `command`.** A stored `category:'ping'` (align) buckets to command;
  align is not retagged — the classifier subsumes it.

## Test notes

- `messageBucket('chat', 'hi')` → chat; `messageBucket('ping', '@x ping')` → command;
  `messageBucket('command', …)` → command.
- `messageBucket(null, '{"type":"pong",…}')` → command;
  `{"type":"detect"}` → alarm; `{"type":"cam"}` → camera; `{"type":"diag"}` →
  diagnostics; `{"type":"config"}` → command.
- `messageBucket(null, 'plain hello')` → chat; `messageBucket(null, '{bad json')` → chat.

## Out of scope

- The filter UI and per-viewer preference — Domain 2 (browser), a later step.
- Device/channel dimensions — already exposed by `filters.js` (`rx_devices`,
  `channel`); only the type bucket needs computing.

## Addressed-command grammar wins over the tag (2026-07-20)

`^@<4-hex>\s+\S` (`ADDRESSED_CMD`) is classified **command before any category
check**. Rationale from live data: 322 rows predate the `category` column (untagged
-> read as chat) and 47 more were typed into the chat box and tagged `'chat'` — so
59 of 62 rows on the chat-only page were actually commands. In this system
`@<suffix> <verb>` IS a command by construction, so content wins over the stored
tag. Trade-off: a human chatting `@336b are you there?` also reads as a command;
name mentions (`@PUCK hello`) do NOT — only the 4-hex form matches.
