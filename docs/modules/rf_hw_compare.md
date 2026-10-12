---
module: rf_hw_compare
source: scripts/rf_hw_compare.py
source_hash: e984d9fde979ce151e18181c90f7af2d25df6c652014c970646f6df22bb66ed7
updated: 2026-09-10
---

# Module: rf_hw_compare

## Purpose

A standalone, re-runnable script — not part of the running service — that
answers "did the recent OMNI/YAGI hardware changes actually improve reception?"
It is not. It reads `data/node-dash.db` and mesh-gw's live aim ledger and
prints tables to stdout; it makes no writes and has no effect on the running
`node-dash` process.

Built because Peter asked, mid-investigation (2026-09-10), for exactly this
comparison against three named nodes (TA2M/BNCH/MARK/HOME) — all of which
turned out to be Peter's own portable/bench units sitting a few metres from
each other, not usable reference points. He then asked for a **permanent,
tweakable** version rather than a one-off answer, hence this file living in
`scripts/` with its knobs declared at the top rather than buried in code.

## Responsibilities

- Enumerate candidate reference nodes: real, fixed, distant, actually heard on
  at least one of the three radios being compared.
- Exclude Peter's own units two ways — an explicit `MY_NODES` set (for units we
  cannot yet prove are ours from data alone) and an automatic near-field
  filter (`NEAR_FIELD_RSSI_DBM`) that drops a node's *entire* history the
  moment it is ever heard implausibly strong on any radio, because a single
  stale lat/lon cannot tell us which of its samples were taken where.
- Print an OMNI table: old era (before the 2026-09-05 outage) vs new era
  (after, same physical MAC, reported +2 m height and RAK SX1262 Boost
  module) — count/avg/min/max RSSI, avg SNR, per candidate node.
- Print a YAGI table: old MAC (HELTEC_HT62, mostly bench-mounted) vs new MAC
  (RAK4631/YAGI2, mast + rotator) — same stats, additionally bucketed by the
  rotator's bearing at each reading's timestamp, reconstructed from mesh-gw's
  `/plugins/aim/ledger`.

## Dependencies

- `data/node-dash.db` (read-only): `nodes`, `signal_history`, `config`
  (`home.lat`/`home.lon`).
- mesh-gw's `GET /plugins/aim/ledger?limit=N` (read-only, best-effort — the
  script degrades to `bearing=N/A` for every row if this is unreachable).

## Public interface

Run directly: `python3 scripts/rf_hw_compare.py`. No arguments; every tunable
is a module-level constant at the top of the file, by design, so Peter can
edit and re-run without reading the rest of it:

- `MY_NODES` — set of node `num`s always excluded.
- `OMNI_MAC`, `OMNI_OLD_END`, `OMNI_NEW_START` — the OMNI outage boundary
  (epoch seconds). See MILESTONES.md's `POWER` row for how these were
  measured (a clean gap in `relay_observation`, two independent tables
  agreeing to the second).
- `YAGI_OLD_MAC`, `YAGI_NEW_MAC` — the two physical radios (different
  hardware, not a time split — see MILESTONES.md's `DEPLOY` row).
- `NEAR_FIELD_RSSI_DBM`, `MIN_DISTANCE_KM` — contamination/candidacy filter.
- `ANGLE_BUCKET_DEG`, `AIM_LEDGER_LIMIT` — YAGI bearing bucketing.

Functions (`haversine_km`, `bearing_deg`, `candidate_nodes`,
`fetch_aim_ledger`, `bearing_at`, `bucket`, `stats`, `print_table`, `main`) are
all module-private helpers, not an API anything else imports.

## State

None — read-only, no side effects, no state persisted between runs.

## Events emitted

N/A — prints to stdout only.

## Invariants

- Never trusts a node's stored `lat`/`lon` alone to prove it is "distant" —
  that field is the LAST reported position and can be stale (this is exactly
  how MARK's contaminated history was found: a real 8.1 km fix from when it
  really was remote, sitting beside near-field bench readings from after it
  was brought home).
- A contaminated node's WHOLE history is dropped, never a per-sample filter —
  we cannot tell, from this data, which samples were taken where.
- Bearing is always labelled as the rotator's last COMMANDED position, never
  claimed as a live measurement (mesh-gw's own standing caveat: "a remembered
  azimuth is not a measurement").

## Test notes

Run 2026-09-10 against live data: correctly excluded MARK/HOME/GARG (own
units) and the three current radios' own node entries; found 7 real candidate
nodes (T4, ta21, WLCD, 79fc, 9048, 35e7, PUCK, 5.3–110.6 km); showed **zero**
samples on new-YAGI or new-OMNI for any of them — consistent with the
manual-query finding earlier the same session that not enough time has
elapsed since either hardware swap for a real distant contact yet.

## Out of scope

- Does not replay rotator hold/return reversion — a bucket assigned right
  after a brief aim-and-return command may be wrong for the seconds it takes
  to revert back. Documented in `fetch_aim_ledger()`'s docstring, not solved.
- Does not resolve BNCH to a node id — not identified this session. Add it to
  `MY_NODES` the moment it is.
- Does not attempt to reconcile the "MARK, 8.1 km, −5 dBm" reading that
  appears in mesh-gw's own docs — Peter confirmed our own MARK is a co-located
  unit, so that doc reading is either stale or a different node entirely with
  the same short_name; not chased further.
