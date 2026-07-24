# node_status RPC

Spec of record: `docs/NODE_STATUS_SPEC.md`.

## Request

```js
{ type: 'node_status', num, window_h }
```

## Response

```js
{ type: 'node_status', num, found, window_h, header, sections }
```

`sections` is ordered and contains only sections with data. Supported kinds:

| kind | shape |
|---|---|
| `value_grid` | `{ fields: [{label, raw, text, ts}] }` |
| `series` | `{ series: [{label, unit, points}], ticks, t_min, t_max }` |
| `event_log` | `{ events: [{ts, ts_text, label, text}] }` |

Current sections are device vitals, signal, environment, air quality, and
standard detection text. Position is carried in the header. Values and labels
arrive display-ready.

On relevant ingest, the server may emit:

```js
{ type: 'node_status_update', num }
```

The client re-requests the RPC. The hint never carries a competing value.

While a successful node-status view remains open, the server advances its
display-ready relative last-heard age without requiring new mesh traffic:

```js
{ type: 'node_status_age', num, raw, ago }
```

The client applies this lightweight event only when `num` is still focused and
`raw` still matches the header's last-heard timestamp. It does not request the
full RPC, poll, issue GET, or calculate the age locally.
