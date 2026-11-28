// One Gemini Live call (speech to speech over one open socket, with the user's own AI Studio key). Mic audio goes in
// as 16 kHz PCM, her voice comes back as 24 kHz PCM, and Gemini's own voice activity detection decides when you've
// stopped and when you cut in. Calls outlive Google's session limit: the server hands out resumption handles, and a
// goAway or a drop reconnects with the last good one. The socket is injected (connect has the SDK's shape,
// ai.live.connect), so tests drive a fake one. Everything Jarvis-specific (prompt, tools, playback, the panel) stays
// with the caller; this only reports what happened through emit():
//   {type:'state', state}          connecting | listening | thinking | speaking | closed
//   {type:'turn'}                  their new turn: the first words heard after her last turn ended (before its caption)
//   {type:'audio', id, rate, pcm}  a chunk of her voice (base64 PCM16 mono); one id per reply
//   {type:'audioEnd', id}          that reply's audio is all here
//   {type:'caption', who, text, done}  who: user | jarvis; text is the whole turn so far; done at the turn's end
//   {type:'interrupted'}           you cut in: stop playback now
//   {type:'toolCall', calls}       [{id, name, args}]; answer with respond()
//   {type:'toolCancel', ids}       Gemini dropped those calls (you cut in): abort them
//   {type:'error', reason, message}  reason: key | quota | network | dropped; the call is over
import { DEFAULT_LIVE_MODEL } from './voicemode.mjs';

export const LIVE_IN_RATE = 16000;
export const LIVE_OUT_RATE = 24000;
const RETRIES = 3; // reconnects in a row with nothing heard back before giving up

// The real socket, loaded only when a call is made.
export const geminiConnect = (key, load = () => import('@google/genai')) => async (params) => {
  const { GoogleGenAI } = await load();
  // v1alpha on purpose: @google/genai 3.0.0 defaults to v1, which has no Live endpoint (websocket handshake 404s).
  return new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: 'v1alpha' } }).live.connect(params);
};

export function reasonFor(text) {
  const s = String(text ?? '');
  if (/api[ _-]?key|permission[ _-]?denied|unauthori[sz]ed|response: 40[13]\b/i.test(s)) return 'key';
  if (/quota|resource[ _-]?exhausted|rate[ -]?limit/i.test(s)) return 'quota';
  return null;
}

const b64 = (x) => (typeof x === 'string' ? x : Buffer.from(x.buffer ?? x, x.byteOffset ?? 0, x.byteLength ?? x.length).toString('base64'));
/** A value, or a function returning it (read each time). */
export const val = (x) => (typeof x === 'function' ? x() : x);

/**
 * key, systemInstruction and tools may be values or functions (read again on every connect, so a reconnect gets
 * fresh context). connect defaults to the real Gemini socket for the key.
 */
