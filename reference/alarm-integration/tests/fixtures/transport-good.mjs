// Fixture: a transport implementation exposing a SUBSET of capabilities.
// Used by tests/test_transport_plugin.mjs to prove can() is true for exactly
// what is exported and false for everything else.
//
// Deliberately partial — configSet and debug260 only. A real implementation is
// expected to arrive capability-by-capability, so the partial case is the
// normal one, not an edge case.

export function configSet(num, path, value) {
  return { ok: true, state: 'applied', value: { num, path, value } };
}

export function debug260(num) {
  return { ok: true, state: 'applied', value: { num, boot_count: 7 } };
}

// A capability that throws, to prove _invoke() normalises rather than propagates.
export function tilt256() {
  throw new Error('sensor offline');
}
