// Provider health: a failed model cools down, a success clears it, and fallback skips what's down.
import assert from 'node:assert/strict';
import { createProviderHealth, pickFallback } from '../providerhealth.mjs';

let t = 1000;
const health = createProviderHealth({ cooldownMs: 100, now: () => t });
health.fail('anthropic:slow', 'no first token');
assert.equal(health.down('anthropic:slow'), true);
assert.equal(health.reason('anthropic:slow'), 'no first token');
assert.deepEqual(Object.keys(health.snapshot()), ['anthropic:slow']);

t += 101;
assert.equal(health.down('anthropic:slow'), false, 'the cooldown ends');
assert.equal(health.reason('anthropic:slow'), null);

health.fail('anthropic:slow', 'again');
t += 50;
health.ok('anthropic:slow');
assert.equal(health.down('anthropic:slow'), false, 'a success clears the failure');

const candidates = [
  { provider: 'anthropic', model: 'slow' },
  { provider: 'openai', model: 'fast' },
];
assert.deepEqual(pickFallback(candidates, health, candidates[0]), { provider: 'openai', model: 'fast' });
const down = createProviderHealth({ now: () => t });
down.fail('openai:fast', 'nope');
assert.equal(pickFallback(candidates, down, candidates[0]), null, 'nothing outside the cooldown');
assert.deepEqual(pickFallback([{ provider: 'anthropic', model: 'other' }], down, candidates[0]),
  { provider: 'anthropic', model: 'other' }, 'another model on the same provider is fine');

console.log('provider health tests: passed');
