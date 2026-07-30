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
import { persistSet } from './app-persist.js';

export const CONTROL_SHORTCUTS = ['ping', 'status', 'config', 'reboot'];

export const controlMixin = {
  // Sub-tab switch (Summary/Command/Config/Stats/Yagi Align/Chat — task
  // control-section-ia, 2026-07-25). State + persist only, same shape as
  // switchCfgTab (app-config.js). No per-tab data load: Command's data is
  // already WS-pushed regardless of which sub-tab is active, and the other
  // sub-tabs are skeleton placeholders with nothing to fetch yet.
  switchControlTab(name) {
    this.controlTab = name;
    persistSet('controlTab', name);
  },

  // pac-host's own alarm-device roster (GET /mesh/devices, task
  // control-devices-endpoint, 2026-07-25) — already scoped to ours, no local
  // filter needed (supersedes the earlier user.role===200 filter on the whole
  // mesh-gw roster). present:false means known but not currently in the
  // gateway roster (e.g. asleep) — rendered, never dropped, per mt-transport
  // (xsession [devices-live]): a device must not disappear because it slept.
  controlDevices() {
    return (this.pacHostStatus?.units || [])
      .map(u => ({ id: u.id, num: u.num, label: u.shortName || u.name || u.id, present: u.present !== false }));
  },

  controlShortcuts() { return CONTROL_SHORTCUTS; },

  // ── ALARM PLUGIN: Camera ───────────────────────────────────────────────────
  // Pure reads of server-pushed state (alarm_images, replayed on connect and
  // broadcast on change). Zero fetch, zero derivation — every count, percentage
  // and elapsed string was computed by src/alarm-images.js.

  /** The pushed model for the selected unit, or null. */
  cameraUnit() { return this.alarmImages?.[this.controlTarget] ?? null; },

  /** Server-supplied "SHORT !hexid". Both units currently report shortName
   *  GARG — one firmware image flashed to two boards, same root cause as the
   *  PKI failure — so the id is what tells them apart and it is shown. */
  cameraLabel(num) { return this.alarmImages?.[num]?.label ?? null; },

  /** Take a NEW photo. This REPLACES the image in the device's flash and puts a
   *  command on air, so it confirms first — services pulled a stale frame
   *  believing it was fresh, which is the mistake this wording prevents.
   *  Reuses the existing pac-command route; no new endpoint. The receipt is the
   *  Command tab's queue ledger, already pushed. */
  async cameraGrab() {
    if (this.controlTarget == null) { this.showToast('Select a unit first', 'error', 0); return; }
    const label = this.cameraLabel(this.controlTarget) || this.controlTarget;
    if (!confirm(`Take a new photo on ${label}?\n\nThis REPLACES the image stored on the device and transmits on the Private channel. It is delivered at the unit's next wake window.`)) return;
    this.cameraGrabbing = true;
    try {
      const result = await fetchJSON(`/nodes/${this.controlTarget}/pac-command`, 'POST', { verb: 'cam' });
      this.showToast(`Queued: ${result.id}`, 'success', 3000);
    } catch (e) {
      this.showToast(e.message || 'Could not queue the photo', 'error', 0);
    } finally {
      this.cameraGrabbing = false;
    }
  },

  async sendControl(verb) {
    const v = (verb ?? this.controlVerb ?? '').trim();
    if (!v) return;
    if (this.controlTarget == null) { this.showToast('Select a unit first', 'error', 0); return; }

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
  //
  // Filtered to kind==='command': mt-transport's ledger rewrite (commit
  // 975449e, xsession [request-ledger], task ledger-field-rename, 2026-07-25)
  // made the same ledger also hold text messages (kind:'text'). This page's
  // own Invariant says command traffic must never render alongside chat
  // (tab-control.md) — filtering here keeps that true rather than silently
  // breaking it. Showing text entries (e.g. on a future Chat sub-tab) is a
  // separate, not-yet-scoped task.
  controlLedger() {
    return [...(this.pacHostQueues?.[this.controlTarget] || [])]
      .filter(e => e.kind === 'command')
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  },

  // Split by pac-host's own `state` (renamed from `status` in the same
  // rewrite; verified live against the running service). queued/trying are
  // still in flight, not yet resolved; everything else (done/sent/failed/
  // expired/cancelled) has reached a terminal outcome, success or not, so it
  // belongs under Executed.
  controlPending() {
    return this.controlLedger().filter(e => e.state === 'queued' || e.state === 'trying');
  },

  controlExecuted() {
    return this.controlLedger().filter(e => e.state !== 'queued' && e.state !== 'trying');
  },

  // A result's fields have no local meaning (pac-host owns verb semantics —
  // see app-control.md Invariants), so this is generic key:value pairing,
  // STYLE_GUIDE §5 "key-value rows", NOT a translation of what a field means.
  // Raw ids are shown as-is rather than guessed at, until/unless pac-host
  // publishes a receipt-field schema (xsession item [receipt-schema]) — at
  // that point this becomes a label lookup, same shape, no template change.
  // Renamed from controlReceiptFields/receipt to match the shipped field
  // name (`result`, was `receipt`) — same generic pairing either way.
  controlResultFields(result) {
    if (!result || typeof result !== 'object') return [];
    return Object.entries(result)
      .filter(([k]) => k !== 'type')
      .map(([k, v]) => ({ label: k, text: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
  },
};
