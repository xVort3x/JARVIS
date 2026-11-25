import assert from 'node:assert/strict';
import { AWARE_DEFAULT_EXCLUSIONS, awareMode, cleanExclusion, excluded, exclusionsOf, hashShot, isLocked, mayLook, screenLine } from '../aware.mjs';

// Lock screen: never seen, never captured, whatever the settings say.
assert.ok(isLocked({ app: 'LogonUI', exe: 'logonui.exe', title: 'Sign in' }));
assert.ok(isLocked(null), 'no front window at all counts as locked');
assert.ok(isLocked({}), 'a front window without a name counts as locked');
assert.ok(isLocked({ app: 'consent', exe: 'consent.exe' }), 'UAC is a lock-screen surface');
assert.ok(!isLocked({ app: 'Code', exe: 'Code.exe', title: 'focus.mjs' }));

// Exclusions: apps, exe names and title substrings, case-insensitively.
assert.deepEqual(exclusionsOf({}), AWARE_DEFAULT_EXCLUSIONS, 'the defaults apply until one is added');
assert.deepEqual(exclusionsOf({ awareExclusions: ['my bank'] }), ['my bank']);
assert.deepEqual(exclusionsOf({ awareExclusions: [] }), [], 'empty list excludes nothing; the user chose that');
assert.equal(excluded({ app: '1Password', exe: '1password.exe', title: 'Passwords' }, exclusionsOf({})), '1password');
assert.equal(excluded({ app: 'Google Chrome', exe: 'chrome.exe', title: 'InPrivate window' }, exclusionsOf({})), 'InPrivate');
assert.equal(excluded({ app: 'Code', exe: 'Code.exe', title: 'focus.mjs' }, exclusionsOf({})), null);
assert.equal(excluded({ app: '1Password' }, ['my bank']), null, 'the user list replaces the defaults');

// mayLook: locked or excluded is off limits, whoever asks.
assert.equal(mayLook(null, {}).ok, false);
assert.equal(mayLook({ app: 'LogonUI', exe: 'logonui.exe' }, {}).ok, false);
assert.equal(mayLook({ app: '1Password' }, {}).ok, false);
assert.equal(mayLook({ app: 'Code', exe: 'Code.exe' }, {}).ok, true);

// The always-in-context line: only while AA is on, never private, locked or excluded.
assert.equal(screenLine({ app: 'Code', exe: 'Code.exe', title: 'focus.mjs' }, { alwaysAware: false }), '');
assert.equal(screenLine({ app: 'Code' }, { alwaysAware: true, awarePrivate: true }), '');
assert.equal(screenLine({ app: 'Code', exe: 'Code.exe', title: 'focus.mjs' }, { alwaysAware: true }), "- Right now they're in Code — \"focus.mjs\". This was just checked and overrides any app or page from earlier messages; they can still ask about something elsewhere.");
assert.equal(screenLine({ app: 'Code', exe: 'Code.exe', title: 'focus.mjs' }, { alwaysAware: true, awareMode: 'screen' }), "- Right now they're on the whole screen — \"focus.mjs\". This was just checked and overrides any app or page from earlier messages; they can still ask about something elsewhere.");
assert.equal(screenLine({ app: 'LogonUI', exe: 'logonui.exe' }, { alwaysAware: true }), '');
assert.equal(screenLine({ app: '1Password' }, { alwaysAware: true }), '');
assert.equal(screenLine({ app: 'Code', exe: 'Code.exe', title: 'x' }, { alwaysAware: true, awareExclusions: ['co'] }), '', 'the user list filters too');

assert.equal(cleanExclusion('  my   bank  '), 'my bank');
assert.equal(cleanExclusion('a'), null);
assert.equal(cleanExclusion('x'.repeat(61)), null);

const h1 = hashShot(Buffer.from('hello')), h2 = hashShot(Buffer.from('hello')), h3 = hashShot(Buffer.from('hellO'));
assert.equal(h1, h2); assert.notEqual(h1, h3);

assert.equal(awareMode({}), 'front');
assert.equal(awareMode({ awareMode: 'screen' }), 'screen');
assert.equal(awareMode({ awareMode: 'bogus' }), 'front');
console.log('aware tests: passed');
