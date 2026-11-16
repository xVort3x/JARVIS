// The wake word's name: what can be saved, and why not. Run: npm test
import assert from 'node:assert/strict';
import { cleanWakeName, wakeName } from '../wakename.mjs';

assert.deepEqual(cleanWakeName('Jarvis'), { ok: true, name: '' }, 'its own name: back to the default');
assert.deepEqual(cleanWakeName('  jarvis '), { ok: true, name: '' });
assert.deepEqual(cleanWakeName('Hey Jarvis'), { ok: true, name: '' }, 'the greeting is dropped');
assert.deepEqual(cleanWakeName('hi, NOVA'), { ok: true, name: 'Nova' });
assert.equal(cleanWakeName('Zoë').ok, false, 'under 4 letters');
assert.deepEqual(cleanWakeName('Chloë'), { ok: true, name: 'Chloë' }, 'letters beyond English');
assert.deepEqual(cleanWakeName(''), { ok: true, name: '' }, 'empty: back to Jarvis');
assert.deepEqual(cleanWakeName('Echo'), { ok: true, name: 'Echo' }, 'Echo is now just another name');
assert.deepEqual(cleanWakeName('echo'), { ok: true, name: 'Echo' });
for (const bad of ['Bob', 'Mr Jarvis', 'R2D2', 'Jar-vis', 'okay', 'Alexa', 'x'.repeat(21)]) {
  const r = cleanWakeName(bad);
  assert.equal(r.ok, false, `${bad} is refused`);
  assert.ok(r.why.length > 5, 'with a reason');
}
assert.equal(wakeName({}), 'Jarvis');
assert.equal(wakeName({ wakeName: 'Nova' }), 'Nova');
console.log('wake name tests: passed');
