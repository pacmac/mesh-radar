// DOM-driven unified persistence.
// Intercepts 'change' events on all form elements (unless ancestor has .no-persist class).
// Detects type from element — checkbox → bool, number/range → number,
// select[multiple] → array, radio group / checkbox group (shared name) → string / array, else → string.
// Everything lands in a single localStorage key 'ui_prefs' as one JSON object.
//
// Usage:
//   Call initPersist() once in Alpine init().
//   Use persistGet/persistSet for non-form state (buttons, computed values, etc.).
//   Add class="no-persist" to any element (or its ancestor) that should be excluded.

const KEY = 'ui_prefs';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

function dump(prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
}

function skip(el) {
  return !el || !!el.closest?.('.no-persist');
}

function isFormEl(el) {
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(el?.tagName);
}

function groupCount(name) {
  return name ? document.querySelectorAll(`[name="${CSS.escape(name)}"]`).length : 0;
}

function readEl(el) {
  if (el.tagName === 'SELECT' && el.multiple)
    return Array.from(el.selectedOptions).map(o => o.value);
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number' || el.type === 'range')
    return el.value === '' ? null : Number(el.value);
  return el.value;
}

function readGroup(name) {
  const els = Array.from(document.querySelectorAll(`[name="${CSS.escape(name)}"]`));
  if (!els.length) return undefined;
  if (els[0].type === 'radio')
    return (els.find(e => e.checked) || {}).value ?? null;
  if (els[0].type === 'checkbox')
    return els.filter(e => e.checked).map(e => e.value);
}

function applyEl(el, val) {
  if (el.tagName === 'SELECT' && el.multiple) {
    const want = new Set(Array.isArray(val) ? val.map(String) : [String(val)]);
    let dirty = false;
    for (const opt of el.options) {
      if (opt.selected !== want.has(opt.value)) { opt.selected = want.has(opt.value); dirty = true; }
    }
    if (dirty) fire(el, 'input', 'change');
  } else if (el.type === 'checkbox') {
    const want = !!val;
    if (el.checked !== want) { el.checked = want; fire(el, 'change'); }
  } else if (el.type === 'radio') {
    const want = String(val ?? '') === el.value;
    if (el.checked !== want) { el.checked = want; if (want) fire(el, 'change'); }
  } else {
    const str = val == null ? '' : String(val);
    if (el.value !== str) { el.value = str; fire(el, 'input', 'change'); }
  }
}

function applyGroup(name, val) {
  const els = Array.from(document.querySelectorAll(`[name="${CSS.escape(name)}"]`));
  if (!els.length) return;
  if (els[0].type === 'radio') {
    const target = String(val ?? '');
    for (const el of els) {
      const want = el.value === target;
      if (el.checked !== want) { el.checked = want; if (want) fire(el, 'change'); }
    }
  } else if (els[0].type === 'checkbox') {
    const saved = new Set(Array.isArray(val) ? val.map(String) : []);
    for (const el of els) {
      const want = saved.has(el.value);
      if (el.checked !== want) { el.checked = want; fire(el, 'change'); }
    }
  }
}

function fire(el, ...events) {
  for (const name of events) el.dispatchEvent(new Event(name, { bubbles: true }));
}

function onchange(e) {
  const el = e.target;
  if (!isFormEl(el) || skip(el)) return;
  const name = el.name?.trim();
  const id   = el.id?.trim();
  const isGrp = name && groupCount(name) > 1;
  const key  = isGrp ? name : (name || id);
  if (!key) return;
  const prefs = load();
  prefs[key] = isGrp ? readGroup(name) : readEl(el);
  dump(prefs);
}

function restore() {
  const prefs = load();
  if (!Object.keys(prefs).length) return;
  const seen = new Set();

  document.querySelectorAll('input, select, textarea').forEach(el => {
    if (!isFormEl(el) || skip(el)) return;
    const name = el.name?.trim();
    const id   = el.id?.trim();

    if (name && groupCount(name) > 1) {
      if (seen.has(name) || !(name in prefs)) return;
      seen.add(name);
      applyGroup(name, prefs[name]);
    } else {
      const key = name || id;
      if (!key || !(key in prefs)) return;
      applyEl(el, prefs[key]);
    }
  });
}

export function initPersist() {
  document.addEventListener('change', onchange, true);
  document.addEventListener('alpine:initialized', restore);
}

// For non-form state: buttons, calculated values, programmatic updates.
// Uses the same 'ui_prefs' blob so everything is unified.
export function persistSet(key, value) {
  const prefs = load();
  prefs[key] = value;
  dump(prefs);
}

export function persistGet(key, defaultValue) {
  const v = load()[key];
  return v !== undefined ? v : defaultValue;
}
