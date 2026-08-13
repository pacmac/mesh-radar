// Nothing this server sends may be cacheable. Spec: docs/modules/no-cache.md
//
// This check exists because the regression it guards against is INVISIBLE: a
// cached response is served by the browser without the server ever hearing
// about it. /devices was dead for four weeks that way, replaying a 410 from
// 16 July, and the only symptom was "it's broken again" on one machine.
//
// Run: node scripts/check_no_cache.mjs   (node-dash must be running)

const BASE = process.env.DASH_URL || 'http://localhost:8000';

// Each shape of response the app serves, because they take different paths
// through Express and one can regress without the others.
const CASES = [
  { name: 'page navigation (SPA shell)', path: '/',
    headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } },
  { name: 'static asset',                path: '/app.js',        headers: {} },
  { name: 'generated asset (utils.js)',  path: '/utils.js',      headers: {} },
  { name: 'API GET (form population)',   path: '/config/radar',  headers: { Accept: 'application/json' } },
  { name: 'the WS-only guard 410',       path: '/devices',
    headers: { Accept: '*/*', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } },
  { name: 'the service worker itself',   path: '/sw.js',         headers: {} },
];

let bad = 0;
for (const c of CASES) {
  let res;
  try {
    res = await fetch(BASE + c.path, { headers: c.headers });
  } catch (e) {
    console.log(`  FAIL  ${c.name.padEnd(32)} ${c.path} — unreachable: ${e.message}`);
    bad++;
    continue;
  }

  const cc   = res.headers.get('cache-control') || '';
  const etag = res.headers.get('etag');
  const lm   = res.headers.get('last-modified');

  const problems = [];
  if (!cc.includes('no-store')) problems.push(`cache-control is "${cc || '(absent)'}"`);
  if (etag)                     problems.push(`has an ETag: ${etag}`);
  if (lm)                       problems.push(`has Last-Modified: ${lm}`);

  if (problems.length) {
    console.log(`  FAIL  ${c.name.padEnd(32)} ${c.path} [${res.status}]`);
    for (const p of problems) console.log(`        ${p}`);
    bad++;
  } else {
    console.log(`  ok    ${c.name.padEnd(32)} ${c.path} [${res.status}]  no-store, no validators`);
  }
}

console.log(bad ? `\n${bad} cacheable response(s).` : `\n${CASES.length} responses, nothing cacheable.`);
process.exit(bad ? 1 : 0);
