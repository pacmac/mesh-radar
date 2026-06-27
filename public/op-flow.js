// op-flow.js — High-level save/validate lifecycle for a single op.
// Combines submitOp + loading state on a trigger element + toast feedback.

import { submitOp } from './op-client.js';
import { showToast } from './op-toast.js';

const PROGRESS_LABEL = {
  saving:    'Saving…',
  validating:'Validating…',
  rebooting: 'Rebooting…',
};

// opFlow — the single entry point for all form saves and action triggers.
//
// kind    — op registry key e.g. 'device_config_label'
// target  — node_id (!hexid) or BLE address, or null for server-level ops
// values  — flat object of fields to write
// opts    — {
//   element: HTMLElement | null  — button/submit that triggered the action
//   successMsg: string           — override default "Saved" toast
//   errorPrefix: string          — prefix for error toast message
// }
//
// Returns Promise<{state:'success', result}> on success.
// Throws on error (the error is also shown as a toast).
export async function opFlow(kind, target, values = {}, opts = {}) {
  const { element = null, successMsg = 'Saved', errorPrefix = '' } = opts;

  _setLoading(element, 'saving');

  try {
    const outcome = await submitOp(kind, target, values);
    if (successMsg) showToast('success', successMsg);
    _clearLoading(element);
    return outcome;
  } catch (err) {
    const msg = errorPrefix ? `${errorPrefix}: ${err.message}` : err.message;
    showToast('error', msg);
    _clearLoading(element);
    throw err;
  }
}

// Convenience: fire an op without returning a promise (fire-and-forget with toast).
// Useful for @click handlers that don't need to await completion.
export function fireOp(kind, target, values = {}, opts = {}) {
  opFlow(kind, target, values, opts).catch(() => {}); // toast already shown inside opFlow
}

function _setLoading(el, state) {
  if (!el) return;
  el.disabled = true;
  el._opOrigText = el.textContent;
  el.textContent = PROGRESS_LABEL[state] ?? 'Working…';
}

function _clearLoading(el) {
  if (!el) return;
  el.disabled = false;
  if (el._opOrigText !== undefined) {
    el.textContent = el._opOrigText;
    delete el._opOrigText;
  }
}
