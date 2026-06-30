import { scanner } from './scanner.js';
import { dashMode } from './dash-mode.js';
import { rotator } from './rotator.js';
import { activeTracker } from './active-tracker.js';
import { nodeList } from './node-list.js';
import { passiveTracer } from './passive-tracer.js';
import { traceroute } from './traceroute.js';
import { FF } from './feature-flags.js';
import { getRotatorAddress, resolvePrimaryNodeId, onHomePosChange } from './device-config.js';
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
    if (FF.SSOT_TRACEROUTE && contact.from) {
      const sender = resolvePrimaryNodeId();
      if (sender)
        traceroute.dispatch({ to: contact.from, device: sender, cooldownMs: TRACE_COOLDOWN_MS, cooldownKey: contact.from })
          .catch(() => {});
    }
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

  // Passive tracer — must init after bridge.on('event') so nodeList.setTraceroute
  // runs before the 'traced' emit is broadcast.
  passiveTracer.init();

  // -- rotator lifecycle -------------------------------------------------------
  rotator.on('connected', () => {});

  rotator.on('point_target', (data) => {
    const num    = data.point_target;
    const sender = resolvePrimaryNodeId();
    if (!num || !sender) return;

    // ── [V1] LEGACY — remove when SSOT_TRACEROUTE verified ──────────────────
    if (!FF.SSOT_TRACEROUTE) {
      if (!rotator._lastTracedNum) rotator._lastTracedNum = null;
      if (!rotator._lastTracedAt)  rotator._lastTracedAt  = 0;
      const now = Date.now();
      if (num === rotator._lastTracedNum && now - rotator._lastTracedAt < TRACE_COOLDOWN_MS) return;
      rotator._lastTracedNum = num;
      rotator._lastTracedAt  = now;
      bridge.post(`/${sender}/traceroute`, { to: num }).catch(() => {});
    // ── [V2] SSOT — traceroute.js owns dispatch and cooldown ─────────────────
    } else {
      traceroute.dispatch({ to: num, device: sender, cooldownMs: TRACE_COOLDOWN_MS, cooldownKey: num })
        .catch(() => {});
    }
    // ─────────────────────────────────────────────────────────────────────────
  });
}
