import assert from 'node:assert/strict';
import { createLive } from '../live.mjs';

// A fake Gemini Live transport: connect() records what it was asked for and hands back a session the test drives.
// Its shape is the SDK's: connect({model, config, callbacks}) → {sendRealtimeInput, sendClientContent, sendToolResponse, close}.
const fakeTransport = ({ fail = null } = {}) => {
  const calls = [];
  const connect = async (params) => {
    if (fail) throw fail;
    const sent = [];
    const s = {
      params, sent, closed: false,
      sendRealtimeInput: (m) => sent.push({ realtime: m }),
      sendClientContent: (m) => sent.push({ content: m }),
      sendToolResponse: (m) => sent.push({ tool: m }),
      close: () => { s.closed = true; },
      // The server's side, for the test.
      server: (msg) => params.callbacks.onmessage(msg),
      drop: (code = 1011, reason = '') => params.callbacks.onclose?.({ code, reason }),
    };
    calls.push(s);
    return s;
  };
  return { connect, calls };
};
const setup = (opts = {}) => {
  const t = fakeTransport(opts);
  const out = [];
  const live = createLive({ connect: t.connect, emit: (e) => out.push(e), key: 'k', model: 'gemini-3.8-live', voice: 'Charon', systemInstruction: 'You are Jarvis.', ...opts.live });
  return { t, out, live };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const audio = (data) => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data } }] } } });

{ // Start opens one call with audio replies, both transcriptions, compression, resumption and automatic VAD.
  const { t, out, live } = setup();
  await live.start();
  assert.equal(t.calls.length, 1);
  const { model, config } = t.calls[0].params;
  assert.equal(model, 'gemini-3.8-live');
  assert.deepEqual(config.responseModalities, ['AUDIO']);
  assert.equal(config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
  assert.equal(config.systemInstruction, 'You are Jarvis.');
  assert.deepEqual(config.inputAudioTranscription, {});
  assert.deepEqual(config.outputAudioTranscription, {});
  assert.ok(config.contextWindowCompression.slidingWindow);
  assert.deepEqual(config.sessionResumption, {}, 'a new call has no handle yet');
  assert.notEqual(config.realtimeInputConfig?.automaticActivityDetection?.disabled, true);
  assert.deepEqual(out.map((e) => e.state).filter(Boolean), ['connecting', 'listening']);
  assert.equal(live.state, 'listening');
}

{ // Her audio goes out as 24 kHz chunks under one id per turn; the turn's end ends it, and the next turn gets a new id.
  const { t, out, live } = setup();
  await live.start();
  const s = t.calls[0];
  s.server(audio('AQID'));
  s.server(audio('BAUG'));
  const chunks = out.filter((e) => e.type === 'audio');
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], { type: 'audio', id: chunks[0].id, rate: 24000, pcm: 'AQID' });
  assert.equal(chunks[1].id, chunks[0].id);
  assert.equal(live.state, 'speaking');
  s.server({ serverContent: { turnComplete: true } });
  assert.deepEqual(out.at(-2), { type: 'audioEnd', id: chunks[0].id });
  assert.equal(live.state, 'listening');
  s.server(audio('BwgJ'));
  assert.notEqual(out.at(-1).id, chunks[0].id);
}

{ // Mic audio goes in as 16 kHz PCM (bytes or base64); an image goes in as a frame; a note goes in as text.
  const { t, live } = setup();
  await live.start();
  const s = t.calls[0];
  live.pushAudio(Buffer.from([1, 2, 3]));
  live.pushAudio('BAUG');
  live.pushImage(Buffer.from([9]), 'image/png');
  live.pushNote('Agent "docs" finished: 3 files updated.');
  assert.deepEqual(s.sent, [
    { realtime: { audio: { data: 'AQID', mimeType: 'audio/pcm;rate=16000' } } },
    { realtime: { audio: { data: 'BAUG', mimeType: 'audio/pcm;rate=16000' } } },
    { realtime: { video: { data: 'CQ==', mimeType: 'image/png' } } },
    { realtime: { text: 'Agent "docs" finished: 3 files updated.' } },
  ]);
}

