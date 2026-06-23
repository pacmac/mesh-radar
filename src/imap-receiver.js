// Inbound email receiver — polls the gateway mailbox via IMAP (Mailcow/Dovecot).
// Parses replies to alert emails and forwards the reply text to the mesh as messages.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getConfig, consumeReplyToken } from './db.js';

const POLL_INTERVAL_MS = 60_000;
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://localhost:8001';

let _pollTimer = null;
let _client    = null;
let _running   = false;

function getImapConfig() {
  return {
    host: getConfig('alerts.imap_host', ''),
    port: getConfig('alerts.imap_port', 993),
    user: getConfig('alerts.smtp_user', ''),
    pass: getConfig('alerts.smtp_pass', ''),
  };
}

export function startImapReceiver() {
  _pollTimer = setInterval(pollInbox, POLL_INTERVAL_MS);
}

export function stopImapReceiver() {
  clearInterval(_pollTimer);
  _client?.close().catch(() => {});
  _client = null;
}

async function pollInbox() {
  if (_running) return;
  const cfg = getImapConfig();
  if (!cfg.host || !cfg.user) return;
  _running = true;
  try {
    await _processInbox(cfg);
  } catch (e) {
    console.error('[imap] poll error:', e.message);
  } finally {
    _running = false;
  }
}

async function _processInbox(cfg) {
  const client = new ImapFlow({
    host:   cfg.host,
    port:   cfg.port,
    secure: cfg.port === 993,
    auth:   { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ seen: false });
      if (!uids.length) return;

      for await (const msg of client.fetch(uids, { source: true })) {
        try {
          await _handleMessage(msg);
        } catch (e) {
          console.error('[imap] message handler error:', e.message);
        }
        // Mark as seen regardless — avoid reprocessing on next poll
        await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function _handleMessage(rawMsg) {
  const parsed = await simpleParser(rawMsg.source);

  // Extract reply token from Subject or Message-ID threading
  const subject = parsed.subject || '';
  const tokenMatch = subject.match(/\[reply:([0-9a-f-]{36})\]/i)
    || (parsed.references || '').match(/reply-([0-9a-f-]{36})/i)
    || (parsed.inReplyTo  || '').match(/reply-([0-9a-f-]{36})/i);

  if (!tokenMatch) return; // not a reply to one of our alerts

  const token = tokenMatch[1];
  const ctx   = consumeReplyToken(token);
  if (!ctx) {
    console.warn('[imap] reply token not found or expired:', token);
    return;
  }

  const replyText = _extractReplyBody(parsed.text || '');
  if (!replyText.trim()) {
    console.warn('[imap] empty reply body after stripping quotes');
    return;
  }

  const body = {
    text:     replyText.trim().slice(0, 228), // Meshtastic max payload
    channel:  ctx.channel ?? 0,
  };
  if (ctx.to_num && ctx.to_num !== 0xffffffff) body.to = ctx.to_num;
  if (ctx.reply_id) body.reply_id = ctx.reply_id;

  const url = `${BRIDGE_URL}/${ctx.from_node_id}/messages`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '?');
    console.error(`[imap] failed to send reply: ${res.status} ${err}`);
  } else {
    console.log(`[imap] reply sent from ${ctx.from_node_id} → ${ctx.to_num?.toString(16)}: "${replyText.trim().slice(0, 40)}…"`);
  }
}

// Strip quoted lines (lines starting with >) and the standard "On ... wrote:" line.
function _extractReplyBody(text) {
  const lines = text.split('\n');
  const out   = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>')) continue;
    // "On Mon, 23 Jun 2026 at 16:00, mesh@... wrote:" and similar
    if (/^On .+ wrote:$/i.test(trimmed)) continue;
    out.push(line);
  }
  // Trim trailing blank lines
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n').trim();
}
