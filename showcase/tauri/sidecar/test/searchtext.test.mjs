// The native content search used when ripgrep and grep aren't installed (Windows). Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { searchText } from '../tools.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-search-'));
await fs.mkdir(path.join(dir, 'notes'));
await fs.writeFile(path.join(dir, 'notes', 'a.txt'), 'first\nhere is the needle\nlast\n');
await fs.writeFile(path.join(dir, 'notes', 'b.bin'), 'needle\0binary');
assert.match(await searchText(dir, 'needle'), /a\.txt:2: here is the needle/);
assert.ok(!/b\.bin/.test(await searchText(dir, 'needle')), 'binary files are skipped');
assert.equal(await searchText(dir, 'absent'), 'No matches.');
await assert.rejects(searchText(dir, '('), /valid regular expression/);
await fs.rm(dir, { recursive: true, force: true });
console.log('native search tests: passed');
