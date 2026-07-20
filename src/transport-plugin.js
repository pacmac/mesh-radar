// The seam between node-dash and everything the PAC alarm carries that stock
// Meshtastic does not — portnums 256/260/261, the `@<target> <verb>` command
// grammar, chunked binary transfer, pull/dequeue messaging.
//
// This file is the INTERFACE AND LOADER. It is deliberately ignorant of the
// protocol: no portnum literals, no wire formats, no command grammar. Those
// live in the implementation (mt-transport/clients/node), which is a separate
// repo and OPTIONAL at runtime.
//
// Peter's steer (2026-07-19): prefer a plugin so the dashboard is not dependent
// on it. So an absent implementation is a NORMAL state, not a failure. A machine
// with only stock Meshtastic nodes boots clean, serves every page, and simply
// does not offer the alarm-specific surfaces.
//
// Callers branch on `can(cap)`. Never on try/catch, never on
// `typeof fn === 'function'`.

import { log } from './log.js';
import { adaptMtTransport, looksLikeMtTransport } from './transport-adapter.js';

// Only capability-named FUNCTIONS count. A module exporting a `chunk` object or
// a `PORT_ALARM` constant is not offering a capability, and picking those up
// would advertise something we cannot call.
const pickFunctions = (o) => Object.fromEntries(
  CAPABILITIES.filter(c => typeof o?.[c] === 'function').map(c => [c, o[c]])
);

// The contract. Capability names are stable API — the browser and the REST
// layer key off these, so renaming one is a breaking change.
export const CAPABILITIES = Object.freeze([
  'configSet',    // validate + send a setting, confirm by device reply
  'debug260',     // portnum 260 JSON: debug + config broadcast
  'tilt256',      // portnum 256 tilt decode
  'chunkPush',    // portnum 261 chunked transfer, PUSH — the device streams and the
                  // client runs the receiver loop. Pull ('chunkFetch') was removed:
                  // its follow-up requests were the failure (stall at 16/32).
  'pullQueue',    // store-and-forward messages the device dequeues
]);

// Result vocabulary matches node-settings.js exactly (applied | rejected |
// no_reply | invalid) so settings-api.js's existing 400/409/504 mapping carries
// over untouched. `unavailable` is the one addition, and it is reserved: only
// the null object ever returns it.
const UNAVAILABLE = Object.freeze({
  ok: false,
  state: 'unavailable',
  error: 'no transport implementation loaded',
});

// Null object. Every capability is absent, every call is a clean negative.
// Note this is what makes the absent case safe at every call site — there is no
// branch a caller can forget.
function nullTransport(detail) {
  return Object.freeze({
    available: false,
    source: null,
    reason: detail ?? 'not installed',
    can: () => false,
    // No capability methods. `can()` is false for all of them, so a caller that
    // honours the contract never reaches for one. A caller that does not gets a
    // TypeError at its own call site, which is the correct place to see it.
  });
}

// Resolution order. Env first — that is how bridge.js and rotator.js already
// take their endpoints (see the rotator-targets-no-hardcoded-ip task), so this
// follows the house convention rather than inventing a third mechanism.
function candidatePaths() {
  const out = [];
  if (process.env.MT_TRANSPORT_PATH) out.push(process.env.MT_TRANSPORT_PATH);
  out.push('mt-transport');   // resolved from node_modules by the loader
  return out;
}

let _cached = null;   // module scope, NOT exported as a mutable binding — see below

/**
 * Locate and load a transport implementation. Idempotent: repeat calls return
 * the same object identity.
 *
 * Resolves ALWAYS. It never rejects for absence, and it never rejects for a
 * broken implementation either — both degrade to the null object, because
 * neither is a reason to stop node-dash from booting.
 *
 * @returns {Promise<object>} a Transport (real or null-object)
 */
