// Messaging mixin: send/receive/display messages.
import { fetchJSON } from './app-helpers.js';
import { persistSet } from './app-persist.js';

export const messagesMixin = {
  // Called by the WS message_history event — no HTTP fetch.
  _mapMessageRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map(r => {
      if (r.from_num) {
        this.msgNodeCache[r.from_num] = { num: r.from_num, display_name: r.display_name || null, user: { short_name: r.short_name, long_name: r.long_name } };
      }
      return {
        // Server-assigned stable identity — the x-for key. The browser never
        // invents an identity (MESSAGE_PIPELINE_REWRITE_SPEC).
        key:                r.message_key,
        pktId:              r.packet_id,
        replyId:            r.reply_id || null,
        threadRootPktId:    r.thread_root_packet_id ?? r.packet_id,
        isOrphan:           !!r.is_orphan,
        replyDepth:         r.reply_depth ?? 0,
        isReply:            (r.reply_depth ?? 0) > 0 || !!r.is_orphan,
        fromNum:            r.from_num,
        fromShortName:      r.display_name || r.short_name || null,
        fromLongName:       r.long_name  || null,
        hops:               r.hops ?? null,
        rssi:               r.rssi ?? null,
        snr:                r.snr  ?? null,
        to:                 r.to_num >>> 0,
        broadcast:          (r.to_num >>> 0) === 0xFFFFFFFF || r.is_dm === 0,
        channel:            r.channel ?? 0,
        // Primary channel is ordinary chat; non-primary broadcast channels
        // are private channel traffic. Direct messages are classified separately.
        privateChannel:     (r.channel ?? 0) !== 0,
        text:               r.text,
        ts:                 r.ts,
        time:               new Date(r.ts * 1000).toLocaleTimeString(),
        direction:          r.direction || 'rx',
        ackStatus:          r.status || null,
        src:                r.rx_devices ? r.rx_devices.split(',').filter(Boolean) : [],
        // THE QUOTED PARENT, SERVED. {packet_id, short_name, text} or null — the
        // browser does not go looking for it, and null means the parent was never
        // heard rather than that we mislaid it. src/filters.js.
        replyTo:            r.reply_to || null,
        channelName:        r.channel_name || null,
        // WHICH CONVERSATION THIS BELONGS TO — the app's contactKey.
        // A DM belongs to the OTHER node whichever way it went; a broadcast
        // belongs to its channel. Computed from served fields only: this is
        // grouping for display, not a decision about routing.
        convKey:            (r.is_dm === 1)
          ? 'dm:' + ((r.direction === 'tx') ? (r.to_num >>> 0) : r.from_num)
          : 'ch:' + (r.channel_name || ('channel ' + (r.channel ?? 0))),
      };
    });
  },

  // ── Conversations ─────────────────────────────────────────────────────────
  //
  // The app is per-conversation (getMessagesFromPaged(contactKey)) and never
  // shows one global list. Ours is derived from the loaded window rather than
  // stored: a conversation is a channel, or the other end of a DM.

  /** Every conversation present, newest activity first. */
  msgConversations() {
    const by = new Map();
    for (const m of this.messages) {
      let c = by.get(m.convKey);
      if (!c) {
        const isDm = m.convKey.startsWith('dm:');
        const num  = isDm ? Number(m.convKey.slice(3)) : null;
        c = {
          key: m.convKey, isDm, num,
          label: isDm ? (this.nodeShortName(num) || this.nodeLabel?.(num) || '!' + (num >>> 0).toString(16))
                      : (m.channelName || 'Channel ' + m.channel),
          count: 0, latest: 0, preview: '',
        };
        by.set(m.convKey, c);
      }
      c.count++;
      if (m.ts >= c.latest) { c.latest = m.ts; c.preview = m.text; }
    }
    return [...by.values()].sort((a, b) => b.latest - a.latest);
  },

  /** The open conversation's messages, NEWEST FIRST.
   *
   *  Peter, 2026-08-20: "no newest at the TOP". The app is bottom-anchored
   *  (reverseLayout = true); this is a dashboard you read rather than a messenger
   *  you talk into, so the newest line is where the eye lands without scrolling.
   *
   *  The rows carry `showSender` and `dayBreak` so the template renders a run
   *  from one node as one block and marks the day change. Computed once here
   *  rather than per-row in the template, where it would re-run on every render.
   *  docs/modules/tab-messages.md. */
  msgThread() {
    const key = this.msgConvKey || this.msgConversations()[0]?.key;
    if (!key) return [];
    const rows = this.messages.filter(m => m.convKey === key)
                              .sort((a, b) => b.ts - a.ts);
    const day = ts => new Date(ts * 1000).toDateString();
    return rows.map((m, i) => {
      // NEXT is the OLDER neighbour, because the list descends. A sender heading
      // shows when this message starts a run, i.e. when the one BELOW it is a
      // different sender — which reads correctly top-down.
      const older = rows[i + 1];
      return {
        ...m,
        showSender: !older || older.fromNum !== m.fromNum,
        dayBreak:   !older || day(older.ts) !== day(m.ts),
        dayLabel:   new Date(m.ts * 1000).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
      };
    });
  },

  msgOpenConversation(key) { this.msgConvKey = key; },

  _applyMessageRows(rows) { this.messages = this._mapMessageRows(rows); },

  loadMessages() { /* no-op — history arrives via WS message_history on connect */ },

  // The sending radio's configured channels (device_list dev.channels,
  // backend task device-channels-on-list). Fallback before the first fetch:
  // Primary only. Display convenience — no decisions.
  // The SERVED starting channel — the WORD 'private', from device_list. The
  // browser still does not choose: it renders what the backend states.
  msgDefaultChannel() {
    const d = this.availableDevices.find(x => x.node_id === this.msgFrom);
    return d?.default_channel ?? 'private';
  },

  // WHY THIS NO LONGER EXISTS AS A HAZARD, kept as a record because the bug it
  // guarded was live and is instructive.
  //
  // The form used to hold an INDEX. Caught 2026-08-16: selecting Private on the
  // YAGI (index 1), then switching to the OMNI, left the form on index 1 — which
  // on the OMNI is `mqtt`, UNENCRYPTED. The index existed on both radios, so an
  // "is this index valid" check passed, and a private message would have gone out
  // in clear. The guard asked which radio the selection was made on.
  //
  // 'private' means private on every radio, so switching radios cannot change
  // what the selection means. The staleness question disappears with the index.
  msgChannelStale() {
    return false;
  },

  // The two choices, and there are only ever two.
  msgFromChannels() {
    return [{ value: 'public', label: 'PUBLIC' }, { value: 'private', label: 'PRIVATE' }];
  },

  displayMessages() {
    // Order and threading are pre-computed — the browser only applies the
    // user's feed view filter.
    if (this.msgFilter === 'bcast') return this.messages.filter(m => m.broadcast);
    if (this.msgFilter === 'dir')   return this.messages.filter(m => !m.broadcast);
    if (this.msgFilter === 'chat')  return this.messages.filter(m => m.broadcast && !m.privateChannel);
    return this.messages;
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
    // A CHANNEL IS ONE OF TWO WORDS, AND NEVER A NUMBER.
    //
    // This used to coerce with Number() and refuse a non-integer, because the
    // browser was handed an INDEX. Peter, 2026-08-19: "you need to know nothing
    // about channels, channel indexes, PSKs, PKI, all you need to know is public
    // and private." The gateway resolves the word against the radio addressed —
    // it must, because private is index 2 on one of our radios and 1 on the
    // other. docs/modules/channels.md.
    //
    // The refusal stays and is now exact: anything that is not one of the two
    // words does not go. There is no coercion left to reintroduce `Number(null)
    // === 0`, which is the public mesh.
    if (this.msgChannel !== 'public' && this.msgChannel !== 'private') {
      this.showToast('Choose Public or Private — nothing sent', 'error', 0);
      return;
    }
    const text = this.msgText, channel = this.msgChannel, time = new Date().toLocaleTimeString();
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

    // NO optimistic local row. A sent message reaches the feed by exactly the
    // same route as a received one: the server persists it, then broadcasts the
    // authoritative history. One writer, one identity, no reconciliation.
    // Send feedback is transient UI (msgSent / toast), never a row in the list.
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
      // The feed updates when the server's message_history arrives — not here.
      this.msgSent = true;
      setTimeout(() => (this.msgSent = false), 2000);
    } catch (e) {
      this.showToast(e.message || 'Send failed — check gateway connection', 'error', 0);
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
