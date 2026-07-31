// ALARM PLUGIN — browser entry point. NOT CORE.
//
// Everything the alarm contributes to the browser is registered from here:
// its mixins, its state, and its WebSocket handlers. Core knows none of it —
// it merges `window.__dashPlugins` blindly.
//
// LOAD ORDER IS LOAD-BEARING. This script is emitted BEFORE /app.js (see
// src/browser-plugins.js renderPluginScripts) so the array is populated by the
// time Alpine evaluates x-data. Registering later would silently never merge,
// with the page looking fine until you needed the state — the same failure
// class as alarm-ws.js's dynamic import (0 live broadcasts in 110 s while the
// connect replay still worked, invisible from the UI).
//
// See docs/BROWSER_PLUGIN_SPEC.md.

import { controlMixin } from './app-control.js';
import { alignMixin }   from './app-align.js';
import { persistGet }   from '/app-persist.js';

(window.__dashPlugins ||= []).push({
  name: 'alarm',

  // Routing. Core's tab<->path maps are seeded from this; core names no plugin
  // tab or path of its own.
  routes:  { control: '/control' },

  // This tab owns a sub-tab, persisted under its own key. Core stores and
  // restores it without knowing what a "controlTab" is.
  subTabs: { control: { stateKey: 'controlTab', persistKey: 'controlTab' } },

  // What entering the tab means is the plugin's business, not core's.
  onTab:   { control(c) { this.switchControlTab(c || this.controlTab || 'command'); } },

  mixins: [controlMixin, alignMixin],

  // State that used to be declared in core's app.js. Display caches only —
  // every count, percentage and elapsed string in them is computed server-side
  // (BROWSER_CONTRACT); nothing here is derived in the browser.
  state: {
    pacHostStatus:      null,
    pacHostQueues:      {},
    // -- command surface (task pac-host-command-surface) --------------------
    // controlTab persists across reloads, same as core's cfgTab does for the
    // Config page — read through the plugin's own key so core never has to
    // know this tab has sub-tabs.
    controlTab:         persistGet('controlTab', 'command'),
    controlTarget:      null,
    controlVerb:        '',
    controlSending:     false,
    // -- Camera (task camera-page / camera-image-card) ----------------------
    alarmImages:        {},
    cameraGrabbing:     false,
    cameraSelectedKey:  null,
    cameraChecking:     false,
    cameraFetching:     false,
    // -- pac-host antenna alignment (task yagi-align-rebuild) ---------------
    alignModel:         null,
    alignTarget:        null,
    alignNBurst:        4,
    alignReplyWinInput: 30,
    alignSending:       false,
  },

  // Handlers run bound to the Alpine component, and ONLY for event types core
  // did not already claim — core keeps first refusal, so a plugin can never
  // shadow a core message.
  wsHandlers: {
    pac_host_status(ev) {
      this.pacHostStatus = ev;
      // Default to the first known commandable unit so the Control page has
      // something to show the moment units become known — never overrides an
      // actual (even auto) choice already made, only fires while still null.
      if (this.controlTarget == null) {
        const first = this.controlDevices()[0];
        if (first) this.controlTarget = first.num;
      }
    },

    pac_host_queues(ev) { this.pacHostQueues = ev.queues || {}; },

    alarm_images(ev)    { this.alarmImages = ev.units || {}; },

    pac_host_align(ev) {
      this.alignModel = ev.model;
      // Adopt the session's own target once it has one. Same never-override
      // guard as controlTarget above: only fires while still null.
      if (this.alignTarget == null && ev.model?.target != null) this.alignTarget = ev.model.target;
      if (typeof ev.model?.replyWindowSec === 'number') this.alignReplyWinInput = ev.model.replyWindowSec;
    },
  },

  // Observers WATCH an event core owns, and claim nothing. `node_list` is a
  // core event; the alarm only needs it to default the Yagi Align target to the
  // first favourite. This used to sit inside core's own node_list handler.
  //
  // Reads ev.favourites from the PUSHED PAYLOAD, not this.favourites: observers
  // run before core has applied the event, so component state is not yet
  // updated. Same never-override guard as before — it only fires while nothing
  // (neither a user pick nor a running session) has set a target.
  wsObservers: {
    node_list(ev) {
      const favs = ev.favourites ?? [];
      if (this.alignTarget == null && favs.length) this.alignTarget = favs[0].num;
    },
  },
});
