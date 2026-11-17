// The newest files first: "what is my latest download?" is one local call. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../tools.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-recent-'));
const write = async (name, secondsAgo, bytes) => {
  const p = path.join(dir, name);
  await fs.writeFile(p, 'x'.repeat(bytes));
  const t = Date.now() / 1000 - secondsAgo;
  await fs.utimes(p, t, t);
};
await write('old.txt', 86400, 10);
await write('new.pdf', 60, 2_000_000);
await write('mid.zip', 3600, 5);

const noop = async () => {};
const { tools } = createTools({ allowActions: false, ui: () => {}, ask: noop, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '', userName: 'Test' });
const recent = tools.find((t) => t.name === 'recent_files');
assert.ok(recent, 'recent_files is a tool');

const lines = (await recent.execute({ dir }, {})).split('\n');
assert.match(lines[0], /^Newest in /);
assert.match(lines[1], /^new\.pdf\t/);
assert.match(lines[2], /^mid\.zip\t/);
assert.match(lines[3], /^old\.txt\t/);
assert.match(lines[1], /2\.0 MB/);
assert.match(lines[3], /10 B/);
assert.equal((await recent.execute({ dir, limit: 2 }, {})).split('\n').length, 3, 'limit caps the list');
await assert.rejects(recent.execute({ dir: path.join(dir, 'missing') }, {}), /no folder/);
await fs.rm(dir, { recursive: true, force: true });
console.log('recent files tests: passed');
