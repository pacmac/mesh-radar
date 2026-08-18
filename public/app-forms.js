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

// SEED FROM THE SCHEMA DEFAULT WHEN THE READ OMITTED THE FIELD.
//
// This is the bug that turned a radio's fixed_position off. mesh-gw's
// GET /{node_id}/config/{section} returns ONLY non-default fields, and
// collectForm() submits EVERY field in the section on every save. So a boolean
// the gw omitted rendered as an unchecked box and went back on the wire as an
// explicit `false` — an unrelated edit in the same section silently cleared it.
//
// Evidence: OMNI still has fixed_position:true, YAGI does not have the key at
// all, same schema and same form. Both have gps_mode NOT_PRESENT, so neither can
// re-acquire a position on its own.
//
// `field.default` (from the gw's schema) is used when the data object has no
// entry for the field, so an omitted field renders at its TRUE default rather
// than at the widget's default. Where the schema declares no default we fall
// through to the previous behaviour, which is the best available.
//
// This does not fix the underlying asymmetry — a GET that cannot say "unchanged"
// means a whole-section PUT can never be perfectly safe. That is open with
// mesh-gw as #18/#19. This removes the damage we can remove on our side.
function _seed(field, data) {
  if (data && Object.prototype.hasOwnProperty.call(data, field.name)) return data[field.name];
  return field.default !== undefined ? field.default : undefined;
}

export function buildForm(fields, data, path, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'grid grid-cols-1 sm:grid-cols-2 gap-3';
  for (const field of fields)
    wrap.appendChild(buildField(field, _seed(field, data), path.concat(field.name), opts));
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
    title.className = 'text-xs font-display font-semibold uppercase tracking-wider text-base-content/50 mb-2';
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
  } else if (field.type === 'choice' && !field.repeated) {
    // A CLOSED SET, RENDERED AS A SELECT — this is the whole fix, and it is a
    // control decision rather than a validation one. The phone app does exactly
    // this (DropDownPreference over IntervalConfiguration.allowedIntervals) and
    // that is why, in Peter's words, "it works 100% of the time": there is no
    // invalid state to reject, so there is no rejection path to get wrong.
    //
    // What was here before was a number box carrying an advisory `min` attribute,
    // and because this form is read by collectForm rather than submitted
    // natively, the browser's constraint validation never ran. The attribute
    // decorated a control that enforced nothing.
    input = document.createElement('select');
    input.className = 'select select-bordered select-sm w-full';
    for (const opt of field.options) {
      const o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label;
      // == not ===: the served value is a Number and an option's DOM value is a
      // string. Strict equality would leave the radio's CURRENT setting
      // unselected and silently show the first option instead — which is how a
      // form quietly proposes a change nobody asked for.
      if (value != null && opt.value == value) o.selected = true;
      input.appendChild(o);
    }
    // A value the radio holds that is NOT in the allowlist must stay visible
    // rather than be silently replaced by the nearest legal one. It is shown,
    // marked, and selected — the operator decides whether to change it.
    if (value != null && !field.options.some(o => o.value == value)) {
      const o = document.createElement('option');
      o.value = value; o.textContent = `${value} (not a standard value)`;
      o.selected = true;
      input.insertBefore(o, input.firstChild);
    }
    input.dataset.field = fieldPath;
    input.dataset.type = field.type;
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
      if (field.max !== undefined) input.max = field.max;
    } else if (field.type === 'float') {
      input.type = 'number'; input.step = 'any'; input.value = value ?? 0;
      if (field.min !== undefined) input.min = field.min;
      if (field.max !== undefined) input.max = field.max;
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
  // PER-INPUT dirty, as well as per-form. The form-level flag says "something
  // changed"; only the per-input flag says WHICH, and collectForm needs that to
  // avoid submitting values the user never touched.
  input.addEventListener('input',  () => { input.dataset.dirty = '1'; _formRoot(input)?.setAttribute('data-dirty', '1'); });
  input.addEventListener('change', () => { input.dataset.dirty = '1'; _formRoot(input)?.setAttribute('data-dirty', '1'); });

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

/** Did the radio actually take what we sent?
 *
 *  Until 2026-08-18 three Save buttons reported "saved & verified" and NOTHING
 *  compared anything. saveSection re-read the section after the POST and a comment
 *  called it "the verified server state", but it only repainted the form with it.
 *  So "verified" was shown for every save, including ones that failed outright and
 *  ones whose read-back landed while the device was RECONNECTING and returned the
 *  OLD value.
 *
 *  Peter's reason for the whole backup chain was "it can prove that what we are
 *  writing to the radio is actually what the radio hold". This is that proof, and
 *  it returns THREE states because two would still be a lie:
 *
 *    verified     every field we sent came back the same
 *    unconfirmed  we cannot tell yet — the radio reboots after most saves, so
 *                 this is the EXPECTED path, not a failure
 *    mismatch     it came back DIFFERENT. The only state that means something is
 *                 wrong, and previously indistinguishable from success.
 *
 *  Pure — no DOM — so it is unit-tested in node. docs/modules/app-config.md. */
export function verifySaved(sent, readback) {
  if (!readback || typeof readback !== 'object')
    return { state: 'unconfirmed', reason: 'no read-back', diffs: [] };

  const diffs = [];
  let missing = 0;

  for (const [key, want] of Object.entries(sent ?? {})) {
    // `__reboot` and `__notes` are added by /config/{section} for the form to
    // render; radio_backup and the save payload carry neither. Not skipping them
    // reported 8 spurious mismatches across 21 sections when measured.
    if (key.startsWith('__')) continue;
    if (!Object.prototype.hasOwnProperty.call(readback, key)) {
      // ABSENCE IS NOT DISAGREEMENT. The gw may not have re-read yet, and a field
      // at its default is omitted from the GET entirely. Calling this a mismatch
      // would cry wolf on the commonest benign case.
      missing++;
      continue;
    }
    const got = readback[key];
    if (!sameValue(want, got)) diffs.push({ field: key, sent: want, radio: got });
  }

  if (diffs.length) return { state: 'mismatch', diffs };
  if (missing)      return { state: 'unconfirmed', reason: `${missing} field(s) absent from read-back`, diffs: [] };
  return { state: 'verified', diffs: [] };
}

/** Loose across number/string: a select's DOM value is a string and the schema's
 *  is a number, and 199 vs "199" is the same setting, not a failed save. Arrays
 *  and nested objects compare structurally. */
function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
  }
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a), nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  return a === b;
}

