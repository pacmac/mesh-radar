// Node settings — save, validate, confirm by reply.
//
// THE SSOT RULE: this module never writes a setting into node-dash state. A
// successful reply means the command was ACCEPTED; the value the page shows
// keeps coming from the device's own `type:config` broadcast, cached in
// node_app_state. If the device disagrees with what we asked for, the device
// wins. One source of truth, and it is the radio.
//
// Contract: docs/mt-transport/API.md §3 (addressed grammar, replies threaded by
// reply_id) + config-schema.json (what is settable, and its range).

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { stmts, getConfig } from './db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, '..', 'docs', 'mt-transport', 'config-schema.json');

// Static per firmware version and symlinked in — read once at load.
let SCHEMA = { ver: null, settings: [] };
try {
  SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
} catch (e) {
  console.error('[settings] config-schema.json unreadable:', e.message);
}

const REPLY_TIMEOUT_MS = 30_000;

// Settings whose command takes more than one positional argument are NOT wired
// yet. det.win shares `cmd: detect` with the readonly det.n and API.md §3 says
// the first arg is ignored — guessing the shape would risk writing the wrong
// field on a live radio.
const UNSUPPORTED = new Set(['det.win']);

// packet id → { resolve, timer, path, expectType }
const _pending = new Map();

export function settingsSchema() {
  return SCHEMA;
}

function findSetting(p) {
  return (SCHEMA.settings || []).find(s => s.path === p) ?? null;
}

// Validate BEFORE transmitting. An out-of-range value never reaches the air;
// the device re-validates and stays authoritative.
export function validateSetting(p, value) {
  const def = findSetting(p);
  if (!def)                return { ok: false, error: `unknown setting: ${p}` };
  if (def.readonly)        return { ok: false, error: `${p} is read-only` };
  if (UNSUPPORTED.has(p))  return { ok: false, error: `${p} needs a multi-argument command that is not wired yet` };
  if (!def.cmd)            return { ok: false, error: `${p} has no command` };

  if (def.type === 'bool') {
    if (value !== 0 && value !== 1 && value !== true && value !== false) {
      return { ok: false, error: `${p} expects a boolean` };
    }
    return { ok: true, def, arg: (value === 1 || value === true) ? (def.on ?? 'on') : (def.off ?? 'off') };
  }

  const n = Number(value);
  if (!Number.isFinite(n))                      return { ok: false, error: `${p} expects a number` };
  if (def.type === 'int' && !Number.isInteger(n)) return { ok: false, error: `${p} expects a whole number` };
  if (def.min != null && n < def.min)           return { ok: false, error: `${p} below minimum ${def.min}` };
  if (def.max != null && n > def.max)           return { ok: false, error: `${p} above maximum ${def.max}` };
  return { ok: true, def, arg: String(n) };
}

// Channel is resolved from the SENDING RADIO's own channel list, by name.
// Never hardcoded, and never inferred from historical traffic — firmware
// generations have changed and old logs do not describe current behaviour.
//
// HARD SAFETY INVARIANT (Peter, 2026-07-18: "you can send on PRIVATE but NEVER
// on PRIMARY"): index 0 is refused outright, and so is the absence of a channel
// named Private. Refusing is correct; guessing is not.
export function resolveCommandChannel(gatewayChannels) {
  const override = getConfig('command_channel', null);
  if (override != null) {
    const idx = Number(override);
    if (!Number.isInteger(idx) || idx === 0) {
      return { ok: false, error: 'command_channel must be a non-zero channel index' };
    }
    return { ok: true, channel: idx };
  }
  const named = (gatewayChannels || []).find(c => /private/i.test(c?.name || ''));
  if (!named)            return { ok: false, error: 'no channel named "Private" on the sending radio' };
  if (named.index === 0) return { ok: false, error: 'the Private channel resolves to index 0 (primary) — refusing' };
  return { ok: true, channel: named.index };
}

// Called from bridge-events AFTER persistence, for every TEXT_MESSAGE_APP that
// carries a reply_id. Resolves the pending command it answers, if any.
export function handleReply(replyId, text) {
  if (!replyId) return false;
  const entry = _pending.get(replyId);
  if (!entry) return false;

  let payload = null;
  try { payload = JSON.parse(text); } catch { /* not our JSON envelope */ }
  if (!payload || typeof payload.type !== 'string') return false;

  clearTimeout(entry.timer);
  _pending.delete(replyId);

  if (payload.type === 'err') {
    entry.resolve({ ok: false, state: 'rejected', reply: payload, error: payload.msg || 'device rejected the command' });
  } else if (payload.ok === true) {
    entry.resolve({ ok: true, state: 'applied', reply: payload });
  } else {
    // A typed reply without ok:true is not a confirmation.
    entry.resolve({ ok: false, state: 'rejected', reply: payload, error: 'device did not confirm (no ok:true)' });
  }
  return true;
}

/**
 * Save one setting on one node and confirm it by reply.
 *
 * @param {object}   o
 * @param {number}   o.num              target node num
 * @param {string}   o.path             config-schema path, e.g. 'beat'
 * @param {*}        o.value            desired value
 * @param {string}   o.gatewayNodeId    sending radio, '!hexid'
 * @param {Array}    o.gatewayChannels  that radio's channels [{index,name,role}]
 * @param {Function} o.send             async ({text, channel}) => { id }
 * @returns {Promise<{ok, state, sent?, reply?, error?}>}
 *          state: applied | rejected | no_reply | invalid
 */
export async function saveNodeSetting({ num, path: settingPath, value, gatewayNodeId, gatewayChannels, send }) {
  const v = validateSetting(settingPath, value);
  if (!v.ok) return { ok: false, state: 'invalid', error: v.error };

  const node = stmts.getNodeByNum.get(num) ?? null;
  const target = node?.short_name;
  if (!target) {
    // A bare @verb is silently ignored by current firmware, so without a target
    // the command would vanish. Refuse rather than transmit something inert.
    return { ok: false, state: 'invalid', error: `node ${num} has no short_name to address` };
  }

  const ch = resolveCommandChannel(gatewayChannels);
  if (!ch.ok) return { ok: false, state: 'invalid', error: ch.error };

  const text = `@${target} ${v.def.cmd} ${v.arg}`.trim();

  let sent;
  try {
    sent = await send({ text, channel: ch.channel });
  } catch (e) {
    return { ok: false, state: 'invalid', error: `send failed: ${e.message}` };
  }
  if (!sent?.id) return { ok: false, state: 'invalid', error: 'gateway returned no packet id' };

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      _pending.delete(sent.id);
      // Silence is NOT success. A sleeping or out-of-range node simply does not
      // answer, and reporting that as applied would be a lie.
      resolve({ ok: false, state: 'no_reply', sent: { text, channel: ch.channel, id: sent.id },
                error: `no reply within ${REPLY_TIMEOUT_MS / 1000}s` });
    }, REPLY_TIMEOUT_MS);

    _pending.set(sent.id, {
      path: settingPath,
      timer,
      resolve: r => resolve({ ...r, sent: { text, channel: ch.channel, id: sent.id } }),
    });
  });
}

// Test/introspection aid — how many commands are awaiting a reply.
export function pendingCount() {
  return _pending.size;
}
