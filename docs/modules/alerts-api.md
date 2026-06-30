---
module: alerts-api
source: src/alerts-api.js
source_hash: 0db449febf848f4efdbcbd0c1210a3c78ac886d613acc1c18492efae062259c7
updated: 2026-06-30
---

# Module: alerts-api

## Purpose

Express Router owning all `/alerts/*` REST endpoints. Extracted from `index.js`.
Provides browser-facing CRUD for alert SMTP/IMAP config, alert rule management,
and test alert dispatch.

## Responsibilities

- Serve `GET /alerts/config` — read all 8 SMTP/IMAP config keys
- Serve `PUT /alerts/config` — write whitelisted SMTP/IMAP keys
- Serve `GET /alerts/rules` — read alert rules enriched with ALERT_META labels
- Serve `PUT /alerts/rules/:type` — update enabled/threshold/cooldown for one rule
- Serve `POST /alerts/test` — send a test alert email

## Routes

Mounted at `/alerts` by `index.js`. Paths below are router-relative.

| Method | Path | Action |
|---|---|---|
| GET | `/config` | Read all 8 SMTP/IMAP keys from DB |
| PUT | `/config` | Write whitelisted SMTP/IMAP keys (unknown keys silently ignored) |
| GET | `/rules` | Return alert rules enriched with ALERT_META label/desc/unit |
| PUT | `/rules/:type` | Update enabled/threshold/cooldown_minutes for one rule type |
| POST | `/test` | Send test alert email via `sendTestAlert()` |

## Dependencies

- `db.js` — `getConfig`, `setConfig`, `getAlertRules`, `updateAlertRule`
- `alerts.js` — `ALERT_META` (label/desc/unit per alert type)
- `mailer.js` — `sendTestAlert`

## Public interface

```js
export default router       // Express Router — mounted at /alerts by index.js
export const ALERT_SMTP_KEYS  // string[] — the 8 allowed config keys
```

## State

_N/A_

## Events emitted

_N/A_

## Invariants

- Only keys present in `ALERT_SMTP_KEYS` are read or written by `GET/PUT /alerts/config`. Unknown keys in PUT body are silently ignored.
- `PUT /alerts/rules/:type` returns 404 if the type is not in the DB (unknown alert type).
- `POST /alerts/test` propagates errors from `sendTestAlert` — throws if SMTP unconfigured.
- `ALERT_SMTP_KEYS` covers: `alerts.smtp_host`, `alerts.smtp_port`, `alerts.smtp_user`, `alerts.smtp_pass`, `alerts.smtp_from`, `alerts.smtp_to`, `alerts.imap_host`, `alerts.imap_port`.

## Test notes

- **GET /alerts/config**: returns object with all 8 keys.
- **PUT /alerts/config — unknown key**: silently ignored.
- **PUT /alerts/rules/:type — unknown type**: 404.
- **POST /alerts/test — unconfigured**: 500 with error message.

## Out of scope

- Alert evaluation logic — `alerts.js` owns that.
- Email sending — `mailer.js` owns that.
- IMAP polling — `imap-receiver.js` owns that.
