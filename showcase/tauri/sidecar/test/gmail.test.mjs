// Gmail bridge: read, search, reply framing, with fakes (no network). Run: npm test
import assert from 'node:assert/strict';
import { createGmail } from '../gmail.mjs';

const source = Buffer.from('From: Ally <ally@example.com>\nTo: kiankomingoi@gmail.com\nDate: Tue, 18 Nov 2026 09:30:00 +0000\nSubject: Hi\nMessage-ID: <m123>\nReferences: <ref1>\nContent-Type: text/plain; charset=utf-8\n\nThe code is TOKEN9X.', 'utf8');

class FakeImap {
  static last;
  constructor(o) { this.o = o; FakeImap.last = this; this.mailbox = { exists: 3 }; this.searched = []; }
  async connect() { if (this.o.auth?.pass !== 'pass') throw new Error('auth failed'); }
  async getMailboxLock() { return { release: () => {} }; }
  async search(criteria) { this.searched.push(criteria); return criteria[1] === 'TOKEN9X' ? [2] : [1, 2, 3]; }
  async fetchAll(range, parts) {
    const base = [{ uid: 1, flags: new Set(['\\Seen']), envelope: { subject: 'One', from: [{ name: 'A', address: 'a@x' }], date: new Date('2026-11-17T10:00:00Z') } },
                  { uid: 2, flags: new Set(), envelope: { subject: 'Two', from: [{ address: 'b@y' }], date: new Date('2026-11-18T09:30:00Z') } }];
    return String(range) === '2' ? [base[1]] : base;
  }
  async fetchOne() { return { source: Buffer.from(source) }; }
  async logout() {}
}
const sent = [];
const gmail = createGmail({
  email: 'test@gmail.com',
  password: 'pass',
  Imap: FakeImap,
  smtp: () => ({ sendMail: async (m) => { sent.push(m); return { messageId: 'ok' }; } }),
  parse: async () => ({ from: { address: 'ally@example.com', name: 'Ally' }, subject: 'Hi', messageId: '<m123>', headers: { get: (k) => (k === 'references' ? '<ref1>' : '') }, text: 'The code is TOKEN9X.', date: '2026-11-18T09:30:00Z' }),
});

{
  const out = await gmail.inbox({ count: 2 });
  assert.match(out, /One — A — /);
  assert.match(out, /Two — b@y — /);
  assert.ok(FakeImap.last.searched.length === 0, 'plain inbox needs no search');
}
{
  const out = await gmail.search({ query: 'TOKEN9X' });
  assert.match(out, /Two — b@y/);
}
{
  const out = await gmail.read({ id: 2 });
  assert.match(out, /Subject: Hi/);
  assert.match(out, /TOKEN9X/);
}
{
  const out = await gmail.sendMessage({ to: 'ally@example.com', subject: 's', body: 'b' });
  assert.match(out, /Sent/);
  assert.equal(sent[0].to, 'ally@example.com');
  assert.equal(sent[0].subject, 's');
}
{
  const out = await gmail.reply({ id: 2, body: 'yes, it worked' });
  assert.match(out, /Sent/);
  assert.equal(sent.at(-1).subject, 'Re: Hi', 'reply keeps the thread subject');
  assert.equal(sent.at(-1).headers['In-Reply-To'], '<m123>', 'reply threads by message id');
  assert.equal(sent.at(-1).headers.References, '<ref1> <m123>', 'reply carries the reference chain');
}
console.log('gmail tests: passed');
