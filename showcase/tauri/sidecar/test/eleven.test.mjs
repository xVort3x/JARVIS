import assert from 'node:assert/strict';
import { createSpeaker, PROVIDERS } from '../speaker.mjs';
import { ELEVEN_API, ELEVEN_LIVE, ELEVEN_MODELS, ELEVEN_MODEL, ELEVEN_RATE, ELEVEN_VOICES, ELEVEN_DEFAULT_VOICE, ElevenVoice, elevenAccount } from '../eleven.mjs';
import { CUE } from '../speech.mjs';

// A fake socket that records what was sent and lets the test play the server.
class FakeWS {
  static last;
  constructor(url, opts) { this.url = url; this.opts = opts; this.sent = []; this.readyState = 0; FakeWS.last = this; }
  send(b) { this.sent.push(JSON.parse(String(b))); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  server(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
}
const run = (opts = {}) => {
  const got = { audio: [], ended: 0, errors: [] };
  const v = new ElevenVoice({ key: 'xi-key', voice: 'vid', WebSocketImpl: FakeWS, onAudio: (a) => got.audio.push(a), onEnd: () => got.ended++, onError: (e) => got.errors.push(e), ...opts });
  return { v, got };
};

{ // The curated catalogue: most expressive first, the default in it, every pick is a real model.
  assert.ok(ELEVEN_MODELS.length >= 2);
  assert.ok(ELEVEN_MODELS.includes(ELEVEN_MODEL));
  assert.equal(ELEVEN_MODELS[0], 'eleven_v4');
}

{ // J.A.R.V.I.S's own voice is first in the list the user picks from.
  assert.deepEqual(ELEVEN_VOICES.map((v) => v.id), ['JBFqnCBsd6RMkjVDRZzb', '21mEOyWgAeX44s3Mkmmk', 'EXAVITQu4vr4xnSDxMaL']);
}

{ // The reply: an init, then each sentence's text and flush, then the close that ends the stream; audio in, PCM out.
  const { v, got } = run();
  v.open(); FakeWS.last.open();
  const ws = FakeWS.last;
  assert.equal(ws.url, `wss://api.elevenlabs.io/v1/text-to-speech/vid/stream-input?model_id=${ELEVEN_MODEL}&output_format=pcm_${ELEVEN_RATE}`);
  v.say('Sure, one sec.');
  v.say('It is 36.');
  v.end();
  assert.equal(ws.sent.length, 4);
  assert.equal(ws.sent[0].text, ' ');
  assert.equal(ws.sent[0].voice_settings.speed, 1);
  assert.equal(ws.sent[1].text, 'Sure, one sec. ');
  assert.equal(ws.sent[1].flush, true);
  assert.equal(ws.sent[2].text, 'It is 36. ');
  assert.equal(ws.sent[2].flush, true);
  assert.deepEqual(ws.sent[3], { text: '' });
  FakeWS.last.server({ isFinal: true });
  assert.equal(got.ended, 1); assert.equal(got.errors.length, 0); assert.ok(ws.closed);
}

{ // Audio arrives base64-encoded and is handed on as whole 16-bit samples.
  const { v, got } = run();
  v.open(); FakeWS.last.open(); v.say('Hi.'); v.end();
  FakeWS.last.server({ audio: Buffer.from([1, 0, 2, 0]).toString('base64') });
  assert.deepEqual([...got.audio], [new Uint8Array([1, 0, 2, 0])]);
  FakeWS.last.server({ isFinal: true });
  assert.equal(got.ended, 1);
}

{ // A cue never reaches the model: it would be read out, not performed.
  const { v, got } = run();
  v.open(); FakeWS.last.open(); v.say('[warm] Hello there.'); v.end();
  assert.equal(FakeWS.last.sent[1].text, 'Hello there. ');
  FakeWS.last.server({ isFinal: true });
  assert.equal(got.ended, 1);
}

{ // Nothing speakable: the stream still opens and closes, no text goes out.
  const { v, got } = run();
  v.open(); FakeWS.last.open(); v.end();
  assert.equal(FakeWS.last.sent.length, 2);
  assert.equal(FakeWS.last.sent[0].text, ' ');
  assert.deepEqual(FakeWS.last.sent[1], { text: '' });
  FakeWS.last.server({ isFinal: true });
  assert.equal(got.ended, 1);
}

{ // Server error (bad voice) → onError, flagged as nothing heard, no end.
  const { v, got } = run();
  v.open(); FakeWS.last.open(); v.say('Hi.');
  FakeWS.last.server({ error: 'Reference not found' });
  assert.equal(got.errors.length, 1); assert.match(got.errors[0].message, /Reference not found/); assert.equal(got.errors[0].heard, false);
  assert.equal(got.ended, 0);
}

{ // Connection refused (bad key) → one error, never an end.
  const { v, got } = run();
  v.open(); v.say('Hi.'); FakeWS.last.onerror?.({}); FakeWS.last.onclose?.({});
  assert.equal(got.errors.length, 1); assert.equal(got.ended, 0);
}

{ // The account check: a good key answers, a bad one is a key problem, the network is told apart.
  const fake = (status, body) => async () => ({ status, ok: status < 300, json: async () => body });
  assert.deepEqual(await elevenAccount('k', { fetchImpl: fake(200, { subscription: { characters_remaining: 12 } }) }), { ok: true, credit: 12 });
  assert.deepEqual(await elevenAccount('k', { fetchImpl: fake(401, {}) }), { ok: false, reason: 'key' });
  assert.deepEqual(await elevenAccount('k', { fetchImpl: fake(500, {}) }), { ok: false, reason: 'network' });
}

{ // The speaker drives ElevenLabs like the other services: the default voice and model, audio out at its rate.
  const made = [];
  class FakeVoice {
    constructor(o) { Object.assign(this, o); this.said = []; this.ended = false; this.aborted = false; made.push(this); }
    open() { return this; }
    say(s) { this.said.push(s); }
    end() { this.ended = true; }
    abort() { this.aborted = true; }
  }
  const out = [], problems = [];
  const sp = createSpeaker({
    emit: (m) => out.push(m), onProblem: (p) => problems.push(p), FishVoiceImpl: FakeVoice, account: async () => ({ ok: true, credit: null }),
    providers: { eleven: { ...PROVIDERS.eleven, Voice: FakeVoice, account: async () => ({ ok: true, credit: null }) } }, beatPhrases: [], bundled: () => null,
  });
  assert.equal(sp.provider, 'fish');
  sp.setProvider('eleven');
  assert.equal(sp.provider, 'eleven'); assert.equal(sp.on, false);
  sp.setKey('e-key');
  const r = sp.start();
  const v = made[0];
  assert.equal(sp.model, ELEVEN_MODEL);
  assert.equal(v.key, 'e-key'); assert.equal(v.voice, ELEVEN_DEFAULT_VOICE); assert.equal(v.model, ELEVEN_MODEL);
  r.say('Hi.'); r.end();
  v.onAudio(new Uint8Array([1, 0]));
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, rate: ELEVEN_RATE, pcm: Buffer.from([1, 0]).toString('base64') });
  v.onEnd();
  assert.deepEqual(out.at(-1), { kind: 'speech', id: r.id, end: true, chars: 3 });
}

console.log('eleven voice tests: passed');
