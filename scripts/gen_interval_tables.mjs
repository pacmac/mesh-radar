// Generate src/interval-tables.js from the vendored Meshtastic-Android source.
//
// Spec: docs/modules/interval-tables.md
//
//   node scripts/gen_interval_tables.mjs           write src/interval-tables.js
//   node scripts/gen_interval_tables.mjs --check    regenerate in memory, diff,
//                                                   exit 1 on any difference
//
// WHY THIS EXISTS. Peter, 2026-08-18: "my guess is you did a 1 time export of the
// schema. this should be a script". It was, and the source file existed only in a
// session-scoped scratchpad — so the numbers in src/ were days away from being
// unverifiable by anyone.
//
// The hand-port got ALL wrong, and got it wrong by TIDYING: the app's ALL is the
// enum in DECLARATION order, which ends 2147483647, 80, 90, 8, 40 because four
// members were appended after ALWAYS_ON. It was transcribed ascending. A typo
// survives review; an improvement does not get noticed at all.
//
// THIS SCRIPT RESOLVES NAMES AND NEVER RE-DERIVES NUMBERS. Every value comes from
// the enum member the source actually names. Anything it cannot resolve is a
// throw, not a guess — a generator that guesses is a hand-transcription with extra
// steps.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'vendor/meshtastic-android/FixedUpdateIntervals.kt');
const TARGET = join(ROOT, 'src/interval-tables.js');

const REL_SOURCE = 'vendor/meshtastic-android/FixedUpdateIntervals.kt';
const REL_SCRIPT = 'scripts/gen_interval_tables.mjs';

const die = (msg) => { throw new Error(`gen_interval_tables: ${msg}`); };

/** Resolve one Kotlin duration expression to integer SECONDS.
 *
 *  Deliberately a closed set of forms. An unrecognised expression throws, because
 *  the alternative — falling back to a regex that plucks the leading number — would
 *  silently turn `500.milliseconds` into 500 seconds. */
function resolveSeconds(expr, member) {
  const e = expr.trim();

  // Int.MAX_VALUE.toLong() -> ALWAYS_ON
  if (/^Int\.MAX_VALUE\.toLong\(\)$/.test(e)) return 2147483647;

  // TimeConstants.ONE_HOUR.inWholeSeconds
  if (/^TimeConstants\.ONE_HOUR\.inWholeSeconds$/.test(e)) return 3600;

  // 0L
  const bare = /^(\d+)L?$/.exec(e);
  if (bare) return Number(bare[1]);

  // 30.minutes.inWholeSeconds / 8.seconds.inWholeSeconds / 72.hours.inWholeSeconds
  const dur = /^(\d+)\.(seconds|minutes|hours)\.inWholeSeconds$/.exec(e);
  if (dur) {
    const mult = { seconds: 1, minutes: 60, hours: 3600 }[dur[2]];
    return Number(dur[1]) * mult;
  }

  die(`cannot resolve the value of ${member}: ${JSON.stringify(e)}. `
    + `Add the form to resolveSeconds rather than letting it guess.`);
}

/** enum FixedUpdateIntervals -> [{name, seconds}] in DECLARATION ORDER.
 *
 *  Order is load-bearing: IntervalConfiguration.ALL is `entries`, so declaration
 *  order IS the option order the app renders. */
function parseMembers(src) {
  const start = src.indexOf('enum class FixedUpdateIntervals(');
  if (start === -1) die('enum class FixedUpdateIntervals not found');
  // The member list runs to the `;` that closes it, before `companion object`.
  const bodyStart = src.indexOf('{', start);
  const end = src.indexOf('companion object', bodyStart);
  if (end === -1) die('companion object not found — cannot bound the member list');
  const body = src.slice(bodyStart, end);

  const members = [];
  // NAME(<args>),  at the start of a line. The value is the FIRST argument, which
  // ends at the first comma not nested in parentheses.
  for (const line of body.split('\n')) {
    const m = /^\s{4}([A-Z][A-Z0-9_]*)\((.*)\),\s*$/.exec(line);
    if (!m) continue;
    const [, name, args] = m;
    let depth = 0, cut = args.length;
    for (let i = 0; i < args.length; i++) {
      const c = args[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) { cut = i; break; }
    }
    members.push({ name, seconds: resolveSeconds(args.slice(0, cut), name) });
  }
  if (!members.length) die('parsed zero enum members — the source shape has changed');
  return members;
}

