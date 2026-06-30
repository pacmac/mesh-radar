---
module: mailer
source: src/mailer.js
source_hash: a1aa39cd9920b5f75f0f36b2cf9885f902e59d6caf4f11b8336f71dca56caaa0
updated: 2026-06-30
---

# Module: mailer

## Purpose

SMTP alert delivery. Reads credentials from the config DB on every call so they
can be updated without a restart. No persistent connection — a fresh transport is
created and closed per message.

## Responsibilities

- Send an alert email via SMTP with caller-supplied type, subject, and body
- Provide a test send for verifying SMTP configuration
- Lazy-load `nodemailer` on first use (avoids boot-time import overhead)

## Dependencies

- `db.js` — `getConfig` (reads 6 `alerts.smtp_*` keys)
- `nodemailer` — dynamically imported on first `sendAlert`/`sendTestAlert` call

## Exports

```js
export async function sendAlert(type, subject, body, _opts = {})
export async function sendTestAlert()
```

## Config keys read (`alerts.*`)

| Key | Default | Meaning |
|---|---|---|
| `alerts.smtp_host` | `''` | SMTP server hostname |
| `alerts.smtp_port` | `465` | SMTP port number |
| `alerts.smtp_user` | `''` | SMTP auth username (omit for open relay) |
| `alerts.smtp_pass` | `''` | SMTP auth password |
| `alerts.smtp_from` | `''` | From address (falls back to `smtp_user` if blank) |
| `alerts.smtp_to` | `''` | Recipient address |

All keys are read on every call to `sendAlert`/`sendTestAlert` — no caching.

## `sendAlert(type, subject, body, _opts = {})`

1. Reads config via `getSmtpConfig()`.
2. If `host` or `to` is empty: logs a warning and returns without sending.
3. Lazy-loads `nodemailer` (cached in module-level `_nodemailer`).
4. Creates a new transport:
   - `secure: cfg.port === 465`
   - `auth`: omitted entirely when `cfg.user` is falsy (open relay support)
   - Timeouts: `connectionTimeout: 10 000 ms`, `socketTimeout: 15 000 ms`, `greetingTimeout: 10 000 ms`
5. Calls `transport.sendMail({ from: cfg.from || cfg.user, to: cfg.to, subject, text: body })`.
6. Calls `transport.close()` — frees the connection.

`type` is passed by callers for logging context only and is not included in the sent email.

`_opts` is accepted but unused — reserved for future use (e.g. HTML body, cc).

## `sendTestAlert()`

1. Reads config via `getSmtpConfig()`.
2. If `host` or `to` is empty: **throws** `Error('SMTP not configured')` (unlike `sendAlert`, which silently skips).
3. Calls `sendAlert('test', '[mesh] Test alert', <body>)` where body includes the SMTP host, port, from, and to for verification.

## Callers

| Caller | Usage |
|---|---|
| `alerts.js` | `sendAlert(type, subject, body)` for all 7 alert types |
| `index.js` | `sendTestAlert()` via `POST /alerts/test-email` |

## Invariants

- A fresh transport is created on every `sendAlert` call — no connection pooling or reuse.
- `nodemailer` is lazy-loaded once and cached (`_nodemailer`). Subsequent calls reuse the cached module.
- Config is never cached — `getSmtpConfig()` calls `getConfig()` on every invocation, so SMTP credential changes take effect immediately.
- `sendAlert` is intentionally non-throwing when SMTP is unconfigured (returns silently). This protects the alert system from crashing when credentials are missing.
- `sendTestAlert` throws when SMTP is unconfigured — it is called from a REST endpoint and the error propagates to the HTTP response.
- `secure` is inferred from port number (465 → TLS). Non-standard TLS on other ports is not supported without code change.
- There is no retry on send failure. `sendMail` rejection propagates to the caller.

## Test notes

- **sendAlert — unconfigured host**: `alerts.smtp_host = ''` → returns without throw, logs warning
- **sendAlert — unconfigured to**: `alerts.smtp_to = ''` → returns without throw, logs warning
- **sendAlert — auth omitted**: `alerts.smtp_user = ''` → transport `auth` field undefined (open relay)
- **sendAlert — port 465**: `alerts.smtp_port = 465` → `secure: true`
- **sendAlert — port 587**: `alerts.smtp_port = 587` → `secure: false`
- **sendAlert — from fallback**: `alerts.smtp_from = ''`, `alerts.smtp_user = 'u@h'` → from address = `'u@h'`
- **sendTestAlert — unconfigured**: throws `Error('SMTP not configured')`
- **sendTestAlert — configured**: calls `sendAlert` with `'test'` type; body includes host/port

## Out of scope

- HTML email bodies — only plain text is sent
- Reply-to headers — the `[reply:<token>]` mechanism lives in `alerts.js` (subject) and `imap-receiver.js` (parsing)
- Delivery receipts or bounce handling
- Alert scheduling or cooldown enforcement — `alerts.js` owns that
