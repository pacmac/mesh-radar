// Messaging mixin: send/receive/display messages.
import { fetchJSON } from './app-helpers.js';
import { persistSet } from './app-persist.js';

export const messagesMixin = {
  async loadMessages() {
    try {
      const rows = await fetchJSON('/messages?limit=50');
      if (Array.isArray(rows) && rows.length) {
        const ownNums = new Set(
          (this.availableDevices || [])
            .map(d => parseInt((d.node_id || '').replace('!', ''), 16))
            .filter(Boolean)
        );
        this.messages = rows.map(r => {
          if (r.short_name || r.long_name) {
            this.msgNodeCache[r.from_num] = { num: r.from_num, user: { short_name: r.short_name, long_name: r.long_name } };
          }
          return {
            pktId:         r.packet_id,
            replyId:       r.reply_id || null,
            fromNum:       r.from_num,
            fromShortName: r.short_name || null,
            fromLongName:  r.long_name  || null,
            hops:          r.hops ?? null,
            rssi:          r.rssi ?? null,
            snr:           r.snr  ?? null,
            to:            r.to_num >>> 0,
            broadcast:     (r.to_num >>> 0) === 0xFFFFFFFF || r.is_dm === 0,
            channel:       r.channel ?? 0,
            text:          r.text,
            ts:            r.ts,
            time:          new Date(r.ts * 1000).toLocaleTimeString(),
            direction:     ownNums.has(r.from_num) ? 'tx' : 'rx',
            ackStatus:     ownNums.has(r.from_num) ? 'confirmed' : null,
            src:           r.rx_devices ? r.rx_devices.split(',').filter(Boolean) : [],
          };
        });
        this.messages.forEach(m => { if (m.pktId) this._seenPacketIds.add(m.pktId); });
        try { localStorage.setItem('msgHistory', JSON.stringify(this.messages.slice(0, 20))); } catch (_) {}
      }
    } catch (e) {
      console.warn('loadMessages failed', e);
    }
    // Restore pending TX messages not yet confirmed (echoed).
    try {
      const _pt = JSON.parse(sessionStorage.getItem('pendingTx') || '[]');
      if (_pt.length) {
        const _rem = _pt.filter(p => {
          if (this.messages.some(m => m.fromNum === p.fromNum && m.text === p.text && Math.abs((m.ts||0) - (p.ts||0)) < 120)) return false;
          this.messages.unshift(p);
          return true;
        });
        sessionStorage.setItem('pendingTx', JSON.stringify(_rem));
      }
    } catch (_) {}
  },

  displayMessages() {
    const msgs = this.messages;
    const byPktId = new Map();
    for (const m of msgs) { if (m.pktId) byPktId.set(m.pktId, m); }

    const getRoot = (m, visited = new Set()) => {
      if (!m.replyId || !byPktId.has(m.replyId) || visited.has(m.pktId)) return m;
      visited.add(m.pktId);
      return getRoot(byPktId.get(m.replyId), visited);
    };

    const childrenOf = new Map();
    const knownChildren = new Set();
    for (const m of msgs) {
      if (!m.replyId) continue;
      const root = getRoot(m);
      if (root === m) continue;
      if (!childrenOf.has(root.pktId)) childrenOf.set(root.pktId, []);
      childrenOf.get(root.pktId).push(m);
      knownChildren.add(m);
    }

    const roots = msgs.filter(m => !knownChildren.has(m));
    roots.sort((a, b) => {
      const latestA = Math.max(a.ts, ...(childrenOf.get(a.pktId) || []).map(r => r.ts));
      const latestB = Math.max(b.ts, ...(childrenOf.get(b.pktId) || []).map(r => r.ts));
      return latestB - latestA;
    });

    const result = [];
    for (const root of roots) {
      const rootIsOrphan = !!(root.replyId && !byPktId.has(root.replyId));
      result.push({ ...root, isReply: rootIsOrphan, replyDepth: 0 });
      const replies = (childrenOf.get(root.pktId) || []).slice().sort((a, b) => a.ts - b.ts);
      for (const r of replies) result.push({ ...r, isReply: true, replyDepth: 1 });
    }
    return result;
  },

  async sendMessage() {
    if (!this.msgText.trim()) return;
    this.msgSent = false;
    const text = this.msgText, channel = Number(this.msgChannel), time = new Date().toLocaleTimeString();
    const fromId = this.msgFrom || this.activeNodeId;
    const to = this.msgIsDirect && this.msgDirectTo ? Number(this.msgDirectTo) : 0xFFFFFFFF;
    const fromNum = parseInt((fromId || '').replace('!', ''), 16) || 0;
    const body = { text, channel };
    if (this.msgIsDirect && this.msgDirectTo) body.to = to;
    if (this.msgReplyId) body.reply_id = this.msgReplyId;

    const txKey = Date.now();
    const txNode = this.nodes.find(n => n.num === fromNum);
    const txEntry = {
      _txKey: txKey,
      fromNum, to: to >>> 0,
      fromShortName: txNode?.user?.short_name || this.availableDevices.find(d => d.node_id === fromId)?.short_name || null,
      fromLongName:  txNode?.user?.long_name  || this.availableDevices.find(d => d.node_id === fromId)?.long_name  || null,
      broadcast: to === 0xFFFFFFFF, channel, text,
      ts: Math.floor(Date.now() / 1000), time, direction: 'tx', ackStatus: 'sending',
      src: fromId ? [fromId] : [], replyId: this.msgReplyId || null,
      _localTx: true,
    };
    this.messages.unshift(txEntry);
    if (this.messages.length > 50) this.messages.pop();
    try {
      const _pt = JSON.parse(sessionStorage.getItem('pendingTx') || '[]');
      _pt.unshift({...txEntry});
      sessionStorage.setItem('pendingTx', JSON.stringify(_pt.slice(0, 20)));
    } catch (_) {}

    this.msgInputHistory = [text, ...this.msgInputHistory.filter(t => t !== text)].slice(0, 50);
    persistSet('msgInputHistory', this.msgInputHistory);
    this.msgHistoryIdx = -1;
    this.msgDraft = '';
    this.msgText = '';
    this.msgReplyId = null;
    this.msgReplyFrom = null;
    if (this.msgIsModal) this.closeMessageModal();

    let _lastErr = null;
    for (let _attempt = 1; _attempt <= 3; _attempt++) {
      try {
        const res = await fetchJSON('/' + fromId + '/messages', 'POST', body);
        if (res?.error) throw new Error(res.error?.message || String(res.error));
        if (res?.detail) throw new Error(res.detail);
        const m = this.messages.find(x => x._txKey === txKey);
        if (m && (m.ackStatus === 'sending' || m.ackStatus === 'retrying')) m.ackStatus = 'sent';
        try {
          const _pt = JSON.parse(sessionStorage.getItem('pendingTx') || '[]');
          const _p = _pt.find(x => x._txKey === txKey);
          if (_p) _p.ackStatus = 'sent';
          sessionStorage.setItem('pendingTx', JSON.stringify(_pt));
        } catch (_) {}
        this.msgSent = true;
        setTimeout(() => (this.msgSent = false), 2000);
        _lastErr = null;
        break;
      } catch (e) {
        _lastErr = e;
        if (_attempt < 3) {
          const m = this.messages.find(x => x._txKey === txKey);
          if (m) { m.ackStatus = 'retrying'; m._retryCount = _attempt; }
          await new Promise(r => setTimeout(r, 1000 * _attempt));
        }
      }
    }
    if (_lastErr) {
      const m = this.messages.find(x => x._txKey === txKey);
      if (m) { m.ackStatus = 'failed'; m._sendError = _lastErr.message; }
      try {
        const _pt = JSON.parse(sessionStorage.getItem('pendingTx') || '[]');
        const _p = _pt.find(x => x._txKey === txKey);
        if (_p) { _p.ackStatus = 'failed'; _p._sendError = _lastErr.message; }
        sessionStorage.setItem('pendingTx', JSON.stringify(_pt));
      } catch (_) {}
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
    const sn = node.user?.short_name || ('!' + node.num.toString(16).slice(-4));
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
