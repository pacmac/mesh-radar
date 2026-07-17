---
module: tab-status
source: public/partials/tab-status.html
source_hash: d16e138cb561f87cca1fbd989a47216218840b77bf0c8d0473532d8ea68edea1
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

## Data-driven env (task `status-env-datadriven`)

The Environment stat card renders each value only when present: temp/humidity
(heartbeat, falling back to `statusEnvLatest()`), pressure (`barometric_pressure`,
x-show non-null), dew point (`dewPoint(t,h)`, x-show when both present). A
separate Pressure chart card is `x-show`n only when any env pressure is non-null.
Pressure comes from standard Meshtastic env telemetry, so it lights up
automatically when a BME280 replaces a temp/humidity-only sensor.

## Freshness-aware precedence (task `status-fresh-precedence`)

Every current-value stat that had both a live `nodes` value and a heartbeat
snapshot previously let the (possibly hours-old) heartbeat win. Each now goes
through `statusVal(nodeVal, hbVal)` (app-status.js) which returns the fresher
of the two. Exact rewrites:

- **Power voltage** (was `statusHeartbeat()?.vbat_v ?? node.voltage`) →
  `statusVal(statusData.node?.voltage, statusHeartbeat()?.vbat_v)`, formatted
  `.toFixed(2)` — the live `node.voltage` is a raw float (`4.1560545`) whereas
  the heartbeat `vbat_v` was pre-rounded, so the fresher value needs rounding.
- **Power battery %** (was `…vbat_pct ?? node.battery`) →
  `statusVal(statusData.node?.battery, statusHeartbeat()?.vbat_pct)`; the
  `x-show` non-null guard reads the same expression.
- **Environment temp** `_t` getter (was `…temp_c ?? statusEnvLatest().temperature`)
  → `statusVal(statusData.node?.temperature, statusHeartbeat()?.temp_c)`.
- **Environment humidity** `_h` getter → `statusVal(statusData.node?.relative_humidity,
  statusHeartbeat()?.rh_pct)`.
- **Uptime** (was `fmtUptime(statusHeartbeat().up_s)`, no fallback) →
  `fmtUptime(statusVal(statusData.node?.uptime_seconds, statusHeartbeat()?.up_s))`.

Pressure (`_p`) is unchanged — no heartbeat equivalent.

Staleness surface: the Liveness hero gains a small caption, shown when
`statusIsMonitored(statusNum) && statusHeartbeat()`, reading
`'heartbeat ' + statusHbAge()` and tinted `text-error` when `statusHbStale()`.
This is the single place the age of the custom heartbeat is exposed, so the
heartbeat-only fields (boot/rst, trig, fw) that still read from the snapshot
are never mistaken for live values.
