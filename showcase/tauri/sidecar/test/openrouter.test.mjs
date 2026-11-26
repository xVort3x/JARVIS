import assert from 'node:assert/strict';
import { OPENROUTER_API, OPENROUTER_DEFAULT_VOICE, OPENROUTER_MODELS, OPENROUTER_MODEL, OPENROUTER_PACE, OPENROUTER_RATE, OPENROUTER_PITCH, OPENROUTER_VOICES, OpenRouterVoice, openrouterAccount, speechRequest } from '../openrouter.mjs';
import { GEMINI_LOOK_VOICES, GEMINI_VOICES } from '../gemini.mjs';
import { createSpeaker, PROVIDERS } from '../speaker.mjs';
import { CUE } from '../speech.mjs';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);

// The voices are Gemini's, with J.A.R.V.I.S's (the jarvis look) as the default.
assert.deepEqual(OPENROUTER_VOICES, GEMINI_VOICES);
assert.equal(OPENROUTER_DEFAULT_VOICE, GEMINI_LOOK_VOICES.jarvis);
assert.ok(GEMINI_VOICES.some((x) => x.id === OPENROUTER_DEFAULT_VOICE));
assert.equal(OPENROUTER_RATE, 24000);

// The request: the documented shape, raw PCM, no style note when there's no cue.
assert.deepEqual(speechRequest('Hi.', { voice: 'Kore', instructions: 'warm, speaking quickly' }), { model: OPENROUTER_MODEL, input: 'Hi.', voice: 'Kore', response_format: 'pcm', instructions: 'warm, speaking quickly' });
assert.deepEqual(speechRequest('Hi.'), { model: OPENROUTER_MODEL, input: 'Hi.', voice: OPENROUTER_DEFAULT_VOICE, response_format: 'pcm' });
assert.equal(OPENROUTER_MODELS.length, 1);
assert.equal(OPENROUTER_MODELS[0], OPENROUTER_MODEL);

{ // One sentence, one request, its audio in, out; the next sentence waits its turn.
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
  assert.deepEqual(got.audio, [[1, 2, 3, 4, 5, 6]]);
  assert.equal(got.ended, 1);
  assert.equal(got.errors.length, 0);
}
{ // Two sentences: both asked, in the order said, and the audio comes out in that order.
  const got = { audio: [], ended: 0, errors: [] }, calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200, arrayBuffer: async () => bytes }; };
  const v = new OpenRouterVoice({ key: 'sk-or-test', fetchImpl, onAudio: (a) => got.audio.push([...a]), onEnd: () => got.ended++, onError: (e) => got.errors.push(e) });
  v.say('[warm] One.'); v.say('Two.'); v.end(); await tick(40);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.input, 'One.');
  assert.equal(calls[0].body.instructions, 'warm, speaking quickly');
  assert.equal(calls[1].body.input, 'Two.');
  assert.equal(calls[1].body.instructions, OPENROUTER_PACE);
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
{ // Refused (an unknown voice is a 400 too, so the voice doesn't call it a key problem): the reason and the status.
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
{ // A reply that ends without any audio is a failure, not a silent success.
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

// The key check: a bad key is an OpenRouter 401, anything else that fails is the network. Never throws.
const fake = (status, left = null) => async (url, init) => { fake.last = { url, init }; return { status, ok: status >= 200 && status < 300, json: async () => ({ data: { limit_remaining: left } }) }; };
assert.deepEqual(await openrouterAccount('k', { fetchImpl: fake(200) }), { ok: true, credit: null });
assert.deepEqual(await openrouterAccount('k', { fetchImpl: fake(200, 4.5) }), { ok: true, credit: 4.5 });
assert.equal(fake.last.url, `${OPENROUTER_API}/key`);
assert.equal(fake.last.init.headers.authorization, 'Bearer k');
assert.deepEqual(await openrouterAccount('k', { fetchImpl: fake(401) }), { ok: false, reason: 'key' });
assert.deepEqual(await openrouterAccount('k', { fetchImpl: fake(503) }), { ok: false, reason: 'network' });
assert.deepEqual(await openrouterAccount('k', { fetchImpl: async () => { throw new Error('offline'); } }), { ok: false, reason: 'network' });

// The speaker routes through OpenRouter: no key, no voice; with one, it starts on its voice and model.
{
  const made = [];
  const FakeVoice = class { constructor(o) { Object.assign(this, o); this.said = []; this.ended = false; made.push(this); } open() { return this; } say(s) { this.said.push(s); } end() { this.ended = true; } abort() {} };
  const out = [], problems = [];
  const sp = createSpeaker({ emit: (m) => out.push(m), onProblem: (p) => problems.push(p), FishVoiceImpl: FakeVoice, account: async () => ({ ok: true, credit: 4.5 }),
    providers: { openrouter: { ...PROVIDERS.openrouter, Voice: FakeVoice, account: async () => ({ ok: true, credit: 4.5 }), warmDelay: 0 } }, beatPhrases: [], bundled: () => null });
  assert.equal(sp.provider, 'fish');
  sp.setProvider('openrouter');
  assert.equal(sp.provider, 'openrouter'); assert.equal(sp.on, false, "the other service's key isn't carried over");
  assert.equal(sp.start(), null);
  sp.setKey('or-key'); sp.setVoice('Puck'); await tick(); await tick();
  assert.equal(sp.provider, 'openrouter');
  const r = sp.start();
  const v = made[0];
  assert.equal(v.key, 'or-key'); assert.equal(v.voice, 'Puck'); assert.equal(v.model, OPENROUTER_MODEL);
  v.onAudio(new Uint8Array([1, 0]));
  assert.equal(out.at(-1).rate, Math.round(OPENROUTER_RATE * OPENROUTER_PITCH));
}

console.log('openrouter tests passed');
