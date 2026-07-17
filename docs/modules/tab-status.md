---
module: tab-status
source: public/partials/tab-status.html
source_hash: f3f8f450fca1d45540de03d37572088eb0adecd6990137f11f8129495b71b551
updated: 2026-07-17
---

# Module: tab-status

## Purpose

Node Status page template (NODE_STATUS_SPEC Phase C). Mobile-first, single
column on a phone, two columns at `≥md`, inside the normal dash shell.
Presentation only — data from the `node_status` WS RPC via app-status.js.

## Structure (phone, top → bottom; §7 of the founding spec)

1. **Verdict slot** — `x-show` reserved; hidden until backend rules exist.
2. **Liveness hero** — node name + `!hexid`, big "last heard N ago" via
   `statusAge`, receiving radio + rssi/snr. The confidence headline.
3. **Heartbeat essentials** (monitored only) — latest `fw / up / boot / rst
   / trig`; a `bg-error` fault banner when the latest heartbeat's
   `env_err` is set.
4. **Power** — voltage prominent; battery % shown only when not masked.
5. **Environment** — temp / humidity now.
6. **Charts** (full width, scroll) — temp+humidity, voltage, rssi/snr.
7. **Heartbeat log** (monitored only) — table of recent heartbeats
   (ts · up · boot · rst · vbat · trig · flags).
8. **Identity / link detail** — hw model, role, position, per-radio signal.

Type via STYLE_GUIDE §3 roles; DaisyUI semantic tokens; both themes.
Canvas refs (`statusEnvChart`, `statusVbatChart`, `statusSigChart`) mount
points for app-status.js.

## Invariants

- Renders for ANY node; the monitored-only sections gate on
  `statusIsMonitored(statusNum)`.
- Battery % hidden when `statusMasked('battery_pct')`.
- Empty/loading state designed (no node yet → prompt; unknown node → notice).

## Test notes

Playwright phone + desktop, both themes; every section reachable by scroll;
charts present; 0 console errors.
