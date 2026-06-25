# Radar Modes — Current Behaviour

Describes the actual behaviour of each dashboard mode across three dimensions:
**Rotator**, **Data collection**, and **Radar UI**.

---

## PASV — Passive / Manual (mode 0)

### Rotator
- No automatic movement.
- User enters an azimuth (0–360°) in the manual point input and clicks **Point**.
- Backend: `POST /rotator/move` → `rotator.move(az)` → firmware `seek2az`.
- Rotator moves once and holds position indefinitely.
- No target arm drawn on the radar.

### Data Collection
- `passive-tracer.js` monitors all incoming packets from any non-rotator radio.
- When a node is heard and its traceroute data is stale (>30 min, or >10 min after a failed trace), a traceroute is automatically dispatched via the receiving radio.
- Traceroute timeout: 60 s.
- Results stored in SQLite traceroute history and attached to the node as `last_traceroute` (route chain, per-hop SNR, relay positions).
- Packets from the rotator radio are excluded to avoid polluting the traceroute device selection.
- No per-node signal metrics recorded beyond what arrives naturally in packets.

### Radar UI
- All nodes shown. Dot colour reflects signal age (heatmap fade).
- Route overlays drawn for all nodes that have `last_traceroute` data (faded by age).
- When a traceroute is **actively in flight**, the source node gets:
  - Green crosshairs on its radar dot.
  - Animated pulse dots travelling along its route overlay.
  - Animation stops immediately when the result (or timeout/cancel) arrives.
- Active card label: **TRACING** (green accent). Shows while traceroute is in flight.
- Manual azimuth input visible in the controls strip (hidden in ACTV and SCAN).
- No target arm.

---

## ACTV — Active Tracker (mode 1)

### Rotator
- Fully automatic round-robin targeting.
- `active-tracker.js` builds a schedule from nodes that have position data, sorted by:
  1. Never-visited nodes first.
  2. Then least-recently-visited (oldest `yagi_last_targeted` timestamp).
- Calls `rotator.move(az)` immediately on each target selection.
- Dwells at the target azimuth for `dwell_sec` (default 90 s), then advances automatically.
- User can interrupt at any time by clicking a node → `targetNum(num)` — dwell timer resets for that node, then normal scheduling resumes.
- Target arm (dashed orange line) drawn toward current target azimuth.
- Persists across server restart: if `rotator.dash_mode = 1` in DB, `activeTracker.start()` is called on boot.
- Mutual exclusion: SCAN starting forces ACTV to stop; attempting to start ACTV while SCAN is active is silently refused.

### Data Collection
- During each dwell, `handlePacket()` filters to packets from the **rotator radio only** and **from the targeted node only**.
- On each qualifying packet: RSSI and SNR are recorded.
  - `nodeinfo` table updated: `yagi_contact_count`, `yagi_last_contact`, `yagi_last_rssi/snr`, `yagi_best_rssi/snr` (best-ever values).
  - `range_test_log` entry inserted for range testing correlation.
- Live signal emitted as `signal_update` WS event → frontend `yagiSignal` reactive state.
- A traceroute is auto-dispatched to the target node on each visit, subject to a 5-minute cooldown (`TRACE_COOLDOWN_MS`).
- Packets from non-rotator radios are processed normally by the node list (last-heard updates, etc.).

### Radar UI
- All nodes shown. Route overlays drawn for all nodes that have `last_traceroute` data (faded by age).
- Targeted node gets:
  - Red crosshairs + pulsing ring on its dot.
  - Full-opacity route overlay (static).
  - Animated pulse dots **only while a traceroute is actively in flight** to that node.
- Active card label: **TARGET** (red accent). Shows live RSSI/SNR updating in real time as packets arrive from the rotator radio.
- Target arm (dashed orange line) tracks live rotator target azimuth.
- PASV and SCAN mode buttons are not locked out (user can switch), but clicking PASV stops the tracker.

