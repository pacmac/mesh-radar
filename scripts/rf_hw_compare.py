#!/usr/bin/env python3
"""rf_hw_compare.py — compare RSSI/SNR across OMNI/YAGI hardware eras.

Uses ONLY real fixed-position reference nodes, never Peter's own portable/bench
units. Two exclusion layers, deliberately both kept:
  1. MY_NODES below — explicit, because we cannot always prove a unit is ours
     from data alone (see BNCH: not resolved to a node num this session).
  2. NEAR_FIELD_RSSI_DBM — automatic catch-all: a node ever heard at near-field
     strength on ANY radio has its WHOLE history excluded, not just the
     near-field samples, because we cannot tell which samples were taken
     where without per-packet GPS.

Peter, 2026-09-10, on why: "TA2M/BNCH/MARK/HOME are just a few meters away from
each other. that data CANNOT be used." MARK alone showed -4 dBm to -128 dBm
across its history — moved between a bench and wherever it was actually
deployed, with only one stale lat/lon on file.

See docs/modules/rf_hw_compare.md and MILESTONES.md for the hardware-swap
events this script measures against.

TWEAK THESE for a re-run:
"""
import bisect
import json
import sqlite3
import urllib.request
from math import asin, atan2, cos, degrees, radians, sin, sqrt
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "node-dash.db"
BRIDGE_URL = "http://localhost:8001"

# ── Our own units — ALWAYS excluded, regardless of what their rssi looks like.
# Seeded from what this session identified for certain (node num, short_name):
#   413147076 MARK, 2364420971 HOME, 2558179343 GARG (all "a few meters away",
#   Peter 2026-09-10). BNCH was NOT resolved to a node num this session — add
# it here (and anything else of ours) the moment you have its num.
MY_NODES = {413147076, 2364420971, 2558179343}

# ── Hardware eras — see MILESTONES.md for how each boundary was established.
# Edit these (or add new ones) when the next swap happens.
OMNI_MAC = "E9:B0:3F:17:27:91"
OMNI_OLD_END = 1788604839  # 2026-09-05 10:40:39Z — last heard before the outage
OMNI_NEW_START = 1788972858  # 2026-09-09 16:54:18Z — first heard after

YAGI_OLD_MAC = "F4:12:FA:39:F7:B6"  # HELTEC_HT62, mostly bench-mounted
YAGI_NEW_MAC = "FC:0A:85:C6:EC:B7"  # RAK4631, mesh-gw alias YAGI2, mast-mounted

# ── Contamination filter (catch-all beyond MY_NODES) ────────────────────
NEAR_FIELD_RSSI_DBM = -25  # ever heard stronger than this -> whole node excluded
MIN_DISTANCE_KM = 3  # stored position closer than this is excluded outright

# ── YAGI bearing bucketing (directional only — OMNI ignores this) ───────
ANGLE_BUCKET_DEG = 30
AIM_LEDGER_LIMIT = 5000  # raise if /plugins/aim/status ledger_rows exceeds this


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = radians(lat1), radians(lat2)
    dp, dl = radians(lat2 - lat1), radians(lon2 - lon1)
    a = sin(dp / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2
    return r * 2 * asin(min(1.0, sqrt(a)))


def bearing_deg(lat1, lon1, lat2, lon2):
    """Geographic bearing from (1) to (2), 0-360, 0=north. Not the antenna's aim."""
    p1, p2 = radians(lat1), radians(lat2)
    dl = radians(lon2 - lon1)
    y = sin(dl) * cos(p2)
    x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl)
    return (degrees(atan2(y, x)) + 360) % 360


def home_position(cur):
    row = cur.execute(
        "SELECT (SELECT CAST(value AS REAL) FROM config WHERE key='home.lat'),"
        "       (SELECT CAST(value AS REAL) FROM config WHERE key='home.lon')"
    ).fetchone()
    return row[0], row[1]


def candidate_nodes(cur, home_lat, home_lon):
    """Real, fixed, distant nodes only — everything excluded is listed and why.

    Only considers nodes actually heard on one of the three radios this script
    compares (OMNI/old-YAGI/new-YAGI) — the mesh has thousands of nodes we have
    never received directly and they are not candidates for anything here.
    """
    rows = cur.execute(
        "SELECT DISTINCT n.num, n.short_name, n.long_name, n.lat, n.lon FROM nodes n "
        "WHERE n.lat IS NOT NULL AND n.lat <> 0 AND EXISTS ("
        "  SELECT 1 FROM signal_history s WHERE s.num = n.num "
        "  AND s.rx_device IN (?, ?, ?))",
        (OMNI_MAC, YAGI_OLD_MAC, YAGI_NEW_MAC),
    ).fetchall()
    kept, excluded = [], []
    for num, short_name, long_name, lat, lon in rows:
        name = short_name or long_name or str(num)
        km = haversine_km(home_lat, home_lon, lat, lon)
        brg = bearing_deg(home_lat, home_lon, lat, lon)
        if num in MY_NODES:
            excluded.append((name, km, brg, "MY_NODES"))
            continue
        if km < MIN_DISTANCE_KM:
            excluded.append((name, km, brg, f"< {MIN_DISTANCE_KM} km"))
            continue
        peak = cur.execute(
            "SELECT MAX(rssi) FROM signal_history WHERE num=?", (num,)
        ).fetchone()[0]
        if peak is not None and peak > NEAR_FIELD_RSSI_DBM:
            excluded.append((name, km, brg, f"heard at {peak} dBm on some radio"))
            continue
        kept.append((num, name, km, brg))
    return kept, excluded


