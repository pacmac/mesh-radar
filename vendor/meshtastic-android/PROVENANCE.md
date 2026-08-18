# Vendored from Meshtastic-Android

Third-party source, copied verbatim. **Never edit anything in this directory.**
To update, replace the file wholesale, update the table below, and re-run
`node scripts/gen_interval_tables.mjs`.

| | |
|---|---|
| project | [Meshtastic-Android](https://github.com/meshtastic/Meshtastic-Android) |
| licence | GPL-3.0-or-later (the header is retained in the file) |
| fetched | 2026-08-18 |

## Files

### `FixedUpdateIntervals.kt`

Upstream path:

```
feature/settings/src/commonMain/kotlin/org/meshtastic/feature/settings/util/FixedUpdateIntervals.kt
```

414 lines. `sha256 e28e869bd1ecceb9d62b54d55cdfb3a938d0059fa534c0001def18f156a1370c`.

Consumed by `scripts/gen_interval_tables.mjs`, which generates
`src/interval-tables.js`. Spec: `docs/modules/interval-tables.md`.

**Why it is vendored rather than fetched.** It arrived in a session-scoped
scratchpad directory, and for a while the only copy on this machine lived there —
so the tables in `src/` cited a source that was about to cease to exist. A
generator whose input can vanish is not reproducible, and the check that compares
them would have had nothing to compare against.

## Known limit

Nothing here detects upstream moving on while this copy sits still. That needs a
deliberate human comparison against the URL above; the drift check only proves the
generated file matches **this** copy. Stated so nobody mistakes a green check for
"we are current with upstream".
