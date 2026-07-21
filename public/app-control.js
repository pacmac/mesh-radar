// Control page mixin: device select + command shortcuts + command-only feed.
// Presentation only — posts to the backend command route, classifies nothing,
// decides no channel (the backend resolves Private by name). See app-control.md.
import { fetchJSON } from './app-helpers.js';

// v1 shortcut verbs — Peter to redraw from the screenshot.
export const CONTROL_SHORTCUTS = ['ping', 'status', 'config', 'reboot'];

export const controlMixin = {
  // Command targets: favourites (server nav list) first, then our PAC_ALARM nodes,
  // deduped. Control only ever addresses our alarm units — client_role is
  // server-stamped (src/client-role.js), same filter push-viewer.html uses.
  controlDevices() {
    const favs = (this.favourites || []).map(f => ({ num: f.num, label: f.label }));
    const seen = new Set(favs.map(f => f.num));
    const rest = (this.allMsgNodes() || [])
      .filter(n => n.client_role === 'PAC_ALARM' && !seen.has(n.num))
      .map(n => ({ num: n.num, label: n.user?.short_name || n.user?.long_name || ('!' + (n.num >>> 0).toString(16)) }));
    return [...favs, ...rest];
  },

  controlShortcuts() { return CONTROL_SHORTCUTS; },

  controlTargetLabel() {
    if (this.controlTarget == null) return '';
    const d = this.controlDevices().find(d => d.num === this.controlTarget);
    return d?.label || ('!' + (this.controlTarget >>> 0).toString(16));
  },

  // The control feed, exactly as the server pushed it (command_history): command
  // + response rows, server-classified. The browser filters NOTHING — it renders
  // the feed it was given (BROWSER_CONTRACT).
  controlFeed() {
    return this.commandMessages;
  },

  async sendControl(command) {
    const cmd = (command ?? this.controlCommand ?? '').trim();
    if (!cmd) return;
    if (this.controlTarget == null) { this.showToast('Select a device first', 'error', 0); return; }
    this.controlSending = true;
    try {
      const res = await fetchJSON('/nodes/' + this.controlTarget + '/command', 'POST', { command: cmd });
      if (res?.error) throw new Error(res.error?.message || String(res.error));
      this.controlCommand = '';
      // No optimistic row — the command and its response arrive over the WS feed,
      // same route as any message. One writer, one identity.
    } catch (e) {
      this.showToast(e.message || 'Command failed — check gateway connection', 'error', 0);
    } finally {
      this.controlSending = false;
    }
  },
};
