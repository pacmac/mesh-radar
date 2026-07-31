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
import { fetchJSON } from '/app-helpers.js';
import { persistSet } from '/app-persist.js';

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

  /** Stored images for the selected unit, newest first. Pure read — every
   *  string, and the url itself, was built by src/alarm-images.js. */
  cameraImages() { return this.cameraUnit()?.images ?? []; },

  /** Past attempts we OBSERVED. pac-host keeps no record once a transfer ends,
   *  so without this a week of failures renders identically to a week of
   *  nothing — which is exactly what Peter reported (2026-07-31). */
  cameraHistory() { return this.cameraUnit()?.history ?? []; },

  /** The image being shown large. Defaults to the newest ADDRESSABLE one:
   *  a pid recycles, and GET /images/<t>/<pid> only ever returns the newest
   *  row for that pid, so a non-addressable row cannot be fetched alone. */
  cameraSelected() {
    const imgs = this.cameraImages();
    if (!imgs.length) return null;
    return imgs.find(i => i.key === this.cameraSelectedKey && i.addressable)
        ?? imgs.find(i => i.addressable)
        ?? null;
  },

  /** Local UI selection — an interaction, not page data, so it lives here and
   *  is never persisted or sent anywhere. */
  cameraSelect(key) { this.cameraSelectedKey = key; },

  /** What the device says it is holding, from the last check. Null until asked. */
  cameraDevice() { return this.cameraUnit()?.device ?? null; },

  /** Ask the device what image it currently holds.
   *
   *  DELIBERATELY A BUTTON, NOT A POLL. This is a radio round-trip (~4.3 s
   *  measured) and services were explicit: airtime on that link is the scarcest
   *  thing in the project and a background poller would compete with real
   *  commands for the same wake windows. One call when somebody actually asks. */
  async cameraCheckDevice() {
    if (this.controlTarget == null) { this.showToast('Select a unit first', 'error', 0); return; }
    this.cameraChecking = true;
    try {
      const r = await fetchJSON(`/alarm/image/${this.controlTarget}/check`, 'POST');
      this.showToast(r.pid != null ? `Device is holding image ${r.pid}` : 'Device reported no image', 'success', 4000);
    } catch (e) {
      this.showToast(e.message || 'The device did not answer', 'error', 0);
    } finally {
      this.cameraChecking = false;
    }
  },

  /** Pull an image the device holds and we do not.
   *
   *  Returns as soon as the transfer STARTS — a full pull is minutes, so the
   *  page must not wait on it. Progress appears in the Transfer card through the
   *  same path as every other transfer. */
  async cameraFetchDevice() {
    const d = this.cameraDevice();
    if (!d?.fetchable) return;
    if (!confirm(`Download image ${d.pid} from the device?\n\nThis transfers over the radio and can take several minutes. Watch the Transfer card for progress.`)) return;
    this.cameraFetching = true;
    try {
      await fetchJSON(`/alarm/image/${this.controlTarget}/${d.pid}/fetch`, 'POST');
      this.showToast(`Downloading image ${d.pid} — watch Transfer`, 'success', 5000);
    } catch (e) {
      this.showToast(e.message || 'Could not start the download', 'error', 0);
    } finally {
      this.cameraFetching = false;
    }
  },

  /** Take a NEW photo and upload it.
   *
   *  THE VERB IS `cam grab`, AND BARE `cam` IS NOT A CAPTURE. We shipped bare
   *  `cam` and every press was a no-op: firmware `main.cpp:2097` falls through
   *  to `{"type":"err","msg":"cam snap|grab|info|read|diag"}` — an error
   *  listing the sub-verbs. Peter caught it, 2026-07-31. It had been carried
   *  over from the archived push.html era and never once sent and observed.
   *
   *  `grab` over `snap`: snap publishes by REFERENCE and the camera stays awake
   *  while the RAK reads a 224-byte window per chunk over I2C. grab captures,
   *  bulk-reads to RAM, verifies that copy against the camera's own CRC, then
   *  SLEEPS the camera and uploads from RAM. For a battery unit facing a
   *  multi-minute upload that is the whole point, and a bad read fails before
   *  anything goes on air.
   *
   *  Sent bare, with no pid override: the device derives the pid from image
   *  content, which is what makes a resumed transfer idempotent.
   *
   *  Reuses the existing pac-command route; no new endpoint. The receipt is the
   *  Command tab's queue ledger, already pushed. */
  async cameraGrab() {
    if (this.controlTarget == null) { this.showToast('Select a unit first', 'error', 0); return; }
    const label = this.cameraLabel(this.controlTarget) || this.controlTarget;
    if (!confirm(`Take a new photo on ${label}?\n\nThis CAPTURES a new image and stages it on the device, replacing the one held there. It transmits a command on the Private channel.\n\nIt does NOT upload the picture — capture and transfer are separate operations on this firmware, and the upload is not yet wired.`)) return;
    this.cameraGrabbing = true;
    try {
      const result = await fetchJSON(`/nodes/${this.controlTarget}/pac-command`, 'POST', { verb: 'cam grab' });
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
