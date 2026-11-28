import assert from 'node:assert/strict';
import { OPENROUTER_API, OPENROUTER_DEFAULT_VOICE, OPENROUTER_MODELS, OPENROUTER_MODEL, OPENROUTER_PACE, OPENROUTER_RATE, OPENROUTER_VOICES, OpenRouterVoice, openrouterAccount, speechRequest } from '../openrouter.mjs';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);

assert.equal(OPENROUTER_DEFAULT_VOICE, 'gareth');
assert.ok(OPENROUTER_VOICES.some((v) => v.id === 'gareth'));
assert.equal(OPENROUTER_RATE, 24000);
assert.equal(OPENROUTER_PACE, null);

assert.deepEqual(speechRequest('Hi.', { voice: 'gareth' }), { model: OPENROUTER_MODEL, input: 'Hi.', voice: 'gareth', response_format: 'pcm' });
assert.deepEqual(speechRequest('Hi.'), { model: OPENROUTER_MODEL, input: 'Hi.', voice: OPENROUTER_DEFAULT_VOICE, response_format: 'pcm' });

{ // One sentence, one request, its audio in, out.
  const got = { audio: [], ended: 0, errors: [] }, calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200, arrayBuffer: async () => bytes }; };
  const v = new OpenRouterVoice({ key: 'sk-or-test', fetchImpl, onAudio: (a) => got.audio.push([...a]), onEnd: () => got.ended++, onError: (e) => got.errors.push(e) });
  v.say('One.'); v.end(); await tick(20);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${OPENROUTER_API}/audio/speech`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-or-test');
  assert.equal(calls[0].body.model, OPENROUTER_MODEL);
  assert.equal(calls[0].body.response_format, 'pcm');
  assert.equal(calls[0].body.input, 'One.');
  assert.ok(calls[0].body.voice);
  assert.equal('instructions' in calls[0].body, false);
  assert.deepEqual(got.audio, [[1, 2, 3, 4, 5, 6]]);
  assert.equal(got.ended, 1);
  assert.equal(got.errors.length, 0);
}
{ // Voice cues are stripped (HeyGen reads them out otherwise); audio in order.
  const got = { audio: [], ended: 0, errors: [] }, calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200, arrayBuffer: async () => bytes }; };
  const v = new OpenRouterVoice({ key: 'sk-or-test', fetchImpl, onAudio: (a) => got.audio.push([...a]), onEnd: () => got.ended++, onError: (e) => got.errors.push(e) });
  v.say('[warm] One.'); v.say('Two.'); v.end(); await tick(40);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.input, 'One.');
  assert.equal(calls[1].body.input, 'Two.');
  assert.deepEqual(got.audio, [[1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]]);
  assert.equal(got.ended, 1);
  assert.equal(got.errors.length, 0);
}
{ // A lone cue or punctuation: end() reports done without asking OpenRouter for anything.
  const got = { audio: [], ended: 0, errors: [] }, calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, arrayBuffer: async () => bytes }; };
  const v = new OpenRouterVoice({ key: 'sk-or-test', fetchImpl, onAudio: (a) => got.audio.push([...a]), onEnd: () => got.ended++, onError: (e) => got.errors.push(e) });
  v.say('[warm]'); v.say('…'); v.end(); await tick(20);
  assert.equal(calls.length, 0);
  assert.equal(got.ended, 1);
}
{ // Refused (an unknown voice is a 400 too): the reason and the status.
  const got = { audio: [], ended: 0, errors: [] };
  const v = new OpenRouterVoice({ key: 'sk-or-test', fetchImpl: async () => ({ ok: false, status: 400, text: async () => '{"error":{"message":"No matching speaker voice found for name: Nope","code":"invalid_request"}}' }), onAudio: (a) => got.audio.push([...a]), onEnd: () => got.ended++, onError: (e) => got.errors.push(e) });
  v.say('Hi.'); await tick(20);
  assert.equal(got.errors.length, 1);
  assert.match(got.errors[0].message, /No matching speaker voice/);
  assert.equal(got.errors[0].status, 400); assert.equal(got.errors[0].heard, false); assert.equal(got.ended, 0);
}
{ // Too many requests.
  const got = { audio: [], ended: 0, errors: [] };
  const v = new OpenRouterVoice({ key: 'sk-or-test', fetchImpl: async () => ({ ok: false, status: 429, text: async () => '{"error":{"message":"Rate limit reached"}}' }), onAudio: (a) => got.audio.push([...a]), onEnd: () => got.ended++, onError: (e) => got.errors.push(e) });
  v.say('Hi.'); await tick(20);
  assert.match(got.errors[0].message, /rate limiting/); assert.equal(got.errors[0].status, 429);
}
{ // A reply that ends without any audio is a failure.
  const got = { audio: [], ended: 0, errors: [] };
  const v = new OpenRouterVoice({ key: 'sk-or-test', fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(0) }), onAudio: (a) => got.audio.push([...a]), onEnd: () => got.ended++, onError: (e) => got.errors.push(e) });
  v.say('Hi.'); v.end(); await tick(20);
  assert.match(got.errors[0].message, /no audio/); assert.equal(got.ended, 0);
}
{ // The network failing.
  const got = { audio: [], ended: 0, errors: [] };
  const v = new OpenRouterVoice({ key: 'sk-or-test', fetchImpl: async () => { throw new Error('offline'); }, onAudio: (a) => got.audio.push([...a]), onEnd: () => got.ended++, onError: (e) => got.errors.push(e) });
  v.say('Hi.'); await tick(20);
  assert.equal(got.errors[0].message, 'offline');
}

const fake = (status, left = null) => async (url, init) => { fake.last = { url, init }; return { status, ok: status >= 200 && status < 300, json: async () => ({ data: { limit_remaining: left } }) }; };
assert.deepEqual(await openrouterAccount('k', { fetchImpl: fake(200) }), { ok: true, credit: null });
assert.deepEqual(await openrouterAccount('k', { fetchImpl: fake(200, 4.5) }), { ok: true, credit: 4.5 });
assert.equal(fake.last.url, `${OPENROUTER_API}/key`);
assert.equal(fake.last.init.headers.authorization, 'Bearer k');
assert.deepEqual(await openrouterAccount('k', { fetchImpl: fake(401) }), { ok: false, reason: 'key' });
assert.deepEqual(await openrouterAccount('k', { fetchImpl: fake(503) }), { ok: false, reason: 'network' });
assert.deepEqual(await openrouterAccount('k', { fetchImpl: async () => { throw new Error('offline'); } }), { ok: false, reason: 'network' });

console.log('openrouter tests passed');
