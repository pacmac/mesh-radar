# One signal source per page — the header summarises what Reachability lists

Peter, 2026-07-29: *"the page is riddled with conflicting info. there is a clear spec
saying where data should come from, seems you are not abiding by that"* — and then
*"in the header stat cards it should probably show Best Signal and Least Hops etc etc,
all coming from the same data source as reachability has."*

mcpp task `signal-ssot-header`. Extends `docs/RSSI_ATTRIBUTION_SPEC.md`, whose invariant
is currently broken. Related: `signal-provenance-mixed-source` (739).

---

## 1. What is actually wrong

Three sources feed signal onto one page, and they disagree.

| # | source | gated? | attributed? | covers |
|---|---|---|---|---|
| 1 | `nodes.rssi/snr` | **no** | no | every node |
| 2 | `signal_history` | yes | yes (since `635139d`) | every node |
| 3 | pac-host `radios{}` | yes | yes | **2 alarm units only** |

The header SIGNAL tile reads **1**. The Reachability section (`1f8842b`) renders **3**.
Nothing on the page reads **2** for a current value.

### 1a. A written invariant is broken

`docs/RSSI_ATTRIBUTION_SPEC.md` states:

> **`nodes.rssi` / `nodes.snr`**: pass `null` when not direct
> **Invariant:** `nodes.rssi/snr` reflect the last **direct** reception.

Every write path obeys it except one:

| path | line | gated |
|---|---|---|
| `handleMessage` | `persist.js:260` | `direct ? rx_snr : null` ✓ |
| `handlePacket` ×3 | `:366 :415 :443` | `pktDirect ? … : null` ✓ |
| typed `user` / `position` | `:174 :189` | `evRssi = null` ✓ |
| **`handleNodeInfo`** | **`:473`** | **`node.snr ?? null` — ungated ✗** |

`handleNodeInfo` writes mesh-gw's nodedb aggregate straight in: a cached figure from
either radio, direct or relayed. With `upsertNode`'s `COALESCE` (`db.js:423-424`) a null
never clears it, so **one bad write persists indefinitely**.

Worse, the comment on `latestSignalTs` (`db.js:656-660`) asserts the opposite —
*"`nodes.rssi`/`nodes.snr` are themselves gated to direct reception"*. A previous session
documented the invariant as holding while the code broke it. That comment is corrected
here as part of the fix.

**Measured consequence.** GARG's header showed `-98 dBm · Good · 6.8 dB · direct 4m ago`.
Against `signal_history`, 24 h:

| rx_device | rows | best rssi | worst rssi | best snr |
|---|---|---|---|---|
| OMNI `E9:B0:3F:17:27:91` | 211 | −125.0 | −128.0 | −15.25 |
| YAGI `F4:12:FA:39:F7:B6` | 300 | −112.0 | −128.0 | −3.25 |

**Zero positive-SNR rows in 24 h. No row near −98 dBm.** The tile displayed a value that
corresponds to no measurement we hold.

### 1b. Value and age come from different tables

`node-status.js:587`:

```js
signal: buildSignal(node?.rssi ?? null, node?.snr ?? null, stmts.latestSignalTs.get(num)?.ts ?? null)
```

The **number** comes from `nodes`; the **`direct Nm ago`** comes from `signal_history`'s
newest row. The tile asserts directness and freshness about a value that may have neither.

### 1c. We render a field its owner conceded to us

services, xsession `[data-ownership-3categories]` #15:

> **Q2 PER-RADIO RSSI/SNR — WE CONCEDE.** You already store it against the receiving
> radio… we retain a per-radio model internally because it drives **radio selection** —
> that is a mesh decision, not a display one. **It is not published for rendering and it
> is not a competing answer to yours.**

Per-radio signal is **ours**. Rendering pac-host's `radios{}` (as `1f8842b` does) added a
third source to a page that already had two too many, and it only covers 2 nodes.

## 2. The rule

**Every signal or hops figure on the node page comes from a node-dash table that is
gated and radio-attributed. The header states the best case; Reachability lists the
detail; the header can only show a number Reachability also shows.**

Agreement by construction, not by convention — the header is computed *from the same
rows* the section lists, so the two cannot drift.

## 3. Sources — and why they are two tables, not one

`signal_history` is **100 % `hops = 0`** — 29,897 rows, no exceptions. That is correct
(`RSSI_ATTRIBUTION_SPEC`: capture only when direct) and it means **least-hops cannot come
from it** — the answer would always be 0.

