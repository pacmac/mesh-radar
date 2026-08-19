// node-dash knows two words: 'public' and 'private'.
//
// Peter, 2026-08-19: "you need to know nothing about channels, channel indexes,
// PSKs, PKI, all you need to know is public and private" / "so all code for
// resolve needs ripping out".
//
// This asserts the ABSENCE of local channel resolution. The gateway owns the
// radios and resolves per radio, which matters because ours disagree: private is
// index 2 on OMNI and 1 on YAGI, so any index held here is already wrong on one
// of them. See docs/modules/channels.md.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;
const fail = [];
const ok = [];

// 1. THE RESOLVER IS GONE.
if (existsSync(join(SRC, 'channels.js'))) fail.push('src/channels.js still exists');
else ok.push('src/channels.js is gone');

// 2. NOTHING IMPORTS IT, and nothing calls what it exported. Checked separately
//    from (1) because an import of a deleted file fails at runtime, not here.
const BANNED = [
  ['channels.js', /from\s+['"]\.\/channels\.js['"]/],
  ['indexFor', /\bindexFor\s*\(/],
  ['channelKey', /\bchannelKey\s*\(/],
  ['designatedKey', /\bdesignatedKey\s*\(/],
  ['setDeviceChannels', /\bsetDeviceChannels\s*\(/],
  ['roleOf', /\broleOf\s*\(/],
];

// The PSK must not be read here at all — that is the half Peter named explicitly.
const SECRETS = [/channels\.pub_psk/, /channels\.pri_psk/, /channels\.pub_name/, /channels\.pri_name/];

const files = readdirSync(SRC).filter(f => f.endsWith('.js'));
if (files.length === 0) { console.error('FAIL no .js found under src/ — wrong path?'); process.exit(2); }

for (const f of files) {
  const text = readFileSync(join(SRC, f), 'utf8');
  // Strip line and block comments: the point is what the CODE does. A comment
  // saying "we no longer call indexFor" must not fail this check, and after a
  // rip-out that explains itself there will be several.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [name, re] of BANNED) {
    if (re.test(code)) fail.push(`src/${f} still references ${name}`);
  }
  for (const re of SECRETS) {
    if (re.test(code)) fail.push(`src/${f} still reads a channel secret: ${re.source}`);
  }
}
if (!fail.length) ok.push(`${files.length} src files carry no resolver reference and no channel secret`);

for (const line of ok)   console.log('ok    ' + line);
for (const line of fail) console.error('FAIL  ' + line);

console.log(`${ok.length} ok, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