{ // Nothing is sent before start or after stop; stop hangs up and says so.
  const { t, out, live } = setup();
  live.pushAudio('AQID');
  await live.start();
  live.stop();
  assert.ok(t.calls[0].closed);
  live.pushAudio('AQID');
  assert.deepEqual(t.calls[0].sent, []);
  assert.equal(live.state, 'closed');
  assert.equal(out.at(-1).state, 'closed');
  t.calls[0].drop(1000, '');
  await tick();
  assert.equal(t.calls.length, 1, 'a hang-up is not a drop: no reconnect');
  assert.ok(!out.some((e) => e.type === 'error'));
}

{ // Transcriptions become captions: each side's text so far, then done at the end of the turn.
  const { t, out, live } = setup();
  await live.start();
  const s = t.calls[0];
  s.server({ serverContent: { inputTranscription: { text: 'Open the ' } } });
  s.server({ serverContent: { inputTranscription: { text: 'repo.' } } });
  assert.equal(live.state, 'listening', 'still listening while you talk: your words are not her answer');
  s.server({ serverContent: { outputTranscription: { text: 'On it.' } } });
  assert.equal(live.state, 'thinking', 'her first output (before any audio) is when she is thinking');
  s.server({ serverContent: { turnComplete: true } });
  const caps = out.filter((e) => e.type === 'caption');
  assert.deepEqual(caps, [
    { type: 'caption', who: 'user', text: 'Open the ', done: false },
    { type: 'caption', who: 'user', text: 'Open the repo.', done: false },
    { type: 'caption', who: 'jarvis', text: 'On it.', done: false },
    { type: 'caption', who: 'user', text: 'Open the repo.', done: true },
    { type: 'caption', who: 'jarvis', text: 'On it.', done: true },
  ]);
}

{ // Each user turn starts once, at the first words heard after her last turn ended; her reply never starts one.
  const { t, out, live } = setup();
  await live.start();
  const s = t.calls[0];
  const turns = () => out.filter((e) => e.type === 'turn').length;
  s.server({ serverContent: { inputTranscription: { text: 'Send an ' } } });
  s.server({ serverContent: { inputTranscription: { text: 'agent.' } } });
  assert.equal(turns(), 1);
  assert.ok(out.findIndex((e) => e.type === 'turn') < out.findIndex((e) => e.type === 'caption'), 'the turn starts before its words are passed on');
  s.server({ toolCall: { functionCalls: [{ id: 'c1', name: 'send_agent', args: {} }] } });
  s.server({ serverContent: { outputTranscription: { text: 'Sent.' } } });
  assert.equal(turns(), 1);
  s.server({ serverContent: { turnComplete: true } });
  s.server({ serverContent: { inputTranscription: { text: 'Now open it.' } } });
  s.server({ serverContent: { inputTranscription: { text: ' Please.' } } });
  assert.equal(turns(), 2);
}

{ // Cutting in: interrupted is passed on at once, her audio for that turn ends, and the next reply is a new id.
  const { t, out, live } = setup();
  await live.start();
  const s = t.calls[0];
  s.server(audio('AQID'));
  const first = out.at(-1).id;
  assert.deepEqual(out.map((e) => e.state).filter(Boolean), ['connecting', 'listening', 'speaking'], 'her voice first: straight to speaking');
  s.server({ serverContent: { interrupted: true } });
  assert.ok(out.some((e) => e.type === 'interrupted'));
  assert.equal(live.state, 'listening');
  s.server(audio('BAUG'));
  assert.notEqual(out.at(-1).id, first);
}

{ // Tool calls and cancellations are passed on; responses go back on the open session.
  const { t, out, live } = setup();
  await live.start();
  const s = t.calls[0];
  s.server({ toolCall: { functionCalls: [{ id: 'c1', name: 'open', args: { target: 'repo' } }] } });
  assert.deepEqual(out.at(-1), { type: 'toolCall', calls: [{ id: 'c1', name: 'open', args: { target: 'repo' } }] });
  assert.equal(live.state, 'thinking');
  s.server({ toolCallCancellation: { ids: ['c1'] } });
  assert.deepEqual(out.at(-1), { type: 'toolCancel', ids: ['c1'] });
  live.respond([{ id: 'c1', name: 'open', response: { output: 'opened' } }]);
  assert.deepEqual(s.sent.at(-1), { tool: { functionResponses: [{ id: 'c1', name: 'open', response: { output: 'opened' } }] } });
}

{ // No key: an error with reason "key" and no call is opened.
  const { t, out, live } = setup({ live: { key: '' } });
  await live.start();
  assert.equal(t.calls.length, 0);
  assert.equal(out.find((e) => e.type === 'error')?.reason, 'key');
  assert.equal(live.state, 'closed');
}

