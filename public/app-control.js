// Control page mixin: pac-host unit picker + command shortcuts + free text.
// Presentation only — posts to /nodes/:num/pac-command, decides nothing about
// what a verb means (BROWSER_CONTRACT). Units come from pacHostStatus.units
// (server-pushed, task custom-app-extension-point) — never a page-load GET.
import { fetchJSON } from './app-helpers.js';

export const CONTROL_SHORTCUTS = ['ping', 'status', 'config', 'reboot'];

// Node ids requiring an explicit confirmation before a command sends — keyed
// on node id (stable), never short name (mutable, per xsession standing
// rule). Today: !987ab80f/GARG, the live production alarm — mt-transport's
// own guidance (2026-07-25): mechanically safe via the API, but ask Peter
// first. This is a one-unit safety gate, not a general special-case: every
// other part of the picker treats units identically.
const CONFIRM_TARGETS = new Set(['!987ab80f']);

export const controlMixin = {
  // pac-host's own unit roster, filtered to role 200 (the PAC_ALARM firmware's
  // own self-declared Meshtastic role — task client-role-pac-alarm) so the
  // picker shows only commandable units, not every node pac-host's mesh-gw
  // view happens to include (its /mesh/nodes roster is the whole mesh).
  controlDevices() {
    return (this.pacHostStatus?.units || [])
      .filter(u => u.raw?.user?.role === 200)
      .map(u => ({ id: u.id, num: u.num, label: u.raw?.user?.short_name || u.name || u.id }));
  },

  controlShortcuts() { return CONTROL_SHORTCUTS; },

  controlTargetLabel() {
    const d = this.controlDevices().find(d => d.num === this.controlTarget);
    return d?.label || '';
  },

  controlTargetNeedsConfirm() {
    const d = this.controlDevices().find(d => d.num === this.controlTarget);
    return !!d && CONFIRM_TARGETS.has(d.id);
  },

  async sendControl(verb) {
    const v = (verb ?? this.controlVerb ?? '').trim();
    if (!v) return;
    if (this.controlTarget == null) { this.showToast('Select a unit first', 'error', 0); return; }
    if (this.controlTargetNeedsConfirm() && !window.confirm(
      `${this.controlTargetLabel()} is the live production alarm. Send "${v}"?`
    )) return;

    this.controlSending = true;
    try {
      const result = await fetchJSON(`/nodes/${this.controlTarget}/pac-command`, 'POST', { verb: v });
      this.controlVerb = '';
      this.showToast(`Queued: ${result.id}`, 'success', 3000);
      this.refreshControlLedger();
    } catch (e) {
      this.showToast(e.message || 'Command failed', 'error', 0);
    } finally {
      this.controlSending = false;
    }
  },

  // Receipts are polled (pac-host's REST ledger), not WS-pushed — there is no
  // command_history feed anymore (that was the archived mesh-gw-text design).
  async refreshControlLedger() {
    if (this.controlTarget == null) { this.controlLedger = []; return; }
    try {
      this.controlLedger = await fetchJSON(`/nodes/${this.controlTarget}/pac-command`);
    } catch {
      this.controlLedger = [];
    }
  },
};
