// Messaging mixin: send/receive/display messages.
import { fetchJSON } from './app-helpers.js';
import { persistSet } from './app-persist.js';

export const messagesMixin = {
  // Called by WS message_history event — no HTTP fetch.
  _applyMessageRows(rows) {
    if (!Array.isArray(rows)) return;
    if (!rows.length) { this.messages = []; return; }
    this.messages = rows.map(r => {
      if (r.from_num) {
        this.msgNodeCache[r.from_num] = { num: r.from_num, display_name: r.display_name || null, user: { short_name: r.short_name, long_name: r.long_name } };
      }
      return {
        pktId:              r.packet_id,
        replyId:            r.reply_id || null,
        threadRootPktId:    r.thread_root_packet_id ?? r.packet_id,
        isOrphan:           !!r.is_orphan,
        replyDepth:         r.reply_depth ?? 0,
        fromNum:            r.from_num,
        fromShortName:      r.display_name || r.short_name || null,
        fromLongName:       r.long_name  || null,
        hops:               r.hops ?? null,
        rssi:               r.rssi ?? null,
        snr:                r.snr  ?? null,
        to:                 r.to_num >>> 0,
        broadcast:          (r.to_num >>> 0) === 0xFFFFFFFF || r.is_dm === 0,
        channel:            r.channel ?? 0,
        text:               r.text,
        ts:                 r.ts,
        time:               new Date(r.ts * 1000).toLocaleTimeString(),
        direction:          r.direction || 'rx',
        ackStatus:          r.status || null,
        src:                r.rx_devices ? r.rx_devices.split(',').filter(Boolean) : [],
      };
    });
    try { localStorage.setItem('msgHistory', JSON.stringify(this.messages.slice(0, 20))); } catch (_) {}
  },

  loadMessages() { /* no-op — history arrives via WS message_history on connect */ },

  displayMessages() {
    // Thread structure is pre-computed by node-dash: threadRootPktId, replyDepth, isOrphan.
    // Sort threads by latest-ts descending, then within a thread by ts ascending.
    const msgs = this.messages;
    const threadLatest = new Map();
    for (const m of msgs) {
      const root = m.threadRootPktId ?? m.pktId;
      if (root != null && (m.ts || 0) > (threadLatest.get(root) || 0)) {
        threadLatest.set(root, m.ts);
      }
    }
    return [...msgs].sort((a, b) => {
      const rootA = a.threadRootPktId ?? a.pktId;
      const rootB = b.threadRootPktId ?? b.pktId;
      const latestDiff = (threadLatest.get(rootB) || 0) - (threadLatest.get(rootA) || 0);
      if (latestDiff !== 0) return latestDiff;
      return (a.ts || 0) - (b.ts || 0);
    }).map(m => ({ ...m, isReply: m.replyDepth > 0 || m.isOrphan }));
  },

  async sendMessage() {
    if (!this.msgText.trim()) return;
    // Hard guard: if user intended a DM but recipient is missing, refuse to send rather than
    // silently fall back to broadcast. This catches modal x-model initialization race conditions.
    if (this.msgIsDirect && !this.msgDirectTo) {
      this.showToast('No recipient — select a node before sending a direct message', 'error', 0);
      return;
    }
    this.msgSent = false;
    const text = this.msgText, channel = Number(this.msgChannel), time = new Date().toLocaleTimeString();
    const fromId = this.msgFrom;
    if (!fromId) {
      this.showToast('No sender selected — choose a gateway device before sending', 'error', 0);
      return;
    }
    const to = this.msgIsDirect ? Number(this.msgDirectTo) : 0xFFFFFFFF;
    const fromNum = parseInt((fromId || '').replace('!', ''), 16) || 0;
    const pktIdHint = (Math.random() * 0xFFFFFFFF | 0) >>> 0 || 1;
    const body = { text, channel, pkt_id: pktIdHint };
    if (this.msgIsDirect) body.to = to;
    if (this.msgReplyId) body.reply_id = this.msgReplyId;

    const txKey = Date.now();
    const txEntry = {
      _txKey: txKey,
      fromNum, to: to >>> 0,
      fromShortName: this.deviceLabel(fromId) || null,
      fromLongName:  this.availableDevices.find(d => d.node_id === fromId)?.long_name || null,
      broadcast: to === 0xFFFFFFFF, channel, text,
      ts: Math.floor(Date.now() / 1000), time, direction: 'tx', ackStatus: 'sending',
      src: fromId ? [fromId] : [], replyId: this.msgReplyId || null,
      threadRootPktId: pktIdHint, replyDepth: 0, isOrphan: false,
      _localTx: true,
    };
    this.messages.unshift(txEntry);
    if (this.messages.length > 50) this.messages.pop();

    this.msgInputHistory = [text, ...this.msgInputHistory.filter(t => t !== text)].slice(0, 50);
    persistSet('msgInputHistory', this.msgInputHistory);
    this.msgHistoryIdx = -1;
    this.msgDraft = '';
    this.msgText = '';
    this.msgReplyId = null;
    this.msgReplyFrom = null;
    if (this.msgIsModal) this.closeMessageModal();

    try {
      const res = await fetchJSON('/' + fromId + '/messages', 'POST', body);
      if (res?.error) throw new Error(res.error?.message || String(res.error));
      if (res?.detail) throw new Error(res.detail);
      const m = this.messages.find(x => x._txKey === txKey);
      if (m) {
        m.ackStatus = 'queued';
        if (res?.id && !m.pktId) m.pktId = res.id;
      }
      this.msgSent = true;
      setTimeout(() => (this.msgSent = false), 2000);
    } catch (e) {
      const m = this.messages.find(x => x._txKey === txKey);
      if (m) { m.ackStatus = 'failed'; m._sendError = e.message; }
    }
  },

  openMessageModal(mode, node) {
    this.msgIsDirect = mode === 'direct';
    this.msgDirectTo = mode === 'direct' ? (node?.num ?? '') : '';
    this.msgInsertNode = node?.num ?? null;
    this.msgText = '';
    this.msgSent = false;
    this.msgIsModal = true;
    this.$nextTick(() => this.$refs.msgModalDialog?.showModal());
  },

  closeMessageModal() {
    this.msgIsModal = false;
    this.$refs.msgModalDialog?.close();
  },

  insertAtCursor(el, text) {
    if (!el) { this.msgText += text; return; }
    const start = el.selectionStart ?? this.msgText.length;
    const end   = el.selectionEnd   ?? start;
    this.msgText = this.msgText.slice(0, start) + text + this.msgText.slice(end);
    this.$nextTick(() => { el.focus(); el.setSelectionRange(start + text.length, start + text.length); });
  },

  replyTo(m) {
    const target = m.direction === 'tx' ? m.to : m.fromNum;
    this.msgInsertNode = target;
    if (target && (target >>> 0) !== 0xFFFFFFFF) {
      const inList = this.allMsgNodes().some(n => n.num === target);
      this.msgDirectTo = inList ? target : '';
      this.msgIsDirect = inList && !m.broadcast;
    }
    this.msgReplyId = m.pktId || null;
    this.msgReplyFrom = m.fromNum || null;
  },

  insertText(val) {
    if (!val) return;
    const ta = this._composeTa;
    if (!ta) { this.msgText += val; return; }
    const s = ta.selectionStart, e = ta.selectionEnd;
    this.msgText = this.msgText.slice(0, s) + val + this.msgText.slice(e);
    this.$nextTick(() => { ta.selectionStart = ta.selectionEnd = s + val.length; ta.focus(); });
  },

  insertNodeMeta() {
    if (!this.msgInsertNode) return null;
    const node = this.nodes.find(n => n.num === this.msgInsertNode);
    const dist = node?._km != null ? node._km.toFixed(1) : null;
    const az   = node?._az != null ? Math.round(node._az) : null;
    return { shortName: this.nodeShortName(this.msgInsertNode), longName: this.nodeLongName(this.msgInsertNode), dist, az };
  },

  navigateMsgHistory(e, dir) {
    const h = this.msgInputHistory;
    if (!h.length) return;
    const ta = e.target;
    if (dir < 0 && ta.selectionStart > 0) return;
    if (dir > 0 && ta.selectionEnd < ta.value.length) return;
    e.preventDefault();
    if (dir < 0) {
      if (this.msgHistoryIdx === -1) this.msgDraft = this.msgText;
      this.msgHistoryIdx = Math.min(this.msgHistoryIdx + 1, h.length - 1);
    } else {
      if (this.msgHistoryIdx < 0) return;
      this.msgHistoryIdx--;
      if (this.msgHistoryIdx < 0) { this.msgText = this.msgDraft; return; }
    }
    this.msgText = h[this.msgHistoryIdx];
  },

  mentionedNodes() {
    const q = this.mentionQuery.toLowerCase();
    return this.nodes
      .filter(n => n.user?.short_name && (
        n.user.short_name.toLowerCase().startsWith(q) ||
        (n.user.long_name || '').toLowerCase().startsWith(q)
      ))
      .slice(0, 8);
  },

  handleMsgInput(e) {
    this._composeTa = e.target;
    const ta = e.target;
    const before = ta.value.slice(0, ta.selectionStart);
    const m = before.match(/@(\w*)$/);
    if (m) {
      this.mentionQuery = m[1];
      this.mentionPos = before.lastIndexOf('@');
      this.mentionIdx = 0;
      this.mentionOpen = this.mentionedNodes().length > 0;
    } else {
      this.mentionOpen = false;
    }
  },

  handleMsgKeydown(e) {
    this._composeTa = e.target;
    if (this.mentionOpen) {
      const items = this.mentionedNodes();
      if (e.key === 'ArrowDown') { e.preventDefault(); this.mentionIdx = Math.min(this.mentionIdx + 1, items.length - 1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); this.mentionIdx = Math.max(this.mentionIdx - 1, 0); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); if (items[this.mentionIdx]) this.selectMention(items[this.mentionIdx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.mentionOpen = false; return; }
      return;
    }
    if (e.key === 'ArrowUp')   this.navigateMsgHistory(e, -1);
    if (e.key === 'ArrowDown') this.navigateMsgHistory(e, 1);
  },

  selectMention(node) {
    const sn = this.nodeShortName(node.num);
    const ta = this._composeTa;
    const cursorAfterAt = this.mentionPos + 1 + this.mentionQuery.length;
    this.msgText = this.msgText.slice(0, this.mentionPos) + '@' + sn + ' ' + this.msgText.slice(cursorAfterAt);
    this.mentionOpen = false;
    this.$nextTick(() => { if (ta) { ta.selectionStart = ta.selectionEnd = this.mentionPos + sn.length + 2; ta.focus(); } });
  },

  playMsgSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.25, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      o.start(ctx.currentTime); o.stop(ctx.currentTime + 0.35);
    } catch (_) {}
  },
};