{ // A bad key: Google closes the socket saying so. Reason "key", and no retry.
  const { t, out, live } = setup();
  await live.start();
  t.calls[0].drop(1007, 'API key not valid. Please pass a valid API key.');
  await tick();
  assert.equal(t.calls.length, 1);
  const err = out.find((e) => e.type === 'error');
  assert.equal(err.reason, 'key');
  assert.match(err.message, /API key not valid/);
  assert.equal(live.state, 'closed');
}

{ // Quota used up: reason "quota", no retry.
  const { t, out, live } = setup();
  await live.start();
  t.calls[0].drop(1011, 'You exceeded your current quota, please check your plan and billing details.');
  await tick();
  assert.equal(t.calls.length, 1);
  assert.equal(out.find((e) => e.type === 'error').reason, 'quota');
}

{ // Can't connect at all (no network): reason "network".
  const { out, live } = setup({ fail: new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com') });
  await live.start();
  const err = out.find((e) => e.type === 'error');
  assert.equal(err.reason, 'network');
  assert.match(err.message, /ENOTFOUND/);
  assert.equal(live.state, 'closed');
}

{ // A drop with no resumption handle yet can't be resumed: reason "dropped".
  const { t, out, live } = setup();
  await live.start();
  t.calls[0].drop(1011, 'Internal error');
  await tick();
  assert.equal(t.calls.length, 1);
  assert.equal(out.find((e) => e.type === 'error').reason, 'dropped');
  assert.equal(live.state, 'closed');
}

{ // Session limit: a drop after a resumable handle reconnects with that handle, and the call carries on.
  const { t, out, live } = setup();
  await live.start();
  t.calls[0].server({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } });
  t.calls[0].server({ sessionResumptionUpdate: { newHandle: '', resumable: false } }); // mid-turn: keep the last good one
  t.calls[0].drop(1000, '');
  await tick();
  assert.equal(t.calls.length, 2);
  assert.deepEqual(t.calls[1].params.config.sessionResumption, { handle: 'h1' });
  assert.ok(!out.some((e) => e.type === 'error'));
  assert.equal(live.state, 'listening');
  live.pushAudio('AQID');
  assert.equal(t.calls[1].sent.length, 1, 'audio goes to the new connection');
}

{ // goAway: reconnect ahead of the cut-off with the handle, hang up the old line, and ignore anything it still says.
  const { t, out, live } = setup();
  await live.start();
  const old = t.calls[0];
  old.server({ sessionResumptionUpdate: { newHandle: 'h2', resumable: true } });
  old.server({ goAway: { timeLeft: '10s' } });
  await tick();
  assert.equal(t.calls.length, 2);
  assert.deepEqual(t.calls[1].params.config.sessionResumption, { handle: 'h2' });
  assert.ok(old.closed);
  const before = out.length;
  old.drop(1000, '');
  old.server(audio('AQID'));
  await tick();
  assert.equal(out.length, before, 'the old line is ignored');
  assert.equal(t.calls.length, 2);
}

{ // A reconnect that fails gives up with an error instead of looping.
  const t = fakeTransport();
  let n = 0;
  const out = [];
  const connect = async (p) => { if (n++ > 0) throw new Error('socket hang up'); return t.connect(p); };
  const live = createLive({ connect, emit: (e) => out.push(e), key: 'k', model: 'm', voice: 'v', systemInstruction: '' });
  await live.start();
  t.calls[0].server({ sessionResumptionUpdate: { newHandle: 'h', resumable: true } });
  t.calls[0].drop(1011, '');
  await tick(); await tick();
  assert.equal(out.find((e) => e.type === 'error').reason, 'network');
  assert.equal(live.state, 'closed');
}

{ // The SDK closes the socket and then throws when the handshake fails: one error, with the SDK's message.
  const out = [];
  const connect = async (p) => {
    p.callbacks.onerror?.({ message: 'Unexpected server response: 403' });
    p.callbacks.onclose?.({ code: 1006, reason: '' });
    throw new Error('Live connection failed before setup completed: Unexpected server response: 403');
  };
  const live = createLive({ connect, emit: (e) => out.push(e), key: 'k', model: 'm', voice: 'v', systemInstruction: '' });
  await live.start();
  const errs = out.filter((e) => e.type === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].reason, 'key');
  assert.match(errs[0].message, /403/);
}

console.log('live ok');
