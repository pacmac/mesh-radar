// Dynamic form building and data collection from /schema/* API responses.

export const SENSITIVE_FIELDS = new Set(['psk', 'macaddr', 'public_key', 'private_key', 'password']);

// Maps Alpine nodeFilters keys → /config API keys
export const FILTER_CFG_KEY = {
  maxHops:    'node_filters.max_hops',
  maxAge:     'node_filters.max_age',
  namedOnly:  'node_filters.named_only',
  hasPos:     'node_filters.has_pos',
  hideMqtt:   'node_filters.hide_mqtt',
  hasSignal:  'node_filters.has_signal',
  hasTelem:   'node_filters.has_telem',
  msgOnly:    'node_filters.msg_only',
  nodeRoles:  'node_filters.roles',
  nodeSource: 'node_filters.node_source',
};

export function buildForm(fields, data, path, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'grid grid-cols-1 sm:grid-cols-2 gap-3';
  for (const field of fields)
    wrap.appendChild(buildField(field, data?.[field.name], path.concat(field.name), opts));
  return wrap;
}

function _formRoot(el) {
  return el.closest('[data-form-root]');
}

export function buildField(field, value, path, opts = {}) {
  const fieldPath = path.join('.');
  if (field.type === 'object') {
    const box = document.createElement('div');
    box.className = 'col-span-1 sm:col-span-2 border border-base-300 rounded-lg p-3';
    const title = document.createElement('div');
    title.className = 'text-xs font-semibold uppercase text-base-content/50 mb-2';
    title.textContent = field.name.replace(/_/g, ' ');
    box.appendChild(title);
    box.appendChild(buildForm(field.fields, value || {}, path, opts));
    return box;
  }
  const ctl = document.createElement('label');
  ctl.className = 'form-control w-full';
  const labelRow = document.createElement('div');
  labelRow.className = 'label py-1';
  const labelText = document.createElement('span');
  labelText.className = 'label-text text-xs';
  labelText.textContent = (field.label ?? field.name.replace(/_/g, ' ')) + (field.repeated ? ' (comma separated)' : '');
  labelRow.appendChild(labelText);
  if (field.unit) {
    const unitSpan = document.createElement('span');
    unitSpan.className = 'label-text-alt text-xs opacity-50';
    unitSpan.textContent = field.unit;
    labelRow.appendChild(unitSpan);
  }
  ctl.appendChild(labelRow);

  const sensitive = SENSITIVE_FIELDS.has(field.name);
  let input;

  if (field.type === 'bool' && !field.repeated) {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'toggle toggle-primary toggle-sm';
    input.checked = !!value;
    input.dataset.field = fieldPath;
    input.dataset.type = field.type;
    ctl.style.flexDirection = 'row';
    ctl.style.alignItems = 'center';
    ctl.style.justifyContent = 'space-between';
  } else if (field.type === 'enum' && !field.repeated) {
    input = document.createElement('select');
    input.className = 'select select-bordered select-sm w-full';
    for (const opt of field.options) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt;
      if (opt === value) o.selected = true;
      input.appendChild(o);
    }
    input.dataset.field = fieldPath;
    input.dataset.type = field.type;
  } else {
    input = document.createElement('input');
    input.className = 'input input-bordered input-sm w-full font-mono';
    input.dataset.field = fieldPath;
    input.dataset.type = field.type;
    input.dataset.repeated = field.repeated ? '1' : '';
    if (field.repeated) {
      input.type = 'text';
      input.value = Array.isArray(value) ? value.join(', ') : '';
    } else if (field.type === 'int') {
      input.type = 'number'; input.step = '1'; input.value = value ?? 0;
      if (field.min !== undefined) input.min = field.min;
    } else if (field.type === 'float') {
      input.type = 'number'; input.step = 'any'; input.value = value ?? 0;
      if (field.min !== undefined) input.min = field.min;
    } else {
      input.type = (sensitive && field.type !== 'bytes') ? 'password' : 'text';
      input.value = value ?? '';
      if (sensitive && field.type !== 'bytes' && !value) {
        input.placeholder = 'not set';
      }
    }
    if (sensitive && !opts.readonly) {
      input.disabled = true;
      const unlock = document.createElement('label');
      unlock.className = 'label cursor-pointer gap-1 py-0';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'checkbox checkbox-xs';
      cb.addEventListener('change', () => {
        input.disabled = !cb.checked;
        input.type = cb.checked ? 'text' : 'password';
        if (!cb.checked && !input.value) input.placeholder = 'not set';
      });
      const lbl = document.createElement('span');
      lbl.className = 'label-text text-xs text-warning';
      lbl.textContent = 'unlock to edit';
      unlock.appendChild(cb); unlock.appendChild(lbl);
      labelRow.appendChild(unlock);
    }
  }
  if (opts.readonly) {
    input.disabled = true;
    if (input.tagName === 'SELECT') input.classList.add('opacity-60');
  }

  input.addEventListener('focus',  () => { ctl.classList.add('field-focused'); });
  input.addEventListener('blur',   () => { ctl.classList.remove('field-focused'); });
  input.addEventListener('input',  () => { _formRoot(input)?.setAttribute('data-dirty', '1'); });
  input.addEventListener('change', () => { _formRoot(input)?.setAttribute('data-dirty', '1'); });

  ctl.appendChild(input);
  if (field.hint) {
    const hintRow = document.createElement('div');
    hintRow.className = 'label py-0';
    const hintSpan = document.createElement('span');
    hintSpan.className = 'label-text-alt text-xs opacity-50';
    hintSpan.textContent = field.hint;
    hintRow.appendChild(hintSpan);
    ctl.appendChild(hintRow);
  }
  return ctl;
}

export function collectForm(container, fields) {
  return _collectFromInputs(container, fields, []);
}

function _collectFromInputs(container, fields, path) {
  const out = {};
  for (const field of fields) {
    const p = path.concat(field.name);
    if (field.type === 'object') { out[field.name] = _collectFromInputs(container, field.fields, p); continue; }
    const input = container.querySelector(`[data-field="${p.join('.')}"]`);
    if (!input || input.disabled) continue;
    out[field.name] = _readFieldValue(input, field);
  }
  return out;
}

function _readFieldValue(input, field) {
  if (field.type === 'bool' && !field.repeated) return input.checked;
  if (field.repeated) {
    const raw = input.value.split(',').map(s => s.trim()).filter(s => s !== '');
    if (field.type === 'int' || field.type === 'float') return raw.map(Number);
    return raw;
  }
  if (field.type === 'int')   return parseInt(input.value, 10) || 0;
  if (field.type === 'float') return parseFloat(input.value) || 0;
  return input.value;
}
