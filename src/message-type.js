// The single classifier that maps a message-feed row to one of 5 display buckets
// for the message-feed type filter. Server-side only; the browser renders the
// pushed bucket and never re-derives it (BROWSER_CONTRACT). See
// docs/modules/message-type.md.

export const MESSAGE_BUCKETS = ['chat', 'command', 'alarm', 'camera', 'diagnostics'];

// Received JSON `type` → bucket. Anything not listed here that is still machine
// JSON (pong, status, config, and the command verbs/replies) falls through to
// 'command'; only human plain text is 'chat'.
const ALARM_TYPES  = new Set(['detect', 'alarm', 'cleared', 'env', 'wedge']);
const CAMERA_TYPES = new Set(['cam', 'chunk']);
const DIAG_TYPES   = new Set(['diag', 'ext']);

// category is the outbound tag (chat/command/ping) or null for received.
// text is the message body.
export function messageBucket(category, text) {
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
