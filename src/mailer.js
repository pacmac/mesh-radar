// Email delivery via nodemailer. SMTP credentials read from config table on
// each send so credentials update without a restart.
import { getConfig } from './db.js';

let _nodemailer = null;
async function getMailer() {
  if (!_nodemailer) _nodemailer = (await import('nodemailer')).default;
  return _nodemailer;
}

function getSmtpConfig() {
  return {
    host: getConfig('alerts.smtp_host', ''),
    port: getConfig('alerts.smtp_port', 587),
    user: getConfig('alerts.smtp_user', ''),
    pass: getConfig('alerts.smtp_pass', ''),
    from: getConfig('alerts.smtp_from', ''),
    to:   getConfig('alerts.smtp_to',   ''),
  };
}

export async function sendAlert(type, subject, body, _opts = {}) {
  const cfg = getSmtpConfig();
  if (!cfg.host || !cfg.to) {
    console.warn(`[mailer] SMTP not configured — skipping alert "${type}"`);
    return;
  }
  const nm = await getMailer();
  const transport = nm.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  await transport.sendMail({
    from:    cfg.from || cfg.user,
    to:      cfg.to,
    subject,
    text:    body,
  });
}

export async function sendTestAlert() {
  const cfg = getSmtpConfig();
  if (!cfg.host || !cfg.to) throw new Error('SMTP not configured');
  await sendAlert('test', '[mesh] Test alert', `This is a test alert from mesh-radar.\n\nSMTP: ${cfg.host}:${cfg.port}\nFrom: ${cfg.from || cfg.user}\nTo: ${cfg.to}`);
}
