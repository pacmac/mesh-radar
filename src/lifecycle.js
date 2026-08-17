import { scanner } from './scanner.js';
import { dashMode, transmitterForMode } from './dash-mode.js';
import { rotator } from './rotator.js';
import { activeTracker } from './active-tracker.js';
import { nodeList } from './node-list.js';
import { FF } from './feature-flags.js';
import { getRotatorAddress, onHomePosChange } from './device-config.js';
import { bridge } from './bridge.js';

const TRACE_COOLDOWN_MS = 5 * 60 * 1000;

export function initLifecycle() {
  onHomePosChange(() => nodeList.refilter());

  // -- scanner lifecycle -------------------------------------------------------
  scanner.on('start', () => {
    activeTracker.stop();   // ACTV and SCAN are mutually exclusive
    dashMode.set(2);
    nodeList.setScanActive(true);
  });
  scanner.on('contact', (contact) => {
    const rotatorId = getRotatorAddress();
    if (contact.from && rotatorId)
      nodeList.confirmScanContact(contact.from, rotatorId, contact.az, contact.rssi, contact.snr);
    // SCAN's traceroute dispatch — REMOVED 2026-08-17, task
    // `traceroute-callers-rewrite`. confirmScanContact above is untouched: the
    // contact is still recorded, it is just no longer traced.
    //
    // Worth keeping when this is rebuilt: SCAN is ALREADY pointing at the
    // contact's bearing, because the sweep put it there. Whatever replaces this
    // must not re-aim and fight the scanner.
  });
  scanner.on('end', () => {
    dashMode.set(scanner._preMode);
    nodeList.setScanActive(false);
  });

  // -- ACTV mode lifecycle -----------------------------------------------------
  dashMode.on('change', ({ _mode }) => {
    if (_mode === 1) {
      if (scanner.active) return;  // SCAN takes precedence; refuse silent ACTV start
      activeTracker.start();
    } else {
      activeTracker.stop();
    }
  });

  // Resume active mode if it was persisted before restart
  if (dashMode.value === 1) activeTracker.start();

  // src/passive-tracer.js is DELETED — 2026-08-17, task
  // `traceroute-remove-backend-remainder`. Its whole job was to traceroute a
  // node it had just heard, so once the dispatch was removed the module was an
  // empty listener. PASV mode still exists and still listens; it no longer acts.

  // -- rotator lifecycle -------------------------------------------------------
  rotator.on('connected', () => {});

  // ACTV's traceroute dispatch on `point_target` — REMOVED 2026-08-17, task
  // `traceroute-callers-rewrite`. It held BOTH paths: a V1 legacy bridge.post()
  // with its own hand-rolled cooldown on the rotator object, and the V2
  // traceroute.run(). Both gone.
  //
  // Worth keeping when this is rebuilt: `point_target` MEANS the tracker has
  // already aimed at that node, so the replacement must not move the beam
  // again — and the V1 branch is the reason cooldown belongs inside the
  // dispatcher rather than being reinvented per caller.
}
