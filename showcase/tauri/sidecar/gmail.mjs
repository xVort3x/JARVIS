// Gmail: reading over IMAP and sending over SMTP, with the user's own 16-character app password.
// Nothing is logged here — a message body may contain a verification code.
import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import PostalMime from 'postal-mime';

const clip = (s, n = 6000) => (s.length > n ? `${s.slice(0, n)}\n…(${s.length - n} more characters)` : s);

/** A pre-filled shape: { email (string or getter), password (string or getter) } — used in tests and setup. */
export function createGmail({ email, password, Imap = ImapFlow, smtp = createTransport, parse = PostalMime.parse } = {}) {
  const emailNow = () => (typeof email === 'function' ? email() : email);
  const creds = async () => ({ email: emailNow(), password: typeof password === 'function' ? await password() : password });

  async function open() {
    const { email: e, password: p } = await creds();
    if (!p) throw new Error('Set up Gmail first — ask me to connect Gmail.');
    const c = new Imap({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: e, pass: p }, logger: false, connectionTimeout: 15_000, socketTimeout: 60_000 });
    await c.connect();
    return c;
  }
  const line = (m) => {
    const unread = m.flags?.has?.('\\Seen') ? ' ' : '●';
    const from = (m.envelope?.from ?? []).map((f) => f.name || f.address).join(', ');
    const date = new Date(m.envelope?.date ?? Date.now()).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `${m.uid} ${unread} ${String(m.envelope?.subject ?? '(no subject)').slice(0, 80)} — ${from} — ${date}`;
  };
  const normaliseText = (m) => {
    if (m?.text?.trim()) return m.text;
    if (m?.html) return clip(String(m.html).replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    return '(no text content)';
  };

  async function inbox({ count = 10, unread = false } = {}) {
    const c = await open();
    const lock = await c.getMailboxLock('INBOX');
    try {
      const total = c.mailbox?.exists ?? 0;
      if (!total) return 'Inbox is empty.';
      const n = Math.min(Math.max(Number(count) || 10, 1), 30);
      const ids = unread ? await c.search(['UNSEEN']) : [`${Math.max(1, total - n + 1)}:*`];
      const msgs = await c.fetchAll(ids.slice(-n).join(','), { envelope: true, flags: true });
      return msgs.map(line).join('\n') || 'No unread mail.';
    } finally { lock.release(); await c.logout(); }
  }
  async function search({ query }) {
    const c = await open();
    const lock = await c.getMailboxLock('INBOX');
    try {
      const ids = await c.search(['ALL', 'TEXT', String(query)]);
      if (!ids?.length) return `No mail matching "${query}".`;
      const msgs = await c.fetchAll(ids.slice(-10).join(','), { envelope: true, flags: true });
      return msgs.map(line).join('\n');
    } finally { lock.release(); await c.logout(); }
  }
  async function read({ id }) {
    const c = await open();
    const lock = await c.getMailboxLock('INBOX');
    try {
      const msg = await c.fetchOne(String(id), { source: true });
      if (!msg) return `No message ${id}.`;
      const m = await parse(msg.source);
      const from = (m.from?.address ?? (msg.envelope?.from ?? []).map((f) => f.address).join(', ')) || '(unknown sender)';
      const date = m.date ? new Date(m.date).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';
      return `From: ${m.from?.name || from}\nDate: ${date}\nSubject: ${m.subject ?? '(no subject)'}\n\n${clip(normaliseText(m))}`;
    } finally { lock.release(); await c.logout(); }
  }
  async function sendMessage({ to, subject, body }) {
    const { email: e, password: p } = await creds();
    const t = smtp({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: e, pass: p } });
    const info = await t.sendMail({ from: e, to, subject, text: body });
    return `Sent (${info.messageId ?? 'ok'}).`;
  }
  async function reply({ id, body }) {
    const c = await open();
    const lock = await c.getMailboxLock('INBOX');
    let source = null;
    try { source = (await c.fetchOne(String(id), { source: true }))?.source ?? null; } finally { lock.release(); await c.logout(); }
    let headers = '', subject = '(no subject)', to = '', refs = '', msgId = '';
    if (source) {
      const m = await parse(source);
      const from = m.from?.address ?? m.sender?.address ?? '';
      to = from ? from : to;
      subject = /^re:/i.test(m.subject ?? '') ? m.subject : `Re: ${m.subject ?? ''}`;
      msgId = m.messageId ?? m.headers?.get?.('message-id') ?? '';
      refs = `${m.headers?.get?.('references') ?? ''} ${msgId}`.trim();
      headers = msgId ? { 'In-Reply-To': msgId, References: refs } : {};
    }
    const { email: e, password: p } = await creds();
    const t = smtp({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: e, pass: p } });
    const info = await t.sendMail({ from: e, to, subject, text: body, headers });
    return `Sent (${info.messageId ?? 'ok'}).`;
  }

  return { inbox, search, read, sendMessage, reply };
}