---

## SCAN — Polar Sweep (mode 2)

### Rotator
- Fully automatic 360° sweep.
- `scanner.js` steps azimuth from 0° to 355° in `step_deg` increments (default 5°).
- At each step: calls `rotator.move(az)`, then polls every 200 ms until the rotator reports idle (or 25 s timeout expires), then enters dwell.
- Dwells for `dwell_sec` (default 60 s) before advancing to the next azimuth.
- Full sweep time: ~73 minutes at 5°/60 s.
- Scan can be aborted at any time via the **ABORT** button or `POST /rotator/scan/abort`.
- Full state persisted to SQLite (`scan_state`, `scan_nodes`, `scan_config`) — survives server restart and resumes from the last azimuth.
- PASV and ACTV mode buttons are disabled (locked out) during an active scan.

### Data Collection
- During each dwell, `handlePacket()` accepts packets from the **rotator radio only**.
- Best-SNR contact per azimuth recorded in `scanner._contacts[az]` — if a better signal arrives at the same heading, it replaces the previous entry.
- On each contact: `scan_contact` WS event broadcast → frontend `scanData[az]` updated.
- Node list uses a dual-buffer: nodes accumulate in `_pending` and are only promoted to the visible cache (`_cache`) when the scanner records a contact for that node.
- All confirmed contacts written to SQLite (`scan_nodes`) on every update — survives restart.
- Non-rotator packets are completely ignored during an active scan.
- A traceroute is auto-dispatched on each new contact, subject to a 5-minute cooldown per node (`TRACE_COOLDOWN_MS`).

### Radar UI
- **Only confirmed scan contacts are shown** (nodes with no contact at any heading are hidden).
- Node list sorted by SNR descending (strongest contact first).
- Progress bar shows current azimuth sweeping 0→360°, labelled `SCAN 45°` etc.
- Route overlays drawn for all contact nodes that have `last_traceroute` data (faded by age).
- Animated pulse dots shown **only while a traceroute is actively in flight** to a contact node.
- No active card overlay.
- Header button changes to **ABORT** (warning colour, active) during scan.
- Scan contacts accumulate on the radar as the sweep progresses — dots appear at their GPS positions as each azimuth is confirmed.

---

## Comparison Table

| | PASV (0) | ACTV (1) | SCAN (2) |
|---|---|---|---|
| **Rotator movement** | Manual only | Auto round-robin | Auto 360° sweep |
| **Movement trigger** | User input | `advance()` on dwell expiry | `_doStep()` on dwell expiry |
| **Dwell duration** | Indefinite | 90 s (configurable) | 60 s per heading (configurable) |
| **Qualifying radio** | Any (non-rotator for traces) | Rotator radio only (for signal) | Rotator radio only |
| **Node list** | All nodes | All nodes | Confirmed contacts only |
| **Node list sort** | By azimuth | By azimuth | By SNR (best first) |
| **Traceroutes** | Auto on packet receipt (5 min cooldown) | Auto per visit (5 min cooldown) | Auto on contact (5 min cooldown) |
| **Live signal** | No | Yes (`yagiSignal`) | No |
| **Route overlays** | All nodes with `last_traceroute` (faded by age) | All nodes with `last_traceroute` (faded by age) | Contact nodes with `last_traceroute` (faded by age) |
| **Animated route dots** | Only while traceroute in flight | Only while traceroute in flight | Only while traceroute in flight |
| **Active card** | TRACING — while traceroute in flight | TARGET — live RSSI/SNR | None |
| **Target arm** | No | Yes (orange dashed) | Yes (sweep position) |
| **DB persistence** | Mode only | Mode only | Full scan state + contacts |
| **Resume on restart** | Mode restores, no auto-move | Mode restores, targeting resumes | Scan resumes from last azimuth |
| **Mutual exclusion** | — | Stopped by SCAN start | Disables PASV/ACTV buttons |