def fetch_aim_ledger():
    """Full point-command history for the rotator, oldest first.

    A remembered azimuth is not a measurement (mesh-gw's own words, see
    docs/gw/modules/pick_radio_rules.md) — this reconstructs 'what was the
    rotator LAST commanded to' at each reading's timestamp, nothing more. It
    does NOT replay hold/return reversion, so a bucket assigned right after a
    brief aim-and-return command may be wrong for the seconds it takes to
    revert. Good enough for a bucketed comparison; not a per-sample proof.
    """
    try:
        with urllib.request.urlopen(
            f"{BRIDGE_URL}/plugins/aim/ledger?limit={AIM_LEDGER_LIMIT}", timeout=10
        ) as r:
            data = json.load(r)
    except Exception as e:  # noqa: BLE001 — this is a best-effort enrichment
        print(f"  (aim ledger unavailable: {e} — YAGI rows will show bearing=N/A)")
        return []
    rows = sorted(data.get("rows", []), key=lambda row: row["at"])
    return rows


def bearing_at(ledger, ledger_ats, ts):
    if not ledger:
        return None, None
    idx = bisect.bisect_right(ledger_ats, ts) - 1
    if idx < 0:
        return None, None
    row = ledger[idx]
    return row.get("az"), ts - row["at"]


def bucket(az):
    if az is None:
        return "N/A"
    b = int(az // ANGLE_BUCKET_DEG) * ANGLE_BUCKET_DEG
    return f"{b:03d}-{b + ANGLE_BUCKET_DEG:03d}°"


def stats(rows):
    rssi = [r[0] for r in rows if r[0] is not None]
    snr = [r[1] for r in rows if r[1] is not None]
    if not rssi:
        return None
    return {
        "n": len(rows),
        "rssi_avg": round(sum(rssi) / len(rssi), 1),
        "rssi_min": min(rssi),
        "rssi_max": max(rssi),
        "snr_avg": round(sum(snr) / len(snr), 1) if snr else None,
    }


def print_table(title, header, rows):
    print(f"\n=== {title} ===")
    if not rows:
        print("  (no data)")
        return
    widths = [max(len(str(c)) for c in col) for col in zip(header, *rows)]
    fmt = "  ".join("{:%d}" % w for w in widths)
    print("  " + fmt.format(*header))
    for row in rows:
        print("  " + fmt.format(*[str(c) for c in row]))


def main():
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    home_lat, home_lon = home_position(cur)
    kept, excluded = candidate_nodes(cur, home_lat, home_lon)

    print_table(
        "EXCLUDED (ours, too close, or proven near-field at least once)",
        ["node", "km", "bearing", "why"],
        [[n, f"{km:.1f}", f"{b:.0f}°", why] for n, km, b, why in excluded],
    )
    print_table(
        "CANDIDATES — real, fixed, distant reference nodes used below",
        ["node", "km", "bearing"],
        [[n, f"{km:.1f}", f"{b:.0f}°"] for _, n, km, b in kept],
    )

    # ── OMNI: same MAC throughout, split by time ────────────────────────
    omni_rows = []
    for num, name, km, brg in kept:
        old = cur.execute(
            "SELECT rssi, snr FROM signal_history WHERE num=? AND rx_device=? AND ts<?",
            (num, OMNI_MAC, OMNI_OLD_END),
        ).fetchall()
        new = cur.execute(
            "SELECT rssi, snr FROM signal_history WHERE num=? AND rx_device=? AND ts>?",
            (num, OMNI_MAC, OMNI_NEW_START),
        ).fetchall()
        so, sn = stats(old), stats(new)
        if so or sn:
            omni_rows.append([
                name, f"{km:.1f}",
                so["n"] if so else 0, so["rssi_avg"] if so else "-", so["snr_avg"] if so else "-",
                sn["n"] if sn else 0, sn["rssi_avg"] if sn else "-", sn["snr_avg"] if sn else "-",
            ])
    print_table(
        "OMNI — old (before 2026-09-05 outage) vs new (same unit, after; +2m, reported SX1262 Boost module)",
        ["node", "km", "n_old", "rssi_old", "snr_old", "n_new", "rssi_new", "snr_new"],
        omni_rows,
    )

    # ── YAGI: two different MACs, bucketed by bearing at reception time ─
    ledger = fetch_aim_ledger()
    ledger_ats = [row["at"] for row in ledger]
    yagi_rows = []
    for num, name, km, brg in kept:
        for era_name, mac in (("old-HELTEC", YAGI_OLD_MAC), ("new-RAK", YAGI_NEW_MAC)):
            readings = cur.execute(
                "SELECT ts, rssi, snr FROM signal_history WHERE num=? AND rx_device=?",
                (num, mac),
            ).fetchall()
            if not readings:
                continue
            by_bucket = {}
            for ts, rssi, snr in readings:
                az, age_s = bearing_at(ledger, ledger_ats, ts)
                by_bucket.setdefault(bucket(az), []).append((rssi, snr))
            for buck, rows in by_bucket.items():
                s = stats(rows)
                if s:
                    yagi_rows.append([
                        name, f"{km:.1f}", era_name, buck,
                        s["n"], s["rssi_avg"], s["rssi_min"], s["rssi_max"], s["snr_avg"],
                    ])
    print_table(
        "YAGI — old (HELTEC_HT62, mostly bench) vs new (RAK4631/YAGI2, mast+rotator), by bearing bucket",
        ["node", "km", "era", "bearing", "n", "rssi_avg", "rssi_min", "rssi_max", "snr_avg"],
        yagi_rows,
    )
    print(
        "\nNote: bearing is the rotator's LAST COMMANDED position before each reading "
        "(mesh-gw's aim ledger), not a live measurement — see fetch_aim_ledger() docstring. "
        "Old-YAGI was bench-mounted for most of its life, so most of its rows will show "
        "bearing=N/A (no ledger entry) rather than a real bucket."
    )


if __name__ == "__main__":
    main()
