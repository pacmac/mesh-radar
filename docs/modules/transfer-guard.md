---
module: transfer-guard
source: scripts/transfer-guard.mjs
source_hash: 68516717bb2b99d4b7a32764ac18f51ea5acd3e893456a942de49ea3a85bba97
updated: 2026-07-20
---

# Module: transfer-guard

## Purpose

Answers one question before any edit under `src/`: **is a chunk transfer live right now?**
Exit 0 = safe, non-zero = do not touch.

`pm2` watches `src/`, so any write restarts node-dash — and the push receiver's chunk map
lives in MEMORY, so a restart destroys an in-flight transfer. This happened TWICE on
2026-07-20: once at 20/32, and again at 22:27:58 killing a transfer the device had already
accepted (`{"start":1,"ok":1,"cnt":32}`).

## Why this exists instead of a database query

The check it replaces asked the `messages` table for recent traffic from the device.
`messages` holds **text only** — commands and replies. The 261 binary chunk frames are
never written there, and during the streaming phase there is no text traffic at all. So it
read **zero exactly when a transfer was most active**: a detector that reports the safe
answer during the dangerous state, which is how the second transfer was killed after the
first had already taught the lesson.

## How it decides

Subscribes to `/events` and watches for what a live transfer actually emits:
`chunk_progress` (~1/s from `onProgress`) and raw 261 packets. Absence is concluded only
after a full window (default 6 s).

**It fails closed.** If the relay cannot be reached, or no events arrive at all, it reports
UNSAFE — silence must never be read as quiet, which is the failure that recurred all day.

## Usage

```
node scripts/transfer-guard.mjs [--host localhost:8000] [--window 6000]
```

## Verified

- With a live transfer running: `TRANSFER LIVE — do NOT edit src/`, exit 1 (caught a real
  transfer at 6/32).
- With nothing running: `no transfer signals in 6000 ms — safe to edit src/`, exit 0.
- Against a dead host: `UNKNOWN … Treating as UNSAFE`, exit 1.
