---
module: ws-connect-replay
source:
  - src/db.js
  - src/ws-relay.js
source_hash: 042eb47378cb0ed63c0e12cde3956a5786efe8f739ec25eef30c07ca17da2a53
updated: 2026-08-17
---

# Module: ws-connect-replay

## Purpose

The history the socket replays to every browser on connect, and the bound on it.

Ledger `B92`: the replay is ~13.2 MB, of which two single frames exceed the 1 MiB
default WebSocket frame limit. A client on library defaults is disconnected
before it sees any reply — `sent 1009 (message too big) frame with 4360052 bytes
exceeds limit of 1048576 bytes`. That is exactly why `tests/test_node.py` reports
five separate "required on connect but never received" failures: one cause, five
symptoms.

## The measurement

Live socket, 20 s window, `maxPayload` raised to 32 MB, 2026-08-13:

```
messages 79  total 13,228,850 bytes
  5,901,979  env_history        @2.3s
  4,358,807  tilt_history       @2.2s
    402,042  traceroute_history @2.3s
    321,090  node_list  x5      (re-sent every ~2s, unchanged)
```

## The defect, precisely

`tilt_history` and `env_history` are the only two replayed feeds bounded by TIME
and not by ROWS — 24 h and 7 d respectively (`src/ws-relay.js:1280-1290`).
`range_test_log` and `traceroute_history` already take `limit 500`.

**And the browser throws most of it away in the same tick.** `public/app-ws.js:15`
declares `MAX_HISTORY_ROWS = 2000`, and both handlers truncate per node the
moment the rows land:

```js
if (a.length > MAX_HISTORY_ROWS) this._tiltHistoryAll[k] = a.slice(-MAX_HISTORY_ROWS);   // :483
if (updated[k].length > MAX_HISTORY_ROWS) updated[k] = updated[k].slice(-MAX_HISTORY_ROWS); // :500
```

Measured against the live store:

| feed | rows sent | rows the browser keeps | discarded |
|---|---|---|---|
| `tilt_history` | 17,456 (1 node) | 2,000 | 15,456 — **88.5%** |
| `env_history` | 42,708 (42 nodes) | 7,965 | 34,743 — **81.4%** |

```sql
SELECT SUM(MIN(c,2000)) FROM (SELECT COUNT(*) c FROM tilt_history
  WHERE ts > strftime('%s','now')-86400 GROUP BY node_id);
SELECT SUM(MIN(c,2000)) FROM (SELECT COUNT(*) c FROM environment_history
  WHERE ts > strftime('%s','now')-7*86400 GROUP BY num);
```

## The bound is not a judgement — the consumer states it

`MAX_HISTORY_ROWS = 2000` is the browser's own declared cap, and it keeps the
**tail** (`slice(-2000)`) of an ascending list. So serving the most recent 2,000
rows per node, still ascending, leaves the browser holding **byte-for-byte the
same state**. This change cannot alter what any page displays, and that property
is what makes it safe to make while Peter is asleep. It is not a smaller window
or a coarser chart; it is declining to transmit rows whose only destination is
`slice()`.

## Responsibilities

- `queryAllTiltHistory(sinceTs)` — most recent 2,000 rows **per `node_id`**
  within the window, ascending.
- `queryAllEnvHistory(sinceTs)` — most recent 2,000 rows **per `num`** within the
  window, ascending.

## Dependencies

- SQLite window functions (`ROW_NUMBER() OVER (PARTITION BY …)`). Available:
  the bundled better-sqlite3 reports **3.53.2**, and the partitioned query was
  run against the live store before this spec was written — it returned exactly
  2,000 tilt rows.

## Invariants

- **The server never sends a row the browser is about to discard.** If
  `MAX_HISTORY_ROWS` changes in `public/app-ws.js`, `HISTORY_ROWS_PER_NODE` in
  `src/db.js` must change with it. Each names the other in a comment; they are
  two halves of one number and there is no mechanism that keeps them in step.
- **Ascending order is part of the contract.** Both browser handlers keep the
  tail of the array they are given. Reversing the order would silently keep the
  OLDEST 2,000 while still passing every row-count check.
