// ALARM PLUGIN — browser registration. NOT CORE.
//
// One call. It tells the host that this plugin contributes a `control` tab, a
// nav entry and a script, and nothing in core knows what any of them contain.
// Delete this file and its one import in index.js and the browser has no
// Control page at all — no nav entry, no dead x-if, no console error.
//
// The entire Control page is alarm: all seven sub-tabs (Summary, Command,
// Camera, Config, Stats, Yagi Align, Chat) are pac-host surfaces. It lived in
// core partials only because no browser hook existed until now.
//
// See docs/BROWSER_PLUGIN_SPEC.md.

import { registerBrowserPlugin } from './browser-plugins.js';

registerBrowserPlugin({
  tab:     'control',
  partial: 'plugins/alarm/tab-control.html',
  nav:     'plugins/alarm/nav.html',
  header:  'plugins/alarm/header.html',
  scripts: ['/plugins/alarm/plugin.js'],
});
