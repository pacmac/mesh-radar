// op-toast.js — Toast notifications for op state transitions (DaisyUI alert style).

const DURATION = { success: 3000, error: 8000, rebooting: 5000, default: 4000 };

const STATE_CLASS = {
  success:    'alert-success',
  error:      'alert-error',
  rebooting:  'alert-warning',
  validating: 'alert-info',
  saving:     'alert-info',
};

const STATE_ICON = {
  success:    '✓',
  error:      '✕',
  rebooting:  '↺',
  validating: '…',
  saving:     '…',
};

function _container() {
  let el = document.getElementById('op-toast-container');
  if (!el) {
    el = document.createElement('div');
    el.id = 'op-toast-container';
    el.style.cssText =
      'position:fixed;bottom:1.25rem;right:1.25rem;z-index:9999;' +
      'display:flex;flex-direction:column-reverse;gap:0.5rem;max-width:22rem;pointer-events:none;';
    document.body.appendChild(el);
  }
  return el;
}

export function showToast(state, message, durationMs) {
  const container = _container();
  const cls = STATE_CLASS[state] ?? 'alert-neutral';
  const icon = STATE_ICON[state] ?? '•';
  const ms = durationMs ?? DURATION[state] ?? DURATION.default;

  const el = document.createElement('div');
  el.style.pointerEvents = 'auto';
  el.className = `alert ${cls} shadow-md text-sm py-2 px-3 gap-2 rounded-lg`;
  el.innerHTML =
    `<span class="font-bold">${icon}</span>` +
    `<span class="flex-1 min-w-0 break-words">${_esc(message)}</span>`;

  container.appendChild(el);

  // Fade-out then remove
  const removeEl = () => {
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  };
  const timer = setTimeout(removeEl, ms);
  el.addEventListener('click', () => { clearTimeout(timer); removeEl(); });
}

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
