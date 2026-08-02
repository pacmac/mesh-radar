// Observatory page mixin — the live observation feed.
//
// Peter, 2026-08-02: "a new page in the main menu, below radar, so that I can
// see the page growing with live data as it is added" and, watching me read
// numbers out of a terminal, "you can see data, I see nothing at all."
//
// PRESENTATION ONLY. Every value here arrived over the WS from
// src/observatory-ws.js; this file decides nothing (BROWSER_CONTRACT). There is
// no fetch anywhere in it and there must never be — the feed is pushed,
// replayed on connect, and appended on arrival.
//
// TIMES ARE ABSOLUTE, NOT RELATIVE, and that is a contract decision rather than
// a style one. BROWSER_CONTRACT forbids the browser computing "3s ago" on a
// timer; formatting a timestamp it was given is expressly allowed. So rows carry
// a clock time. When the server starts pushing a formatted age, it can replace
// this without the page changing shape.
import { persistSet } from './app-persist.js';

// Enough to fill a tall screen and scroll a while, small enough that an idle tab
// cannot grow without bound. The server replays 200 on connect.
const MAX_ROWS = 500;

export const observatoryMixin = {
  // Sub-tabs. Peter, 2026-08-02: "maybe we need a main menu and sub menus for
  // this? … that way debug sub pages can be added and we still have the main
  // nasa dashboard."
  //
  // The board stays the board. Raw feeds and diagnostics live behind their own
  // tabs, so adding the tenth debug view never costs the dashboard a pixel.
  // Same shape as switchControlTab/switchCfgTab; no data load on switch, because
  // everything here is WS-pushed regardless of which tab is showing.
  switchObsTab(name) {
    this.obsTab = name;
    persistSet('obsTab', name);
  },

  /** Newest first. Fed by both WS messages below. */
  observations: [],

  /** Relay usage — the doors. Server-computed by the relay.usage inference and
   *  pushed; the browser ranks nothing and counts nothing. */
  relayUsage: [],

  applyRelayUsage(ev) { this.relayUsage = ev.relays || []; },

  /** The reach model — record, ladder, frontier, and the honest counts around
   *  them. Entirely server-computed; the page ranks and decides nothing. */
  reach: null,

  applyReachModel(ev) { this.reach = ev.reach || null; },

  /** Ladder rungs are dated, not aged — same absolute-time rule as obsTime(). */
  obsDate(ts) {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleDateString([], { day: '2-digit', month: 'short' });
  },

  /** Replayed to every new connection — see observatory-ws.js. Without this the
   *  page is blank until the next packet, which on a quiet channel is minutes
   *  and reads as broken. */
  applyObservationsReplay(ev) {
    this.observations = (ev.observations || []).slice(0, MAX_ROWS);
  },

  /** One observation, as it is recorded. */
  applyObservation(ev) {
    const o = ev.observation;
    if (!o) return;
    this.observations = [o, ...this.observations].slice(0, MAX_ROWS);
  },

  // ── Pure renderers. Formatting only; nothing is derived or decided. ────────

  obsTime(ts) {
    if (!ts) return '';
    return new Date(ts * 1000).toLocaleTimeString([], { hour12: false });
  },

  /** The receiving radio's label, from the roster the server already pushed.
   *  Falls back to the raw MAC rather than inventing a name. */
  obsRadio(mac) {
    if (!mac) return '—';
    return this.deviceLabel?.(mac) || this.deviceConfigs?.[mac]?.label || mac.slice(0, 8);
  },

  /** A node's short name if the server has sent one, else its raw num. Never
   *  guessed — an unnamed node shows as a number, which is honest.
   *
   *  Looks up by num rather than through nodeById(), which takes a `!hex` id
   *  and threw `nodeId?.startsWith is not a function` 182 times when handed the
   *  numeric entity. An observation's entity is opaque to the engine and
   *  happens to be a node num here; converting it to an id would be this page
   *  asserting a format the store does not guarantee. */
  obsNode(entity) {
    const num = Number(entity);
    if (!Number.isFinite(num)) return entity;
    const n = this.nodes?.find?.(x => x.num === num);
    return n?.user?.short_name || entity;
  },

  /** THE COLUMN THIS PAGE EXISTS FOR. Null is rendered as an em dash, never as
   *  0 — north is a real bearing and a blank must not read as one. */
  obsAz(o) {
    const az = o?.data?.az;
    return (az == null) ? '—' : `${az}°`;
  },

  /** Bearing rows are the ones with information in them; everything else is
   *  context. Used to tint, not to filter — a filtered feed hides how much of
   *  the traffic carries no bearing, which is itself worth seeing. */
  obsHasAz(o) { return o?.data?.az != null; },

  obsNum(v, suffix = '') { return (v == null) ? '—' : `${v}${suffix}`; },

  /** Distinct nodes among the observations ON SCREEN. Describes the list being
   *  rendered, not a fact about the mesh — a mesh-wide count would be a derived
   *  claim and belongs to the server (BROWSER_CONTRACT). Labelled "on screen"
   *  in the UI for exactly that reason. */
  obsNodeCount() { return new Set(this.observations.map(o => o.entity)).size; },

  // obsRelayName() was here and is gone. It looked the name up in this.nodes,
  // which is a FILTERED list — 4 entries at the time — so every relay rendered
  // as a raw number. The server now sends `label` with each relay, which is
  // where a display value belongs anyway (BROWSER_CONTRACT).

  /** Bar width relative to the busiest door. Presentation of pushed values —
   *  the ranking itself was done by the server. */
  obsRelayShare(uses) {
    const top = this.relayUsage[0]?.uses || 0;
    return top ? Math.max(3, Math.round((uses / top) * 100)) : 0;
  },
};
