# RSSI attribution — only direct receptions describe a node's link

Backlog #16. Peter: *"I still don't believe that -33dbm is what is being read by
that device, I have seen it twitch between -1XX and -33 … that device is too far
away for such a strong signal"*.

Names `docs/STYLE_GUIDE.md` (§8.6). Contract: `docs/mt-transport/API.md` iron
rule 4 (RSSI/SNR come from the packet envelope).

## The bug

The envelope's `rx_rssi`/`rx_snr` describe the **last hop** — the signal at our
gateway from whoever transmitted it to us. For a relayed packet that is the
**relay**, not the originating node. node-dash attributes it to `packet.from`
regardless, so a relayed packet writes another node's link quality into the
origin's record.

Measured across stored receptions:

| | count | avg RSSI |
|---|---|---|
| relayed — **misattributed** | **462** | **-102.0** |
| direct (`hops = 0`) — valid | 275 | -35.2 |
| hops unknown | 240 | -100.1 |

**47% of samples are wrong.** DEV1 shows the effect exactly as reported:

```
-16 … -40 dBm   hops=0   SNR +6…+7     ← its own link
-114 … -117     hops=1   SNR -5…-11    ← a relay's link, recorded as DEV1's
```

So `-33 dBm` is genuinely DEV1's direct signal; the `-1XX` excursions are relay
traffic. The twitching is the two being interleaved in one series.

## The fix

A reception describes a node's link **only when it arrived directly**. In
`persist.js`, compute `hops` once per packet/event and:

- **Signal history**: capture only when `hops === 0`.
- **`nodes.rssi` / `nodes.snr`**: pass `null` when not direct, so the header's
  live value and the `signalQuality` bars stop flipping between two different
  links. `upsertNode` COALESCEs, so the last *direct* value is retained rather
  than being overwritten by relay traffic.

`hops` is derived as `hop_start - hop_limit` on the raw packet path, and from
`event.hops` on typed events.

**Unknown hops are treated as not-direct.** Their average RSSI (-100.1) closely
matches the relayed population (-102.0) rather than the direct one (-35.2), so
they are far more likely to be relayed than direct. Recording them would
reintroduce the same error with less evidence. This is deliberately
conservative: better a sparser series that means one thing than a dense one
that means two.

## Repair of existing data

`signal_history` was backfilled from `messages`, which carries `hops`. Rows whose
`packet_id` matches a message with `hops > 0` are deleted — they describe a link
the node does not own.

`nodes.rssi`/`snr` are latest-value and self-correct on the next direct
reception; no repair is possible or needed.

## Files

| File | Change |
|---|---|
| `src/persist.js` | derive `hops`; gate signal capture and the rssi/snr written to `nodes` |
| `docs/modules/persist.md` | updated + rehashed |

## NOT changed

- `messages.rssi/snr` — a message row records how *that reception* arrived, and
  keeping the relayed value there is correct. Only per-node attribution is wrong.
- The `signalQuality` formula — unrelated; garbage in was the problem, not the
  maths.

## Invariants

- A node's signal series contains only receptions of that node's own transmission.
- `nodes.rssi/snr` reflect the last **direct** reception.
- Relay traffic is still stored in `messages` and still renders in the feed.

## Done when

- New signal rows appear only for `hops = 0` receptions
- Existing relay-derived rows are gone from `signal_history`
- DEV1's signal series no longer spans -126…-16
- `check_specs.py` green
