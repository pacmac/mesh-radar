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
  // control-section-ia, 2026-07-25). State + persist, same shape as
  // switchCfgTab (app-config.js).
  //
  // This used to say "No per-tab data load ... the other sub-tabs are skeleton
  // placeholders with nothing to fetch yet." That stopped being true when Stats
  // gained the coulomb pane (2026-08-08), so it is corrected here rather than
  // left to mislead the next reader. Command still needs no load — its data is
  // WS-pushed regardless of which sub-tab is showing. Stats is on-demand
  // because a per-unit history nobody is looking at should not be built.
  switchControlTab(name) {
    this.controlTab = name;
    persistSet('controlTab', name);
    if (name === 'stats') this.requestCoulomb();
  },

  // ── ALARM PLUGIN: coulomb counter (task coulomb-series-stats-tab) ─────────
  // WS RPC, never a GET — see the file header. The reply lands in the plugin's
  // own `coulomb` wsHandler.

  /** pac-host's `!hex` id for the selected unit. The RPC needs this, not the
   *  num: short names and nums do not resolve upstream (measured 2026-08-08,
   *  raised with services #90). */
  coulombUnitId() {
    return this.controlDevices().find(d => d.num === this.controlTarget)?.id ?? null;
  },

  requestCoulomb() {
    const unit = this.coulombUnitId();
    if (!unit) return;
    this.coulombLoading = true;
    this.coulombModel = null;
    this.wsSend({ type: 'coulomb', unit, span_hours: this.coulombSpanHours });
  },

  /** Raw user input forwarded to the backend, which re-derives the rate over
   *  the new span. The browser does NOT re-slice the series it already holds —
   *  that would be deriving a measurement. Same rule as setNodeWindow. */
  setCoulombSpan(hours) {
    if (this.coulombLoading || hours === this.coulombSpanHours) return;
    this.coulombSpanHours = hours;
    this.requestCoulomb();
  },

  /** The series as ONE path `d`, broken at every counter reset.
   *
   *  A `grst` means the count restarted, so joining across it would draw one
   *  continuous slope through two unrelated origins — the same lie the server
   *  already refuses to put a number to. The gap IS the information, and in a
   *  path a `M` (moveto) is exactly that gap.
   *
   *  ONE PATH, NOT AN x-for OF POLYLINES. The first version did the latter and
   *  it threw on every render: an Alpine `<template x-for>` nested inside an
   *  `<svg>` has empty `.content` after HTML parsing, so Alpine dereferenced
   *  undefined ("Cannot read properties of undefined (reading 'children')").
   *  Caught from the browser console, not the screenshot — the pane looked
   *  fine, it simply had no line in it.
   *
   *  Geometry only. BROWSER_CONTRACT permits "render and format data it
   *  receives ... layout"; precedent is snapSparkPoints in app-snapshot.js. */
  coulombPath() {
    const pts = this.coulombModel?.series ?? [];
    if (pts.length < 2) return '';
    const breaks = this.coulombModel?.breaks ?? [];
    const xs = pts.map(p => p.at), ys = pts.map(p => p.n);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const W = 560, H = 100;
    const sx = t => x1 === x0 ? 0 : ((t - x0) / (x1 - x0)) * W;
    // Inverted: SVG y grows downward. A flat series pins to the middle rather
    // than dividing by zero.
    const sy = v => y1 === y0 ? H / 2 : H - ((v - y0) / (y1 - y0)) * H;

    let d = '', penDown = false;
    for (let i = 0; i < pts.length; i++) {
      const broke = i > 0 && breaks.some(b => b > pts[i - 1].at && b <= pts[i].at);
      const cmd = (!penDown || broke) ? 'M' : 'L';
      d += `${d ? ' ' : ''}${cmd}${sx(pts[i].at).toFixed(1)},${sy(pts[i].n).toFixed(1)}`;
      penDown = true;
    }
    return d;
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

  // ── Section gaps ───────────────────────────────────────────────────────────
  // The backend serves a `sections` map naming, for every panel, whether
  // anything can fill it and WHO OWNS the hole. This is a pure read of that
  // map — the browser decides nothing, it renders the server's own sentence
  // (BROWSER_CONTRACT).
  //
  // It exists because a control that cannot work must not look like one that
  // can. Camera offered "Take photo" and Yagi Align offered PING/END while
  // neither had a route behind it: pressing them produced a 501 with a reason
  // buried in a console, and the page looked functional. A named hole beats a
  // dead button.
  //
  // Returns the section object when it is a GAP, or null when it is fine —
  // so `x-show="sectionGap('images')"` reads as "show this when it is broken".
  sectionGap(name) {
    const s = this.pacHostStatus?.sections?.[name];
    if (!s || s.ok === true) return null;
    return s;
  },

  // The server's stated reason and owner, as one line, for rendering under a
  // disabled control. Never assembled from anything this side knows.
  sectionGapText(name) {
    const s = this.sectionGap(name);
    if (!s) return null;
    return `${s.why || 'no source'} — ${s.owner || 'owner unstated'}`;
  },

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
    // Every stored row is reachable now (addressed by the store's stable id),
    // so there is no "unreachable" case left to skip over.
    return imgs.find(i => i.key === this.cameraSelectedKey) ?? imgs[0] ?? null;
  },

  /** Local UI selection — an interaction, not page data, so it lives here and
   *  is never persisted or sent anywhere. */
  cameraSelect(key) { this.cameraSelectedKey = key; },

  /** THE ONLY download path. Pull an image from the device over the air.
   *
   *  Replaces cameraRefetch() + cameraFetchDevice() (task camera-page-ux,
   *  2026-08-01). Both POSTed this same endpoint and existed separately only
   *  because they were written on different days against two readings of the
   *  same API — one for "the device holds a pid we do not", one for "re-pull a
   *  stored image". That is ONE intent, and it rendered as two differently
   *  labelled buttons in two different cards. Peter: "just a case of dropping
   *  fields and cards wherever is the fastest and easiest".
   *
   *  Peter, 2026-07-31: "pull an existing image whether or not it has been sent
   *  before". An earlier version refused anything already stored with a 409;
   *  that guard is gone. What remains is the DEVICE's limit, not ours — it holds
   *  one payload at a time, so only that pid can be re-pulled and the button is
   *  offered only for it.
   *
   *  Returns as soon as the transfer STARTS (202) — a full pull is minutes
   *  (services measured 183-239 s), so the page must not wait on it. Progress
   *  arrives through the existing /progress polling, never from this response. */
  async cameraDownload(pid) {
    if (this.controlTarget == null || pid == null) return;
    if (!confirm(`Download image ${pid} from the device?\n\nIt transfers over the radio, can take several minutes, and costs the unit a wake window. Watch Status for progress.`)) return;
    this.cameraFetching = true;
    try {
      await fetchJSON(`/alarm/image/${this.controlTarget}/${pid}/fetch`, 'POST');
      this.showToast(`Downloading image ${pid} — watch Status`, 'success', 5000);
    } catch (e) {
      this.showToast(e.message || 'Could not start the download', 'error', 0);
    } finally {
      this.cameraFetching = false;
    }
  },

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