/** IntervalConfiguration.allowedIntervals -> {CONFIG: [seconds]}. */
function parseConfigurations(src, members) {
  const byName = new Map(members.map(m => [m.name, m.seconds]));

  const start = src.indexOf('val allowedIntervals');
  if (start === -1) die('val allowedIntervals not found');
  const body = src.slice(start);

  // Order the configurations exactly as the `when` arms appear.
  const out = {};

  // ALL -> FixedUpdateIntervals.entries. Special-cased BY NAME because `entries`
  // is a language feature, not a list we can read: it means every member in
  // declaration order. This is the arm the hand-port got wrong.
  if (!/\bALL\s*->\s*FixedUpdateIntervals\.entries\b/.test(body))
    die('the ALL arm is no longer `FixedUpdateIntervals.entries` — re-read the source '
      + 'before assuming declaration order still applies');
  out.ALL = members.map(m => m.seconds);

  // NAME ->\n listOf(\n FixedUpdateIntervals.X,\n ... )
  const arm = /^\s{12}([A-Z][A-Z0-9_]*)\s*->\s*$\n\s*listOf\(([\s\S]*?)\)\s*$/gm;
  let m;
  while ((m = arm.exec(body)) !== null) {
    const [, config, listBody] = m;
    const refs = [...listBody.matchAll(/FixedUpdateIntervals\.([A-Z][A-Z0-9_]*)/g)].map(r => r[1]);
    if (!refs.length) die(`configuration ${config} resolved to an empty list`);
    out[config] = refs.map(name => {
      if (!byName.has(name))
        die(`configuration ${config} names FixedUpdateIntervals.${name}, `
          + `which the enum does not define`);
      return byName.get(name);
    });
  }

  // Cross-check against the declared IntervalConfiguration enum, so an arm this
  // regex fails to match is a LOUD failure rather than a quietly missing table.
  const enumStart = src.indexOf('enum class IntervalConfiguration {');
  if (enumStart === -1) die('enum class IntervalConfiguration not found');
  const declared = [...src.slice(enumStart, src.indexOf(';', enumStart))
    .matchAll(/^\s{4}([A-Z][A-Z0-9_]*),\s*$/gm)].map(r => r[1]);
  const missing = declared.filter(d => !(d in out));
  if (missing.length)
    die(`declared but not parsed: ${missing.join(', ')}. The when-arm shape has changed.`);

  return out;
}

function render(members, configs) {
  const pad = Math.max(...Object.keys(configs).map(k => k.length));
  const lines = [];

  lines.push(
    '// GENERATED FILE — DO NOT EDIT.',
    '//',
    `// Written by ${REL_SCRIPT} from`,
    `//            ${REL_SOURCE}`,
    '//',
    '// Regenerate:  node scripts/gen_interval_tables.mjs',
    '// Verify:      node scripts/gen_interval_tables.mjs --check   (runs in npm run check)',
    '//',
    '// Spec: docs/modules/interval-tables.md. The hand-written half — the field ->',
    '// configuration map, the labels, decorateSchema — lives in src/interval-options.js,',
    '// because none of it is stated in the Kotlin.',
    '',
    '/** Every named interval, in the enum\'s DECLARATION order. */',
    'export const INTERVAL_NAMES = {',
    ...members.map(m => `  ${m.name}: ${m.seconds},`),
    '};',
    '',
    '/** Each configuration\'s allowed intervals, in the order the app lists them.',
    ' *',
    ' *  ALL is `FixedUpdateIntervals.entries` — declaration order, NOT ascending. It',
    ' *  ends 2147483647, 80, 90, 8, 40 because four members were appended to the enum',
    ' *  after ALWAYS_ON. Sorting it would be a change to upstream data. */',
    'export const INTERVAL_CONFIGURATIONS = {',
  );
  for (const [name, secs] of Object.entries(configs)) {
    lines.push(`  ${(name + ':').padEnd(pad + 1)} [${secs.join(', ')}],`);
  }
  lines.push('};', '');

  return lines.join('\n');
}

const src      = readFileSync(SOURCE, 'utf8');
const members  = parseMembers(src);
const configs  = parseConfigurations(src, members);
const rendered = render(members, configs);

if (process.argv.includes('--check')) {
  let onDisk;
  try {
    onDisk = readFileSync(TARGET, 'utf8');
  } catch {
    console.error(`FAIL  src/interval-tables.js is missing. Run: node ${REL_SCRIPT}`);
    process.exit(1);
  }
  if (onDisk !== rendered) {
    // Name the first differing line — "they differ" sends the reader to a diff
    // tool for something the check already knows.
    const a = onDisk.split('\n'), b = rendered.split('\n');
    const i = a.findIndex((l, n) => l !== b[n]);
    console.error('FAIL  src/interval-tables.js does not match the vendored source.');
    console.error(`      first difference at line ${i + 1}:`);
    console.error(`        on disk:   ${a[i] ?? '(end of file)'}`);
    console.error(`        generated: ${b[i] ?? '(end of file)'}`);
    console.error(`      Regenerate with: node ${REL_SCRIPT}`);
    console.error('      If the vendored source changed, that is expected — regenerate and');
    console.error('      review the diff. If it did not, someone hand-edited a generated file.');
    process.exit(1);
  }
  console.log(`ok    src/interval-tables.js matches ${REL_SOURCE}`
            + ` — ${members.length} intervals, ${Object.keys(configs).length} configurations.`);
  process.exit(0);
}

writeFileSync(TARGET, rendered);
console.log(`wrote src/interval-tables.js — ${members.length} intervals, `
          + `${Object.keys(configs).length} configurations, from ${REL_SOURCE}.`);