export async function loadTransport() {
  if (_cached) return _cached;

  for (const path of candidatePaths()) {
    try {
      const mod = await import(path);

      // Two shapes are accepted, and the order matters.
      //
      // 1. Direct: exports functions named after our capabilities. This is the
      //    shape a purpose-built plugin would take, and what the test fixtures
      //    use.
      // 2. Facade: the real mt-transport module exports { Client, chunk, cmd,
      //    parse260, ... } — its own vocabulary, not ours. transport-adapter.js
      //    maps it. Keeping that mapping out of this file is what lets this file
      //    stay protocol-free.
      //
      // Direct wins, so a plugin can override the adapter deliberately.
      const direct = mod.default ?? mod;
      const adapted = looksLikeMtTransport(mod) ? adaptMtTransport(mod) : {};
      const impl = { ...adapted, ...pickFunctions(direct) };

      // Trust nothing about the shape. The implementation lives in another repo
      // on its own release cycle; a capability we cannot verify is a capability
      // we do not advertise.
      const caps = new Set(
        CAPABILITIES.filter(c => typeof impl?.[c] === 'function')
      );

      if (caps.size === 0) {
        // Imported cleanly but exposes nothing we recognise. That is a version
        // mismatch, not an install — say so plainly rather than pretending.
        log.warn('transport', `loaded ${path} but it exposes no known capability — treating as absent`);
        _cached = nullTransport(`${path}: no recognised capabilities`);
        return _cached;
      }

      _cached = Object.freeze({
        available: true,
        source: path,
        reason: null,
        can: (cap) => caps.has(cap),
        // Bind through only what we verified. A method is present iff can() is
        // true — the invariant the spec promises callers.
        ...Object.fromEntries(
          [...caps].map(c => [c, (...args) => _invoke(impl, c, args)])
        ),
      });

      // Version, when the implementation offers it. It is loaded by PATH rather than as
      // a dependency, so "which client is actually running?" is otherwise unanswerable
      // from here — and today that question cost real debugging time on both sides.
      const ver = [
        mod.CLIENT_VERSION ? `client ${mod.CLIENT_VERSION}` : null,
        mod.PUSH_PROTO_VERSION != null ? `push proto ${mod.PUSH_PROTO_VERSION}` : null,
      ].filter(Boolean).join(', ');
      log.info('transport', `loaded ${path}${ver ? ` (${ver})` : ''} — capabilities: ${[...caps].join(', ')}`);
      return _cached;
    } catch (e) {
      // ERR_MODULE_NOT_FOUND is the ordinary "not installed" path and is not
      // worth a warning. Anything else means the module exists but is broken,
      // which is worth saying out loud once.
      if (e?.code !== 'ERR_MODULE_NOT_FOUND') {
        log.warn('transport', `${path} failed to load: ${e.message}`);
      }
    }
  }

  log.debug('transport', 'no implementation found — alarm-specific surfaces disabled');
  _cached = nullTransport('not installed');
  return _cached;
}

// Normalise whatever the implementation throws or returns into the one documented
// shape. The implementation is another repo's code: it may throw, may reject, may
// return a bare value. Callers should not have to care.
async function _invoke(impl, cap, args) {
  try {
    const r = await impl[cap](...args);
    // Already in our shape — pass through untouched.
    if (r && typeof r === 'object' && 'ok' in r) return r;
    return { ok: true, state: 'applied', value: r };
  } catch (e) {
    return { ok: false, state: 'error', error: e?.message ?? String(e) };
  }
}

/**
 * The loaded Transport. Throws if called before loadTransport() — that is a
 * programming error (wiring order), and it is deliberately distinguishable from
 * the implementation being absent, which is not an error at all.
 */
export function transport() {
  if (!_cached) throw new Error('transport() called before loadTransport()');
  return _cached;
}

// Test seam only. Module-scope singleton rather than exported mutable state —
// same lesson as app-node-status.js, where live objects held on reactive state
// got wrapped in a Proxy and broke in ways that took hours to find.
export function _resetForTests() { _cached = null; }