/** Collect a section's values for submission.
 *
 *  `loaded` is the object the READ returned. When supplied, a field is included
 *  only if the read carried it, or the user actually touched the input.
 *
 *  WHY: mesh-gw's GET returns only NON-DEFAULT fields, while this used to submit
 *  every field in the schema. A boolean the read omitted rendered as an unchecked
 *  box and was written back as an explicit `false` — which is how a radio's
 *  fixed_position got turned off by an unrelated edit in the same section.
 *
 *  The gw's own rejection message names the fields the read returned as the
 *  REQUIRED ones, so omitting the rest is accepted and leaves them untouched.
 *
 *  It also fixes the worse race: if the read has not returned yet the form is
 *  blank, and previously that blank form could be submitted as real values.
 *  Now nothing is submitted, and the gw rejects the write loudly instead of
 *  silently clobbering the radio.
 *
 *  Called without `loaded` the behaviour is unchanged, so the other four callers
 *  keep working exactly as before. */
export function collectForm(container, fields, loaded = undefined) {
  return _collectFromInputs(container, fields, [], loaded);
}

function _collectFromInputs(container, fields, path, loaded = undefined) {
  const out = {};
  for (const field of fields) {
    const p = path.concat(field.name);
    if (field.type === 'object') {
      out[field.name] = _collectFromInputs(container, field.fields, p, loaded?.[field.name]);
      continue;
    }
    // A field the form never rendered must not be invented as a value. Without
    // this, a section whose schema is wider than the rendered form submits
    // defaults for the gaps — the same clobber in a different disguise.
    const input = container.querySelector(`[data-field="${p.join('.')}"]`);
    if (!input || input.disabled) continue;
    if (loaded !== undefined) {
      const wasRead = loaded && Object.prototype.hasOwnProperty.call(loaded, field.name);
      const touched = input.dataset.dirty === '1';
      if (!wasRead && !touched) continue;      // never read, never touched -> do not write
    }
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
  // A `choice` is a closed set of NUMBERS rendered as a select. A DOM select's
  // value is always a string, so this must coerce or we would send "1800" where
  // the protobuf needs an int — a wrong-TYPED value sent while fixing
  // wrong-VALUED ones. Number(), not parseInt: an option value is authored by us
  // and must round-trip exactly, so a non-numeric one should surface as NaN
  // rather than be silently truncated. docs/modules/interval-options.md.
  if (field.type === 'choice') return Number(input.value);
  return input.value;
}
