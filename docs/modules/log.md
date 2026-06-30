---
module: log
source: src/log.js
source_hash: 4fbc410da93c3b48a719e5e880c410090a83c170e2ef0bed2815c4b7881ab4ff
updated: 2026-06-30
---

# Module: log

## Purpose

Minimal levelled console logger. Provides `error`, `warn`, `info`, and `debug`
methods that prefix output with a timestamp and tag, and are silenced based on
the `LOG_LEVEL` environment variable.

## Responsibilities

- Read `LOG_LEVEL` at startup to determine the verbosity ceiling
- Prefix all output with `HH:MM:SS.mmm LEVEL [tag]`
- Route each level to the appropriate console method
- No-op silently when a message's level exceeds the current maximum

## Dependencies

- None (standard `console` and `process.env`)

## Exports

```js
export const log  // { error, warn, info, debug }
```

## Log levels

| Level | Numeric | Console method |
|---|---|---|
| `error` | 0 | `console.error` |
| `warn` | 1 | `console.warn` |
| `info` | 2 | `console.log` |
| `debug` | 3 | `console.log` |

`MAX` is set from `process.env.LOG_LEVEL` (case-insensitive) at module load. Defaults to `info` (2) if `LOG_LEVEL` is unset or unrecognised.

## Method signature

```js
log.info('tag', ...args)  // → "HH:MM:SS.mmm INFO  [tag] ...args"
log.debug('bridge', 'connecting')  // silenced if LOG_LEVEL < debug
```

The first argument is always the tag string. Additional arguments are passed through to the underlying `console` method as-is (objects, errors, etc. are not stringified by the logger).

## Timestamp format

`new Date().toISOString().slice(11, 23)` → `HH:MM:SS.mmm` (UTC time portion of ISO string, millisecond precision).

## Invariants

- `MAX` is computed once at module load; `LOG_LEVEL` changes after startup have no effect without a restart.
- A message is emitted only if its numeric level is ≤ `MAX`. `error` (0) is always emitted regardless of `LOG_LEVEL`.
- **Currently unused**: `log` is not imported by any module in `src/`. All existing logging uses `console.log`, `console.warn`, `console.error` directly. This module is available for adoption when consistent structured logging is introduced.

## Test notes

- **info suppressed at warn**: `LOG_LEVEL=warn` → `log.info(...)` no-ops
- **debug suppressed by default**: default MAX=info → `log.debug(...)` no-ops
- **error always emitted**: `LOG_LEVEL=error` → `log.error(...)` emits; `log.warn(...)` no-ops
- **tag and args**: `log.info('db', 'opened', { path })` → prefix includes `[db]`, remaining args passed to `console.log`
- **timestamp format**: output begins with `HH:MM:SS.mmm` (12 characters)

## Out of scope

- Log file output — console only
- Structured JSON logging
- Log rotation or buffering
