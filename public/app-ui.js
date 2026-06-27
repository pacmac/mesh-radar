// UI helpers mixin: toasts, async op state, formatting functions.

export const uiMixin = {
  showToast(message, type = 'success', duration) {
    const id = Date.now() + Math.random();
    const ms = duration !== undefined ? duration : (type === 'error' ? 0 : 4000);
    this.toasts = [...this.toasts, { id, message, type }];
    if (ms > 0) setTimeout(() => this.dismissToast(id), ms);
  },

  dismissToast(id) {
    this.toasts = this.toasts.filter(t => t.id !== id);
  },

  // Tracks loading/ok/err state per key; auto-dismisses ok after 2.5s.
  // fn returning false = user cancelled — silently resets (no toast).
  async asyncOp(key, fn, opts = {}) {
    if (this.ops[key]?.loading) return;
    this.ops = { ...this.ops, [key]: { loading: true, ok: false, err: null } };
    try {
      const result = await fn();
      if (result === false) { this.ops = { ...this.ops, [key]: { loading: false, ok: false, err: null } }; return; }
      this.ops = { ...this.ops, [key]: { loading: false, ok: true, err: null } };
      if (opts.successMsg) this.showToast(opts.successMsg, 'success');
      setTimeout(() => { if (this.ops[key]?.ok) this.ops = { ...this.ops, [key]: { loading: false, ok: false, err: null } }; }, 2500);
    } catch (e) {
      const msg = opts.errorMsg || e.message || String(e);
      this.ops = { ...this.ops, [key]: { loading: false, ok: false, err: msg } };
      this.showToast(msg, 'error');
    }
  },

  opLoading(key) { return !!this.ops[key]?.loading; },
  opOk(key)      { return !!this.ops[key]?.ok; },
  opErr(key)     { return this.ops[key]?.err || null; },
  opPct(key)     { return this.ops[key]?.pct ?? null; },

  // Key of any currently-active otaFlash_ op (loading, done, or errored) — used by OTA overlay.
  get activeFlashKey() {
    return Object.keys(this.ops).find(
      k => k.startsWith('otaFlash_') && (this.ops[k]?.loading || this.ops[k]?.ok || this.ops[k]?.err)
    ) || null;
  },

  // For WS-tracked streaming operations: HTTP just triggers; WS drives state to done.
  asyncOpStart(key) {
    this.ops = { ...this.ops, [key]: { loading: true, ok: false, err: null, pct: null } };
  },
  asyncOpProgress(key, pct) {
    if (!this.ops[key]?.loading) return;
    this.ops = { ...this.ops, [key]: { ...this.ops[key], pct } };
  },
  asyncOpEnd(key, ok = true, err = null) {
    this.ops = { ...this.ops, [key]: { loading: false, ok, err, pct: ok ? 100 : this.ops[key]?.pct } };
    if (ok) setTimeout(() => { if (this.ops[key]?.ok) this.ops = { ...this.ops, [key]: null }; }, 2500);
  },

  fmtUptime(secs) {
    if (secs == null) return '–';
    const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  },

  fmtBytes(b) {
    if (b == null) return '–';
    if (b > 1024) return (b / 1024).toFixed(1) + ' KB';
    return b + ' B';
  },

  fmtAge(ts) {
    if (!ts) return '–';
    const secs = Math.floor(Date.now() / 1000) - ts;
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    return Math.floor(secs / 86400) + 'd ago';
  },
};
