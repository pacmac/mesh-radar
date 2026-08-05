#!/usr/bin/env node
// CONTRACT CHECK — catches the class of defect that shipped on 2026-08-04.
//
// Peter: "I cannot sit here for the next 2 weeks picking up your bugs."
//
// Every assertion here corresponds to a real bug that reached him. It is not a
// general test suite; it is a regression net for MY failure mode, which is
// verifying the payload and claiming the feature works.
//
// Run: node scripts/check_contract.mjs        (exit 1 on any failure)

import { readFileSync, readdirSync } from 'node:fs';
import WebSocket from 'ws';
import { DEFAULTS as DEFAULTS_FOR_CHECK } from '../src/config-api.js';

const ROOT = new URL('..', import.meta.url).pathname;
const R = (p) => readFileSync(ROOT + p, 'utf8');
let failures = 0;
const fail = (what, detail) => { failures++; console.log(`  FAIL  ${what}\n        ${detail}`); };
const pass = (what) => console.log(`  ok    ${what}`);

// ── 1. Every tone token the SERVER emits must exist in the BROWSER's TONE map.
// Bug: role_tone emitted 'gold'/'dim'; TONE has neither, so toneCls() fell
// through to muted and every ROUTER badge rendered identically to a CLIENT.
// I had "verified" it by reading the payload.
const helpers = R('public/app-helpers.js');
const TONES = new Set([...helpers.matchAll(/^\s{2}(\w+):\s*\{ cls:/gm)].map(m => m[1]));
// Only assignments to a `tone` / `*_tone` FIELD count. An earlier version
// matched any string ternary and flagged 'running', 'idle', 'packet' — status
// enums, not tones. A check that cries wolf gets ignored, which is worse than
// no check.
const srcTones = new Set();
for (const f of readdirSync(ROOT + 'src').filter(f => f.endsWith('.js'))) {
  for (const line of R(`src/${f}`).split('\n')) {
    const m = line.match(/(?:^|[\s{,])(?:\w*_)?tone:\s*(.+?)(?:,\s*$|$)/);
    if (!m) continue;
    for (const lit of m[1].matchAll(/'([a-z]+)'/g)) srcTones.add(lit[1]);
  }
}
const bogus = [...srcTones].filter(t => !TONES.has(t) && !['primary','secondary','accent','neutral','ghost'].includes(t));
bogus.length
  ? fail('served tone tokens all render', `not in app-helpers TONE: ${bogus.join(', ')} (known: ${[...TONES].join(', ')})`)
  : pass(`served tone tokens all render (${TONES.size} known)`);

// ── 2. No numeric threshold in public/ may select a class, colour or label.
// Bug: swept twice and missed both the partials and every `<` comparison.
const uiFiles = [
  ...readdirSync(ROOT + 'public').filter(f => f.endsWith('.js')).map(f => `public/${f}`),
  ...readdirSync(ROOT + 'public/partials').filter(f => f.endsWith('.html')).map(f => `public/partials/${f}`),
];
const THRESH = /(>=|<=|>|<)\s*-?\d+(\.\d+)?\s*\?[^?]*?['"](text-|badge-|bg-|oklch|rgba|Excellent|Good|Fair|Poor|Usable|Fragile|Failing|high|medium|better|worse)/;
const ALLOW = /opacity|i \* 25|bars > i|width|height|scrollHeight/;
const offenders = [];
for (const f of uiFiles) {
  R(f).split('\n').forEach((line, i) => {
    if (THRESH.test(line) && !ALLOW.test(line)) offenders.push(`${f}:${i + 1}`);
  });
}
// app-perf.js:397 reads the SERVED dead-band then tests a sign — allowed.
const real = offenders.filter(o => !/app-perf\.js:39[0-9]/.test(o));
real.length
  ? fail('no threshold decides a class in public/', real.join('\n        '))
  : pass(`no threshold decides a class in public/ (${uiFiles.length} files)`);

// ── 3. NO INLINE TIMING LITERALS. Every timing is a named var, and most become
// knobs. Peter, 2026-08-04: "stop setting arbitrary timings and stop hard coding
// timings ... what is the basis for your 5 second calculation, why not use 2
// days instead of 5 seconds ... STOP DOING THAT", then "timings CANNOT be hard
// coded FULL STOP", then "all timings need to be vars. some if not all will be
// selected to be configurables / knobs."
//
// A named constant with a stated basis is fine; a bare number in a setTimeout is
// not, because it says nothing about WHY and cannot be changed without an edit.
// Two shapes, because the first version only caught the timer call and missed a
// bare `Date.now() - t > 25000` comparison sitting three lines away in the same
// file. A timing is a timing wherever it appears.
const TIMING_RE = /set(?:Timeout|Interval)\s*\([^,]*,\s*[0-9_]{3,}\s*\)|Date\.now\(\)\s*-\s*\w+[^;]{0,40}[<>]=?\s*[0-9_]{3,}/;
const timers = [];
for (const f of readdirSync(ROOT + 'src').filter(f => f.endsWith('.js'))) {
  R(`src/${f}`).split('\n').forEach((line, i) => {
    if (TIMING_RE.test(line) && !line.trim().startsWith('//')) timers.push(`src/${f}:${i + 1}`);
  });
}
timers.length
  ? fail('no inline timing literals', timers.join('\n        '))
  : pass('no inline timing literals (src/*.js)');

// ── 4. observatory.window_days must default the same everywhere.
// Bug: charts() read 7 while config-api and three SQL COALESCEs read 30, so a
// missing key produced 7-day series next to 30-day figures in one payload.
const defs = new Set();
for (const [f, re] of [
  ['src/observatory-ws.js', /getConfig\('observatory\.window_days',\s*(\d+)\)/g],
  ['src/config-api.js',     /window_days:\s*(\d+)/g],
  ['src/inferences.js',     /key = 'observatory\.window_days'\),\s*(\d+)\)/g],
]) for (const m of R(f).matchAll(re)) defs.add(m[1]);
defs.size > 1
  ? fail('observatory.window_days default agrees', `found ${[...defs].join(' and ')}`)
  : pass(`observatory.window_days default agrees (${[...defs][0] ?? 'none found'})`);

// ── 4. Live payload invariants.
// Bugs: contribution() had no plausibility ceiling, so one laundered position
// would flip the headline green; and it printed literal "null" before the
// ladder produced a fact.
const PLAUSIBLE = 445;
await new Promise((resolve) => {
  const ws = new WebSocket('ws://127.0.0.1:8000/events');
  const t = setTimeout(() => { fail('live payload reachable', 'no charts within 20s'); ws.close(); resolve(); }, 20000);
  ws.on('error', (e) => { clearTimeout(t); fail('live payload reachable', e.message); resolve(); });
  ws.on('message', (d) => {
    let ev; try { ev = JSON.parse(d); } catch { return; }
    if (ev.type !== 'charts' || !ev.charts) return;
    clearTimeout(t); const c = ev.charts;

    const far = (c.nodes?.rows ?? []).filter(r => r.km > PLAUSIBLE);
    far.length ? fail('no served distance exceeds the plausibility ceiling',
                      `${far.length} rows > ${PLAUSIBLE} km, furthest ${far[0].km}`)
               : pass('no served distance exceeds the plausibility ceiling');

    // Walk STRING VALUES only. An earlier version regexed the JSON text and
    // matched `"key":null` — a legitimate null field, not a display string.
    const bad = [];
    const walk = (v) => {
      if (typeof v === 'string') { if (/\b(null|undefined|NaN)\b/.test(v)) bad.push(v); }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(c.contribution); walk(c.nodes?.rows);
    bad.length
      ? fail('no served display string contains null/undefined/NaN', bad[0].slice(0, 120))
      : pass('no served display string contains null/undefined/NaN');

    // ── Every served reach FIGURE must be rendered somewhere.
    // Bug: charts.heard_km (proven contact, 444.2 km) was computed, served, and
    // rendered NOWHERE, so every headline on the board was traceroute-only and
    // the first number Peter looked at was the wrong one.
    const markup = R('public/partials/tab-observatory.html');
    const unrendered = ['record_km', 'window_best_km', 'heard_km']
      .filter(k => c[k] != null && !markup.includes(k));
    unrendered.length
      ? fail('every served reach figure is rendered', `served but never rendered: ${unrendered.join(', ')}`)
      : pass('every served reach figure is rendered');

    const cont = c.contribution;
    (cont && cont.beyond_record > 0 && !cont.gaining) || (cont && cont.beyond_record === 0 && cont.gaining)
      ? fail('gaining flag agrees with beyond_record', JSON.stringify({ beyond: cont.beyond_record, gaining: cont.gaining }))
      : pass('gaining flag agrees with beyond_record');

    ws.close(); resolve();
  });
});


// ── Config keys must have SOME read path ─────────────────────────────────────
//
// config-api DEFAULTS is a hard allowlist for BOTH read and write: GET and PUT
// /config/:key each return 404 for anything not declared. So a key read by a
// consumer, never declared, and with no dedicated route is INVISIBLE to the
// browser — it works server-side and cannot be seen or edited.
//
// That is not hypothetical. node_filters.hide_mqtt_only shipped read-but-
// undeclared on 2026-08-05 and would have stayed invisible to the settings form.
//
// NOT every key belongs in DEFAULTS. These prefixes have their own read paths or
// are internal, and forcing them into the generic allowlist would expose
// migration flags and secrets to a settings UI:
//
//   home.*        GET /home_pos          tilt.*     GET /tilt_cal
//   alerts.*      alerts-api             rotator.*  rotator-api
//   callout.*     GET /config/callout    migrations.*  internal, never user-facing
//
// Anything OUTSIDE those and outside DEFAULTS is the defect this catches.
{
  const OWN_ROUTE = /^(home|tilt|alerts|rotator|callout|migrations)\./;
  const declared = new Set(Object.keys(DEFAULTS_FOR_CHECK));
  const read = new Set();
  for (const f of readdirSync('src').filter(f => f.endsWith('.js'))) {
    const t = readFileSync(`src/${f}`, 'utf8');
    for (const m of t.matchAll(/getConfig\(\s*'([^']+)'/g)) read.add(m[1]);
  }
  const orphans = [...read].filter(k => k.includes('.') && !declared.has(k) && !OWN_ROUTE.test(k));
  if (orphans.length) {
    fail('config keys read but with no read path',
         `${orphans.join(', ')} — declare in config-api DEFAULTS or give it a route`);
  } else {
    pass(`every dotted config key read in src/ has a read path (${read.size} keys)`);
  }
}

// ── Browser persistence: the class convention must not rot ───────────────────
//
// app-persist.js is a single, correct mechanism that 115 of 116 controls
// bypassed, because nothing enforced its use. Peter, 2026-08-05: "one of my
// requirements was for a single persist function in the browser that worked on
// every control ... every time I reload the page, these are not being honoured".
//
// A RATCHET, not a hard gate. Classifying the remainder means READING each
// control — my regex could only see inline handlers and left 49 of 115
// unclassified, and guessing would be worse than counting. So this locks in
// progress: the number of unclassified controls may go down and never up.
{
  const files = readdirSync('public/partials').filter(f => f.endsWith('.html'));
  let total = 0, unclassified = 0;
  for (const f of files) {
    const txt = readFileSync(`public/partials/${f}`, 'utf8');
    // A REGION WRAPPER counts. app-persist resolves the class with .closest(),
    // so a container marks everything inside it — and an inner pref-backend
    // correctly overrides an outer pref-user, which is how tab-nodes carries
    // view-state controls and node-filter controls in one file.
    //
    // A regex cannot do DOM ancestry, so this is a FILE-LEVEL approximation of
    // that rule. It is honest about being weaker than the runtime check: it can
    // pass a file whose wrapper does not actually enclose every control.
    const region = /pref-backend|pref-user/.test(txt);
    for (const m of txt.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
      total++;
      const attrs = m[2];
      // A pref-user control needs BOTH a declaration and a KEY. Declaring it
      // and leaving it keyless still does not persist — which is exactly what
      // happened to the node sort selects: wrapped in a pref-user region,
      // reported as classified, and still not saved, because they use an inline
      // @change handler and carry no name/id/x-model for the key to come from.
      //
      // pref-backend needs no key: the server owns the value.
      const isBackend = /pref-backend/.test(attrs);
      const isExempt  = /no-persist|disabled/.test(attrs) || isBackend;
      const keyed = /\b(id|name)\s*=/.test(attrs) || /x-model/.test(attrs);
      if (!isExempt && !keyed) unclassified++;
    }
  }
  // A RATCHET AT THE HONEST NUMBER. This check was briefly reporting 0 while the
  // node sort order still did not persist — because it counted a `pref-user`
  // DECLARATION as sufficient. It is not: a control also needs a KEY, and a
  // control with an inline @change handler has none. Corrected to count keys,
  // which put the real figure at 40. Fixing nodeSortKey took it to 39.
  //
  // The rest are controls whose handler writes Alpine state directly; each needs
  // a name= chosen deliberately, because the name becomes the stored key and
  // renaming it later silently orphans the saved value. Read, do not guess.
  const BASELINE = 39;
  if (unclassified > BASELINE) {
    fail(`persistence: ${unclassified} browser controls have no persist key (baseline ${BASELINE}). `
       + `Give each a name=, or mark it pref-backend / no-persist.`);
  } else {
    pass(`persistence: ${unclassified}/${total} browser controls without a persist key (baseline ${BASELINE})`);
  }
}

console.log(failures ? `\n${failures} contract failure(s).` : '\nContract clean.');
process.exit(failures ? 1 : 0);
