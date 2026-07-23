// The single classifier that maps a message-feed row to one of 5 display buckets
// for the message-feed type filter. Server-side only; the browser renders the
// pushed bucket and never re-derives it (BROWSER_CONTRACT). See
// docs/modules/message-type.md.

export const MESSAGE_BUCKETS = ['chat', 'command', 'alarm', 'camera', 'diagnostics'];

// Received JSON `type` → bucket. Anything not listed here that is still machine
// JSON (pong, status, config, and the command verbs/replies) falls through to
// 'command'; only human plain text is 'chat'.
// The addressed-command grammar the alarm firmware answers: `@<4-hex> <verb>`.
const ADDRESSED_CMD = /^@[0-9a-f]{4}\s+\S/i;

const ALARM_TYPES  = new Set(['detect', 'alarm', 'cleared', 'env', 'wedge']);
const CAMERA_TYPES = new Set(['cam', 'chunk']);
const DIAG_TYPES   = new Set(['diag', 'ext']);

// category is the outbound tag (chat/command/ping) or null for received.
// text is the message body.
export function messageBucket(category, text) {
  // CONTENT WINS for the addressed-command grammar. `@<4-hex-suffix> <verb>` is a
  // command by construction in this system, whatever the stored tag says:
  //  - 322 rows predate the `category` column entirely (untagged -> looked like chat)
  //  - 47 more were typed into the chat box and so were tagged 'chat'
  // Without this, 59 of 62 rows on the chat-only page were commands.
  // Trade-off accepted: a human chatting "@336b are you there?" also reads as a
  // command — but addressing a node by hex suffix IS the command convention here.
  if (typeof text === 'string' && ADDRESSED_CMD.test(text)) return 'command';

  // Outbound wins: ping is a command sub-type.
  if (category === 'chat') return 'chat';
  if (category === 'command' || category === 'ping') return 'command';

  // Received: a JSON payload carries a `type`; plain text is chat.
  if (typeof text === 'string' && text.startsWith('{')) {
    let type;
    try { type = JSON.parse(text).type; } catch { return 'chat'; }
    if (ALARM_TYPES.has(type))  return 'alarm';
    if (CAMERA_TYPES.has(type)) return 'camera';
    if (DIAG_TYPES.has(type))   return 'diagnostics';
    return 'command';           // pong + every other machine-JSON type
  }
  return 'chat';
}
