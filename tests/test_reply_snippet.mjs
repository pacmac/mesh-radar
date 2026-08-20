// A reply is served with a snippet of the message it answers.
//
// The messages page renders that snippet ABOVE the reply — the phone app's
// ReplySnippet (MessageScreenComponents.kt:178). Peter asked for newest-first
// (2026-08-20), so a reply is drawn above its parent and the parent is further
// DOWN the page: the snippet is the only thing carrying the context, because
// scrolling toward the parent means scrolling backwards through time.
//
// RESOLVED SERVER-SIDE, and that is what this asserts. The browser holds only the
// loaded window; a reply to anything older would silently render with no quote and
// look like a bug rather than a limit. docs/modules/tab-messages.md.
//
// Runs against the LIVE service because the resolution is a SQL join over real
// rows — a fixture would assert the shape of my own mock, not the query.

const BASE = process.env.NODE_DASH_URL || 'http://127.0.0.1:8000';

let checks = 0;
const ok = (c, w) => { if (!c) { console.error('FAIL  ' + w); process.exitCode = 1; } else { checks++; } };

let rows;
try {
  const r = await fetch(`${BASE}/messages?limit=400`);
  if (!r.ok) { console.error(`FAIL  GET /messages -> ${r.status}`); process.exit(1); }
  rows = await r.json();
} catch (e) {
  // A missing service is a MISTRIAL, not evidence against anybody — exit 127 so
  // the register reads it as "could not run" rather than as a conviction.
  console.error(`could not reach ${BASE}: ${e.message}`);
  process.exit(127);
}

ok(Array.isArray(rows) && rows.length > 0, 'the service returned messages at all');

// EVERY row carries the field, present-or-null. A missing key is different from a
// null: null says "no parent", absent says "this build does not resolve parents",
// and the page cannot tell those apart at render time.
const missingKey = rows.filter(r => !('reply_to' in r));
ok(missingKey.length === 0,
   `every row carries reply_to (present or null) — ${missingKey.length} of ${rows.length} lack the key entirely`);

const replies = rows.filter(r => r.reply_id != null);
ok(replies.length > 0, `the window contains at least one reply to resolve (found ${replies.length})`);

const quoted = replies.filter(r => r.reply_to);
ok(quoted.length > 0, `at least one reply resolves its parent (${quoted.length} of ${replies.length})`);

// THE SHAPE. The page reads exactly these three fields.
for (const r of quoted.slice(0, 20)) {
  ok(typeof r.reply_to.text === 'string', 'reply_to.text is a string');
  ok('short_name' in r.reply_to,          'reply_to carries short_name (may be null)');
  ok(r.reply_to.packet_id === r.reply_id, 'reply_to is the message this one answers, matched on packet_id');
}

// TRUNCATED SERVER-SIDE. A quote is a reminder, not a copy; shipping the whole
// parent so the browser can cut it wastes the wire and lets two layers disagree
// about the length.
const overLong = quoted.filter(r => r.reply_to.text.length > 120);
ok(overLong.length === 0, `no quote exceeds 120 chars — ${overLong.length} did`);

// A NON-REPLY MUST BE NULL, never an empty object: the template tests truthiness,
// and {} would render an empty quote box implying a parent we mislaid.
const bad = rows.filter(r => r.reply_id == null && r.reply_to != null);
ok(bad.length === 0, `a message that is not a reply has reply_to === null — ${bad.length} did not`);

if (process.exitCode) { console.error('reply-snippet contract FAILED'); process.exit(1); }
console.log(`${checks} checks — ${quoted.length}/${replies.length} replies resolve a parent, truncated, shaped for the page.`);
process.exit(0);
