# Signal history — RSSI + noise floor vs signal quality

Backlog #12. Peter: *"I would like a chart with RSSI / noise on one Y axis and
sig quality on the other"*.

Names `docs/STYLE_GUIDE.md` (§8.6). Companions: `BROWSER_CONTRACT.md`,
`NODE_STATUS_SPEC.md`.

## This reverses a call I got wrong

Step 3's original title included `signal_history`. I **removed it**, arguing
NODE_STATUS_SPEC didn't sanction a signal series and that the only series in
API.md was the forbidden `@ping`/pong reply. The consequence is that there is
no signal history to plot today — `nodes.rssi`/`snr` are latest-value only.

The reasoning was wrong in an important way: iron rule 3 excludes command
replies as a **source**, and iron rule 4 positively *requires* RSSI/SNR to come
from the **packet envelope**. Recording the envelope of every received packet
breaks neither rule. Peter wants the series; the series is legitimate.

## Data

**New table `signal_history`** — one row per (node, packet), from the envelope:

```sql
CREATE TABLE IF NOT EXISTS signal_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  num       INTEGER NOT NULL,
  packet_id INTEGER,
  rssi      REAL,
  snr       REAL
);
CREATE UNIQUE INDEX idx_sig_dedup  ON signal_history(num, packet_id) WHERE packet_id IS NOT NULL;
CREATE INDEX        idx_sig_num_ts ON signal_history(num, ts DESC);
```

Same dedup contract as the other history tables: a broadcast heard by N gateway
radios is one datum.

**Capture** in `persist.js`, wherever an envelope is already read — the raw
`packet` path and the typed `telemetry`/`user`/`position` events. Envelope only;
never a payload.

**Backfill (one-shot, config-guarded** like `migrations.*`**)** from
`messages.rssi`/`snr` — 950 rows across 102 nodes back to 2026-05-03. Those are
envelope values recorded at reception, so they are the same datum, not a
different source.

## Derived values — computed server-side

| Series | Unit | Derivation |
|---|---|---|
| RSSI | dBm | envelope, as received |
| Noise floor | dBm | `rssi - snr` — SNR is signal-above-noise, so noise = signal − SNR |
| Signal quality | % | `signalQuality(rssi, snr)` from `src/utils.js` — the same function the nodes/messages pages use |

Noise floor is **derived, not device-reported**. API.md offers no noise figure;
this is the standard relation and is labelled plainly so nobody mistakes it for
a measurement.

## Section

`signal` — `kind: 'series'`, placed after `device_vitals`, present only when the
node has ≥1 signal sample in the window (existing capability rule).

## Axis assignment must become unit-aware

The current rule splits on magnitude (≥10× below the chart max). RSSI (−30) and
quality (90) are only ~3× apart, so they would share one axis — exactly what
Peter is asking to avoid, and dBm on a % scale is meaningless regardless.

New rule, applied in order:

1. Group series by **unit**.
2. **1 unit group** → single axis.
3. **Exactly 2 unit groups** → one axis each; the group with more series takes
   the left.
4. **More than 2** → fall back to the existing magnitude split.

Verified against every existing chart, so nothing regresses:

| Chart | Units | Result |
|---|---|---|
| environment | °C, %RH, hPa (3) | rule 4 → temp+humidity left, pressure right (**unchanged**) |
| device_vitals | V, % (2) | rule 3 → % left (3 series), V right (**unchanged**) |
| **signal** | dBm, % (2) | rule 3 → **dBm left (RSSI+noise), % right (quality)** |

## Files

| File | Change |
|---|---|
| `src/db.js` | `signal_history` table + indexes; insert/query statements; exported helpers |
| `src/persist.js` | capture envelope signal on the packet and typed-event paths |
| `src/node-status.js` | `signal` series section; unit-aware `assignAxes` |
| `src/index.js` | one-shot backfill from `messages`, config-guarded |
| `docs/modules/db.md`, `persist.md`, `node-status.md` | updated + rehashed |

## Invariants

- Signal comes from the **envelope**, never a payload (iron rule 4).
- Noise floor and quality are computed **server-side**; the browser renders them.
- Dedup by `(num, packet_id)`; a null packet id is never deduped.
- Backfill runs once, guarded, and is idempotent via the dedup index.
- Existing charts' axis assignment is unchanged.

## Done when

- The signal section appears for a node with samples, absent for one without
- RSSI and noise floor share the left dBm axis; quality is alone on the right %
- Backfill populated history without duplicating live rows
- 1440×900, both themes, hover reports one series, zero console errors
- `check_specs.py` green
