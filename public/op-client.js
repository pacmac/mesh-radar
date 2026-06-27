// op-client.js — submitOp() and config_op WS event dispatch.
// app-ws.js must call handleConfigOp(ev) when ev.type === 'config_op'.

const _pending = new Map(); // op_id → {resolve, reject, timeout}

// Buffer for terminal events that arrive before submitOp registers the promise.
// Fast Local ops can complete before the HTTP response for POST /ops reaches
// the browser, causing handleConfigOp to fire before _pending has the entry.
const _earlyTerminal = new Map(); // op_id → ev (cleared after 5s)

const OP_TIMEOUT_MS = 90_000; // outer safety net; individual ops have their own timeout_s

export async function submitOp(kind, target, values = {}) {
  const res = await fetch('/ops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, target: target ?? null, payload: { values } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`submitOp HTTP ${res.status}: ${detail.slice(0, 120)}`);
  }
  const { op_id } = await res.json();

  // Check if a terminal event already arrived before we registered (fast Local ops).
  const early = _earlyTerminal.get(op_id);
  if (early) {
    _earlyTerminal.delete(op_id);
    if (early.state === 'success') return { state: 'success', result: early.result };
    throw new Error(early.error ?? 'unknown op error');
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      _pending.delete(op_id);
      reject(new Error(`op ${op_id} timed out (${OP_TIMEOUT_MS / 1000}s)`));
    }, OP_TIMEOUT_MS);
    _pending.set(op_id, { resolve, reject, timeout });
  });
}

// Called by app-ws.js when ev.type === 'config_op' arrives from the server.
export function handleConfigOp(ev) {
  const entry = _pending.get(ev.op_id);
  if (entry) {
    if (ev.state === 'success') {
      clearTimeout(entry.timeout);
      _pending.delete(ev.op_id);
      entry.resolve({ state: 'success', result: ev.result });
    } else if (ev.state === 'error') {
      clearTimeout(entry.timeout);
      _pending.delete(ev.op_id);
      entry.reject(new Error(ev.error ?? 'unknown op error'));
    }
    // saving / validating / rebooting: fire-and-forget progress states; do not resolve yet
    return;
  }
  // No pending promise yet — buffer terminal events for 5s so submitOp can find them.
  if (ev.state === 'success' || ev.state === 'error') {
    _earlyTerminal.set(ev.op_id, ev);
    setTimeout(() => _earlyTerminal.delete(ev.op_id), 5000);
  }
}
