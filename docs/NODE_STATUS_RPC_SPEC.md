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

Current sections are device vitals, signal, environment, air quality, standard
detection text, and position. Values and labels arrive display-ready.

On relevant ingest, the server may emit:

```js
{ type: 'node_status_update', num }
```

The client re-requests the RPC. The hint never carries a competing value.
