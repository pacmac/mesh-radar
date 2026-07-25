// Control page mixin: pac-host unit picker + command shortcuts + free text.
// Presentation only — POSTs to /nodes/:num/pac-command (the one sanctioned
// browser write, an action not page data), decides nothing about what a verb
// means (BROWSER_CONTRACT). Units AND queue/receipt history both come over
// WS — pacHostStatus.units and pacHostQueues (server-pushed, replayed on
// connect, updated on change — task control-queue-push-not-get). There is no
// GET anywhere in this file, and must never be: a GET-on-click version of the
// queue existed briefly and was a real bug (Peter, 2026-07-25) — it went
// stale the moment the queue changed without another click, which is not
// "real time" regardless of how interactive the trigger looked.
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
      // No manual refresh — src/pac-host.js polls pac-host every 5s and
      // pushes pac_host_queues on change; the new entry appears on its own.
    } catch (e) {
      this.showToast(e.message || 'Command failed', 'error', 0);
    } finally {
      this.controlSending = false;
    }
  },

  // Pure read of server-pushed state — zero fetch. pacHostQueues is keyed by
  // node num, populated from pac_host_queues (replayed on connect, updated on
  // change), so this is live from the moment the WS connects, before any unit
  // is even selected. pac-host's own ledger array is oldest-first (verified
  // live against the running service); sorted newest-first here for display —
  // a pure presentation-order choice over already-pushed data, not a fetch.
  controlLedger() {
    return [...(this.pacHostQueues?.[this.controlTarget] || [])]
      .sort((a, b) => (b.enqueuedAt ?? 0) - (a.enqueuedAt ?? 0));
  },

  // Split by pac-host's own `status` (verified live against the running
  // service: observed values are pending, acked, cancelled, failed — pending
  // is the only non-terminal one). "pending" = still in flight, not yet
  // delivered/resolved; everything else has reached a terminal outcome,
  // success or not, so it belongs under Executed.
  controlPending() {
    return this.controlLedger().filter(e => e.status === 'pending');
  },

  controlExecuted() {
    return this.controlLedger().filter(e => e.status !== 'pending');
  },

  // A receipt's fields have no local meaning (pac-host owns verb semantics —
  // see app-control.md Invariants), so this is generic key:value pairing,
  // STYLE_GUIDE §5 "key-value rows", NOT a translation of what a field means.
  // Raw ids are shown as-is rather than guessed at, until/unless pac-host
  // publishes a receipt-field schema (xsession item [receipt-schema]) — at
  // that point this becomes a label lookup, same shape, no template change.
  controlReceiptFields(receipt) {
    if (!receipt || typeof receipt !== 'object') return [];
    return Object.entries(receipt)
      .filter(([k]) => k !== 'type')
      .map(([k, v]) => ({ label: k, text: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
  },
};