`messages.hops` records every reception including relayed, per radio (`device` column):

```
GARG, last 7d    OMNI hops=0 433 · hops=1 25 · hops=2 5 · null 37
                 YAGI hops=0   2 · hops=1  1
```

| tile | source | why |
|---|---|---|
| **Best signal** | `signal_history` | direct-only by construction; carries `rx_device` |
| **Least hops** | `messages` | the only store holding relayed receptions with a radio |
| **Verified hops** | `traceroute_history` | authoritative path, when one exists |

### Attribution coverage is partial and must not be over-claimed

**18,681 of 29,897 `signal_history` rows have `rx_device = NULL`** — everything written
before `635139d`. Per-radio queries exclude them. They are not backfilled: inventing
attribution we do not have is the error this whole task exists to remove.

## 4. What the header shows

| tile | text | desc |
|---|---|---|
| Best signal | `-112 dBm · -5.8 dB` | `YAGI · direct 6m ago` |
| Least hops | `0` | `OMNI · 433 of 463 receptions direct` |
| Verified hops | `0` | `traceroute 14 Jul · 880 failed since` |

**"Best" is over each radio's LATEST direct reading, not best-ever.** Best-ever would show
GARG at −17 dBm from 27 July, when it sat on the bench beside the radios. The header then
summarises exactly the rows Reachability lists.

**The proportion is what stops "best" being a lie.** `433 of 463 receptions direct` says
direct is *typical*; `2 of 463` would say the opposite while the headline number stayed
identical. A best-case figure without its typicality is how the old card read
`-36 dBm / hops 0` for a 2.5 km link.

**Verified hops states that its refresh path is dead.** GARG's traceroute record:

```
ok 8            last 14 Jul 17:51  (route: [] — genuinely direct)
send_failed 9
timeout 880     since
```

`Hops 0` is a *correct* measurement, 15 days old, with 880 consecutive failures behind it.
The value is not wrong; presenting it as current is. `880 failed since` is the honest
qualifier and it is a measured count, not an adjective.

## 5. Files

**Domain 1 — this task**

| file | change |
|---|---|
| `src/db.js` | `latestDirectPerRadio` (window fn, `rx_device IS NOT NULL`); `hopsByRadio` over `messages`; `tracerouteHealth` counting outcomes since the last `ok`. Correct the false `latestSignalTs` comment. |
| `src/persist.js` | gate `handleNodeInfo`'s `snr`/`rssi` to `null` — restores `RSSI_ATTRIBUTION_SPEC`'s invariant |
| `src/node-status.js` | header `signal` ← `latestDirectPerRadio`; new `Least hops` + `Verified hops` replacing `hopsField`'s single tile; Reachability's `Heard by …` rows ← same query, not pac-host `radios{}` |

**Domain 2 — separate task, only if labels need it.** Header tiles already render
`label`/`text`/`desc`; `value_grid` gained `desc` in `9f6e7fa`. Expected to need **no**
browser change — confirmed at Phase 4, and split out if wrong.

## 6. Not changed, and why

- **`nodes.rssi/snr` is not dropped.** Gated at the write, it remains a valid
  last-direct-reception cache, and `node-list`/radar read it. This task stops the *node
  page* reading it for display; de-scalarising it entirely is task 739's remaining work.
- **`messages.rssi/snr`** stay as-is — a message row records how *that* reception
  arrived. `RSSI_ATTRIBUTION_SPEC` §NOT changed already settles this.
- **No backfill of `rx_device`.** See §3.
- **pac-host `radios{}`** keeps flowing; we stop rendering it. Their internal per-radio
  model still drives radio selection, which is theirs.
- **The traceroute timeout itself** — unexplained, out of scope, its own problem. This
  task only makes its consequence visible.

## 7. Verification

1. `handleNodeInfo` gate proved **reached**, not merely present: remove it, confirm an
   ungated value reappears in `nodes`, restore.
2. Header and Reachability read from one `node_status` payload and **cross-checked
   field-by-field** — the header's Best signal must be a value Reachability lists.
3. Both against a direct SQLite query of `signal_history` / `messages` /
   `traceroute_history`, so the page is checked against the store and not against itself.
4. A non-pac-host node still renders a header (this must not become alarm-only).
5. Both themes at 1600×1000, screenshots read.
6. `check_specs.py` — `All specs current.`, with the ok-count matching the spec count.