export function createLive({ emit, key, model = DEFAULT_LIVE_MODEL, voice, systemInstruction = '', tools, connect }) {
  let session = null, gen = 0, handle = null, stopped = true, tries = 0;
  let turn = 0, audioOut = false, heard = '', said = '';
  let userTurn = true; // the next words heard start a new turn of theirs
  const live = { state: 'closed' };
  const setState = (s) => { if (live.state !== s) { live.state = s; emit({ type: 'state', state: s }); } };
  // Hangs up: the session is closed and anything still arriving from it is ignored.
  const hangUp = () => {
    stopped = true; gen++;
    try { session?.close(); } catch {}
    session = null;
  };
  const fail = (reason, message) => {
    hangUp();
    emit({ type: 'error', reason, message: String(message || reason) });
    setState('closed');
  };
  const endTurn = () => {
    if (heard) emit({ type: 'caption', who: 'user', text: heard, done: true });
    if (said) emit({ type: 'caption', who: 'jarvis', text: said, done: true });
    if (audioOut) emit({ type: 'audioEnd', id: `live-${turn}` });
    heard = said = ''; audioOut = false; turn++; userTurn = true;
  };

  const config = () => ({
    responseModalities: ['AUDIO'],
    ...(voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } : {}),
    systemInstruction: val(systemInstruction),
    ...(val(tools) ? { tools: val(tools) } : {}),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: handle ? { handle } : {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
  });

  function onMessage(m) {
    tries = 0;
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) handle = m.sessionResumptionUpdate.newHandle;
    if (m.goAway) { if (handle) open(true); return; }
    if (userTurn && m.serverContent?.inputTranscription?.text) { userTurn = false; emit({ type: 'turn' }); }
    if (m.toolCall) {
      setState('thinking');
      emit({ type: 'toolCall', calls: (m.toolCall.functionCalls ?? []).map(({ id, name, args }) => ({ id, name, args: args ?? {} })) });
    }
    if (m.toolCallCancellation) emit({ type: 'toolCancel', ids: m.toolCallCancellation.ids ?? [] });
    const c = m.serverContent;
    if (!c) return;
    if (c.interrupted) {
      emit({ type: 'interrupted' });
      audioOut = false; said = ''; turn++;
      setState('listening');
    }
    if (c.inputTranscription?.text) {
      heard += c.inputTranscription.text;
      emit({ type: 'caption', who: 'user', text: heard, done: false });
    }
    for (const p of c.modelTurn?.parts ?? []) {
      const d = p.inlineData;
      if (!d?.data || !/^audio\//.test(d.mimeType ?? '')) continue;
      audioOut = true;
      setState('speaking');
      emit({ type: 'audio', id: `live-${turn}`, rate: Number(d.mimeType.match(/rate=(\d+)/)?.[1]) || LIVE_OUT_RATE, pcm: d.data });
    }
    // Thinking starts with her first output that isn't already her voice (or a tool call), never while they still talk.
    if (live.state === 'listening' && (c.modelTurn?.parts?.length || c.outputTranscription?.text)) setState('thinking');
    if (c.outputTranscription?.text) {
      said += c.outputTranscription.text;
      emit({ type: 'caption', who: 'jarvis', text: said, done: false });
    }
    if (c.turnComplete) { endTurn(); setState('listening'); }
  }

  function onClose(e) {
    const why = reasonFor(e?.reason);
    if (why) return fail(why, e.reason);
    if (!handle) return fail('dropped', e?.reason || `The Live call closed (code ${e?.code ?? '?'})`);
    open(true);
  }

  // Opens a connection (a resumption when resuming); the one before it, if any, is hung up and ignored from then on.
  async function open(resuming) {
    if (resuming && ++tries > RETRIES) return fail('dropped', 'The Live call kept dropping');
    const g = ++gen, old = session;
    let ready = false; // until connect() returns, a failure comes back as its error, not as a close
    session = null;
    try { old?.close(); } catch {}
    if (!resuming) setState('connecting');
    const k = val(key);
    if (!k) return fail('key', 'No Gemini key: add one on the keys card');
    try {
      const s = await (connect ?? geminiConnect(k))({
        model,
        config: config(),
        callbacks: {
          onmessage: (m) => { if (g === gen && !stopped) onMessage(m); },
          onerror: () => {}, // a close always follows; that's where it's handled
          onclose: (e) => { if (ready && g === gen && !stopped) onClose(e); },
        },
      });
      if (g !== gen || stopped) { try { s.close(); } catch {} return; }
      session = s; ready = true;
      setState('listening');
    } catch (err) {
      if (g !== gen || stopped) return;
      fail(reasonFor(err?.message) ?? 'network', err?.message);
    }
  }

  const send = (fn, m) => { if (session && !stopped) session[fn](m); };
  return Object.assign(live, {
    async start() {
      if (!stopped) return;
      stopped = false; handle = null; tries = 0; userTurn = true;
      await open(false);
    },
    stop() {
      if (stopped) return;
      hangUp();
      setState('closed');
    },
    /** Mic audio: 16 kHz 16-bit mono PCM, as bytes or base64. */
    pushAudio(pcm) { send('sendRealtimeInput', { audio: { data: b64(pcm), mimeType: `audio/pcm;rate=${LIVE_IN_RATE}` } }); },
    /** One picture (a screenshot or a crop) into the call. */
    pushImage(data, mimeType = 'image/png') { send('sendRealtimeInput', { video: { data: b64(data), mimeType } }); },
    /** A line of text for her to take in and answer (e.g. a background agent's news). */
    pushNote(text) { send('sendRealtimeInput', { text: String(text) }); },
    /** Tool results: [{id, name, response}] with the ids from toolCall. */
    respond(functionResponses) { send('sendToolResponse', { functionResponses }); },
  });
}
