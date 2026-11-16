// Layered memory: preferences (how they like Jarvis to work), session summaries (what a conversation was about),
// usage-weighted fact eviction. Runs against a throwaway HOME. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-memory-test-'));
process.env.HOME = TMP; process.env.USERPROFILE = TMP;
const STORE = new URL('../store.mjs', import.meta.url).href;
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const S = await import(STORE);

// ---------- preferences ----------
assert.deepEqual(S.listPreferences(), [], 'no preferences yet');
await S.addPreference('Wants the answer first, then the detail');
await S.addPreference('  Runs   tests before calling anything done ');
await S.addPreference('Prefers PowerShell over bash');
assert.equal(S.listPreferences().length, 3);
// Same one again: updated in place, not duplicated.
await S.addPreference('wants the answer first, then the detail');
assert.equal(S.listPreferences().length, 3, 'dedup by normalized text');
const first = S.listPreferences().find((p) => /answer first/i.test(p.text));
assert.ok(first, 'normalisation survives case and spacing');
// Forget and clear.
await S.forgetPreference(S.listPreferences()[0].id);
assert.equal(S.listPreferences().length, 2, 'forgot one');
await S.clearPreferences();
assert.deepEqual(S.listPreferences(), [], 'cleared');

// ---------- session summaries (episodic memory) ----------
const sess = S.newSession('anthropic', 'claude-haiku-5-5');
sess.messages = [{ role: 'user', content: 'help me debug the rust build' }];
await S.saveSession(sess);
const at = Date.now() - 864e5;
await S.saveSessionSummary(sess.id, 'Debugging their Rust build', at);
const summaries = S.listSessionSummaries();
assert.ok(summaries.some((s) => s.id === sess.id && s.digest === 'Debugging their Rust build'));
// A digest for a fake id is refused.
assert.equal(await S.saveSessionSummary('not-an-id', 'whatever'), null);
// Forget deletes the digest and the raw session, so the conversation is really gone.
await S.forgetSession(sess.id);
assert.equal(S.listSessionSummaries().some((s) => s.id === sess.id), false, 'digest deleted');
assert.equal(fs.existsSync(path.join(S.DIR, 'sessions', `${sess.id}.json`)), false, 'transcript deleted');

// ---------- search past conversations ----------
const a = { ...S.newSession('anthropic', 'm'), id: '20261110-093000-aaaaaa' };
a.messages = [{ role: 'user', content: 'picked postgres for the website backend' }, { role: 'assistant', content: 'good choice' }];
a.lastActiveAt = Date.parse('2026-11-10T09:31:00');
const b = { ...S.newSession('anthropic', 'm'), id: '20261112-143000-bbbbbb' };
b.messages = [{ role: 'user', content: 'the rust build fails with a linker error' }, { role: 'assistant', content: 'try -fuse-ld=lld' }];
b.lastActiveAt = Date.parse('2026-11-12T14:31:00');
for (const s of [a, b]) await S.saveSession(s);
const hits = S.searchSessions('rust linker');
assert.ok(hits.length >= 1 && hits[0].id === b.id, 'search finds the conversation about the linker');
assert.ok(hits[0].snippet.length > 0, 'carries a snippet');
const hitsFrom = S.searchSessions('postgres', { from: Date.parse('2026-11-11T00:00') });
assert.equal(hitsFrom.length, 0, 'from filters out older conversations');
const hitsLimit = S.searchSessions('a', { limit: 1 });
assert.equal(hitsLimit.length <= 1, true);

// ---------- usage-weighted fact eviction ----------
const facts = [];
for (let i = 0; i < 150; i++) {
  const f = await S.addFact(`fact number ${i} about the project`);
  facts.push({ ...f, createdAt: Date.now() - 864e5 * (150 - i) });
}
// The oldest facts are the least used; touch one of them constantly and it must survive the next insert.
await S.touchFacts([facts[10].id]);
const before = S.listFacts().length;
assert.equal(before, 150, 'cap is 150');
await S.addFact('one more fact');
const ids = S.listFacts().map((f) => f.id);
assert.ok(ids.includes(facts[10].id), 'a recently used fact survives eviction');
assert.equal(S.listFacts().length, 150, 'still capped');

console.log('layered memory tests: passed');
