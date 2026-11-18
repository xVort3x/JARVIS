// Spoken replies through ElevenLabs's text-to-speech websocket (wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input).
// One socket per reply, opened as the reply starts: the init, then each sentence's text with a trailing space and a
// flush, then the close that ends the stream; audio arrives base64-encoded and is handed on as whole 16-bit samples.
// Cues ("[warm]") never go out: ElevenLabs reads brackets, it doesn't perform them, so they are stripped first.
import { CUE, speakable } from './speech.mjs';

export const ELEVEN_API = 'https://api.elevenlabs.io';
export const ELEVEN_LIVE = (voice) => `wss://api.elevenlabs.io/v1/text-to-speech/${voice}/stream-input`;
// The picks for the stream-input socket: it does not take eleven_v3 or eleven_v4 (those need the Text to Dialogue
// socket), so the fast Flash model is the default and the stable long-form one the fallback.
export const ELEVEN_MODELS = ['eleven_flash_v2_5', 'eleven_multilingual_v2'];
export const ELEVEN_MODEL = 'eleven_flash_v2_5';
export const ELEVEN_RATE = 24000;
// Premade voices a free plan can use through the API (voice-library voices need a paid plan): George is the default.
export const ELEVEN_DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb'; // George · warm British narration
export const ELEVEN_VOICES = [
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George · warm British narration' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah · soft American' },
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel · authoritative British' },
];
// stability 0.4 / similarity 0.85: looser delivery and a firmer tie to the human reference voice — reads less AI than the recommended defaults.
export const ELEVEN_SETTINGS = { stability: 0.4, similarity_boost: 0.85, use_speaker_boost: true, speed: 1 };
// Low latency: the shortest chunk schedule the API allows (the default buffers up to 120 characters).
export const ELEVEN_GENERATION = { chunk_length_schedule: [50, 80, 110] };

/** Is the key good? Never throws. Same answer shape as fishAccount; ElevenLabs reports characters left, not credit. */
export async function elevenAccount(key, { fetchImpl = fetch, timeout = 6000 } = {}) {
  try {
    const r = await fetchImpl(`${ELEVEN_API}/v1/user`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(timeout) });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'key' };
    if (!r.ok) return { ok: false, reason: 'network' };
    const j = await r.json().catch(() => ({}));
    const credit = Number.parseFloat(j.credit ?? j.subscription?.characters_remaining ?? j.subscription?.character_count ?? '');
    return { ok: true, credit: Number.isFinite(credit) ? credit : null };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/**
 * One reply's voice. say() as many times as needed, then end(). abort() stops at once, silently.
 * onAudio(Uint8Array) gets whole 16-bit samples; onEnd() once after the last audio; onError(err) instead of onEnd
 * when it fails (heard = whether any audio had arrived, so a caller can retry on another model).
 */
export class ElevenVoice {
  constructor({ key, voice = ELEVEN_DEFAULT_VOICE, model = ELEVEN_MODEL, rate = ELEVEN_RATE, WebSocketImpl = globalThis.WebSocket, onAudio, onEnd, onError, openTimeout = 8000, audioTimeout = 15000 }) {
    Object.assign(this, { key, voice, model, rate, WebSocketImpl, onAudio, onEnd, onError, openTimeout, audioTimeout });
    this.queue = []; // encoded messages waiting for the socket to open
    this.state = 'new'; // new → opening → open → ending → done
    this.heard = false;
    this.said = 0;
    this.timer = null;
  }

  open() {
    if (this.state !== 'new') return this;
    this.state = 'opening';
    let ws;
    try { ws = new this.WebSocketImpl(`${ELEVEN_LIVE(this.voice)}?model_id=${this.model}&output_format=pcm_${this.rate}`, { headers: { 'xi-api-key': this.key } }); }
    catch (e) { return this.fail(e), this; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.arm(this.openTimeout, 'ElevenLabs took too long to connect');
    ws.onopen = () => {
      if (this.state === 'done') return;
      this.state = this.state === 'ending' ? 'ending' : 'open';
      this.clear();
      ws.send(JSON.stringify({ text: ' ', voice_settings: ELEVEN_SETTINGS, generation_config: ELEVEN_GENERATION }));
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
      if (this.said) this.arm(this.audioTimeout, 'ElevenLabs stopped sending audio');
    };
    ws.onmessage = (e) => {
      if (this.state === 'done') return;
      let m;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.isFinal) return this.finish();
      if (m.audio) { this.heard = true; this.arm(this.audioTimeout, 'ElevenLabs stopped sending audio'); this.onAudio?.(new Uint8Array(Buffer.from(m.audio, 'base64'))); }
      else if (m.error) return this.fail(new Error(`ElevenLabs: ${m.error}`));
    };
    ws.onerror = () => this.fail(new Error(this.heard ? 'ElevenLabs connection dropped' : 'Could not reach ElevenLabs'));
    ws.onclose = () => { if (this.state !== 'done') this.fail(new Error('ElevenLabs closed the connection')); };
    return this;
  }

  send(msg) { const s = JSON.stringify(msg); if (this.state === 'open' || (this.state === 'ending' && this.ws?.readyState === 1)) this.ws.send(s); else this.queue.push(s); }

  say(text) {
    if (this.state === 'done' || this.state === 'ending') return;
    const t = speakable(text).replace(CUE, '').trim();
    if (!t) return; // nothing to say ("…", a lone cue, a screen-only line)
    this.said++;
    this.send({ text: `${t} `, try_trigger_generation: false, flush: true });
  }

  end() {
    if (this.state === 'done' || this.state === 'ending') return;
    this.send({ text: '' }); // CloseConnection ends the stream
    this.state = 'ending';
    if (!this.timer) this.arm(this.audioTimeout, 'ElevenLabs stopped sending audio');
  }

  abort() { this.close(); }

  finish() { if (this.state === 'done') return; this.close(); this.onEnd?.(); }

  close() { if (this.state === 'done') return; this.state = 'done'; this.clear(); this.queue.length = 0; try { this.ws?.close(); } catch { /* already closed */ } }
  arm(ms, why) { this.clear(); this.timer = setTimeout(() => this.fail(new Error(why)), ms); }
  clear() { clearTimeout(this.timer); this.timer = null; }
  fail(err) { if (this.state === 'done') return; this.close(); err.heard = this.heard; this.onError?.(err); }
}
