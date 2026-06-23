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
