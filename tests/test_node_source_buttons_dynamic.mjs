// tab-nodes.html / tab-radar.html hardcoded "YAGI"/"OMNI" button text and
// setNodeSource('yagi'|'omni') calls — wrong on any deployment without
// exactly this dev box's 2 named radios (e.g. a Pi with 1 radio, no rotator
// at all). Peter, 2026-10-11: "nobody ever said there would be 1,2,3 or any
// number of radios." idiot entry node-source-filter-hardcodes-omni-yagi
// (Domain 2 half). Spec: docs/modules/tab-nodes.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };

for (const rel of ['public/partials/tab-nodes.html', 'public/partials/tab-radar.html']) {
  const html = readFileSync(path.join(REPO, rel), 'utf8');
  ok(!/setNodeSource\(\s*'(yagi|omni)'\s*\)/.test(html), `${rel}: no hardcoded setNodeSource('yagi'|'omni') call`);
  ok(!/>\s*YAGI\s*</.test(html) && !/>\s*OMNI\s*</.test(html), `${rel}: no literal YAGI/OMNI button text`);
  ok(/x-for="dev in availableDevices/.test(html), `${rel}: renders source buttons from the live device list`);
  ok(/setNodeSource\('all'\)/.test(html), `${rel}: has an 'All' button`);
}

for (const rel of ['public/app.js', 'public/app-ws.js', 'public/app-nodes.js']) {
  const js = readFileSync(path.join(REPO, rel), 'utf8');
  ok(!/nodeSource\s*(:|=|!==)\s*'both'/.test(js), `${rel}: no leftover 'both' nodeSource reference`);
}

console.log(`test_node_source_buttons_dynamic: ${checks} checks passed`);