- **The window stays as it is** — 24 h for tilt, 7 d for env. Narrowing it would
  change what a page can show; this task does not.

## State

_N/A_

## Events emitted

Unchanged: `tilt_history`, `env_history`, same type names, same row shape, same
order. Only the row count changes.

## Test notes

Re-measure the connect payload the same way it was measured:

```
node -e "…ws… maxPayload 32MB, 20 s window, print each frame's size by type"
```

Expected, from 138 bytes/row measured across the current payload:

| frame | before | after — MEASURED post-restart |
|---|---|---|
| `tilt_history` | 4,358,807 | **498,220** — under the 1 MiB default |
| `env_history` | 5,901,979 | **1,108,577** — still 5.7% over |
| 20 s total | 13,228,850 | **5,867,160** — a 55.6% cut |

`tests/test_node.py` went from **6 failures to 5**: `WS:tilt_history` now arrives.
The 1009 disconnect moved from the 4.36 MB tilt frame to the 1.11 MB env frame,
so `range_test_log`, `range_test_timer` and `traceroute_history` are still cut
off behind it.

**This change does not fully close `B92`, and that is stated here rather than
discovered later.** `env_history` at ~7,965 rows is still around 1.1 MB, because
~90 bytes of every 138-byte row are repeated JSON key names. Getting under 1 MiB
needs either a columnar wire format or a narrower window — both change the
browser's parsing, so both are Domain 2 and belong to a separate task, per the
project rule that no fix spans domains. Recorded as a follow-up.

`gas_resistance` was checked for removal and is **NOT dead** — `src/node-status.js:408-431`
renders it as a node-page spec ("Gas resistance", MΩ, 0-100 scaled). 4,961 of
42,716 rows carry a value. It stays.

## Out of scope

- `node_list` re-sent at 321 KB every ~2 s (~9.6 MB/min steady state). A
  different defect on a different path — the broadcast, not the replay.
- The remaining `env_history` overage (above).
- `B93`, the unhandled typed `traceroute` event.

---

## Implementation

### `src/db.js` — the two prepared statements

A shared constant, so the two halves of the number are declared once:

```js
// The browser keeps only the last MAX_HISTORY_ROWS per node
// (public/app-ws.js:15, and it slices on arrival), so anything beyond this is
// transmitted and discarded in the same tick. Measured 2026-08-13: 88.5% of the
// tilt replay and 81.4% of the env replay were being thrown away. Ledger B92.
// IF public/app-ws.js:MAX_HISTORY_ROWS CHANGES, CHANGE THIS WITH IT.
const HISTORY_ROWS_PER_NODE = 2000;
```

`queryAllTilt` (currently at `src/db.js` beside `queryAllEnvHistory`) and
`queryAllEnvHistory` at `src/db.js:1102-1107` each become a partitioned
most-recent-N, re-sorted ascending:

```sql
SELECT ts, num, temperature, relative_humidity, barometric_pressure, gas_resistance
  FROM (SELECT ts, num, temperature, relative_humidity, barometric_pressure, gas_resistance,
               ROW_NUMBER() OVER (PARTITION BY num ORDER BY ts DESC) rn
          FROM environment_history WHERE ts >= ?)
 WHERE rn <= 2000
 ORDER BY ts ASC
```

and the tilt equivalent partitioned by `node_id`.

The selected columns are unchanged in both — same names, same order, so the
serialised row shape the browser parses is identical.

### `src/ws-relay.js`

**No change.** It calls `queryAllTiltHistory(since24h)` and
`queryAllEnvHistory(since7d)` and sends what it is given; the bound belongs with
the query, not with the sender. It is listed as a source of this spec because the
replay block at `src/ws-relay.js:1278-1300` is what the spec describes, and a
change there must re-open this document.

## Files deliberately NOT changed

- `public/app-ws.js` — Domain 2. Its truncation stays as the backstop it always
  was; live appends (`:389`) still need it.
- The window constants `since24h` / `since7d`.
- `range_test_log` and `traceroute_history` — already row-bounded at 500.
