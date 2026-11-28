// Spoken replies through OpenRouter's speech endpoint (the user's own OpenRouter key), with HeyGen's voices behind it.
// There's no live socket: each sentence is its own request, started the moment it's said, a few at a time. The whole
// PCM comes back with the response (not as a stream), and it's handed on strictly in the order the sentences were said:
// the first one plays as soon as it lands, the ones behind it wait their turn. Raw 16-bit mono PCM at 24 kHz, the same
// rate as the other voices. Same shape as FishVoice and GeminiVoice, so the speaker can use either.
import { GEMINI_PITCH, GEMINI_RATE } from './gemini.mjs';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
// HeyGen's Voice Turbo through OpenRouter: low latency, free tier, PCM only.
export const OPENROUTER_MODELS = ['heygen/heygen-voice-1-turbo'];
export const OPENROUTER_MODEL = OPENROUTER_MODELS[0];
export const OPENROUTER_RATE = GEMINI_RATE;
// Played a little fast so the voice sits higher, exactly like the Gemini provider's (see gemini.mjs).
export const OPENROUTER_PITCH = GEMINI_PITCH;
export const OPENROUTER_PACE = null; // HeyGen has no instruction field; pace comes from the text itself
export const OPENROUTER_DEFAULT_VOICE = 'gareth';
export const OPENROUTER_VOICES = [
  { id: 'gareth', style: 'Warm British' }, { id: 'lucian', style: 'Clear American' },
  { id: 'weston', style: 'Confident' }, { id: 'bram', style: 'Deep' },
  { id: 'nadine', style: 'Bright' }, { id: 'tabitha', style: 'Soft' },
  { id: 'noelle', style: 'Friendly' }, { id: 'meredith', style: 'Calm' },
  { id: 'sabrina', style: 'Energetic' }, { id: 'vincent', style: 'Authoritative' },
];
const MAX_IN_FLIGHT = 3;

// The documented body of POST /audio/speech. instructions is free text (tone, pacing, emotion); HeyGen ignores it.
export const speechRequest = (text, { voice = OPENROUTER_DEFAULT_VOICE, model = OPENROUTER_MODEL, instructions = null } = {}) => ({
  model, input: text, voice, response_format: 'pcm', ...(instructions ? { instructions } : {}),
});

/** Is the key good, and what's left on it? Never throws. Same answer shape as fishAccount and geminiAccount. */
export async function openrouterAccount(key, { fetchImpl = fetch, timeout = 6000 } = {}) {
  try {
    const r = await fetchImpl(`${OPENROUTER_API}/key`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeout) });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'key' };
    if (!r.ok) return { ok: false, reason: 'network' };
    const left = (await r.json().catch(() => null))?.data?.limit_remaining;
    return { ok: true, credit: typeof left === 'number' ? left : null };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

export class OpenRouterVoice {
  constructor({ key, voice = OPENROUTER_DEFAULT_VOICE, model = OPENROUTER_MODEL, fetchImpl = fetch, onAudio, onEnd, onError, timeout = 30_000, maxInFlight = MAX_IN_FLIGHT }) {
    Object.assign(this, { key, voice, model, fetchImpl, onAudio, onEnd, onError, timeout, maxInFlight });
    this.jobs = [];
    this.head = 0;
    this.state = 'open';
    this.heard = false;
    this.stopper = new AbortController();
  }

  open() { return this; }

  say(text) {
    if (this.state !== 'open') return;
    // HeyGen reads the text as-is; keep it plain (no inline cue tags).
    const s = String(text ?? '').replace(/\[[^\]]*\]\s*/g, '').trim();
    if (!/[\p{L}\p{N}]/u.test(s)) return;
    this.jobs.push({ text: s, chunks: [], state: 'waiting', odd: null });
    this.pump();
  }

  end() {
    if (this.state !== 'open') return;
    this.state = 'ending';
    this.drain();
  }

  abort() { this.close(); }

  pump() {
    let running = this.jobs.filter((j) => j.state === 'running').length;
    for (const j of this.jobs) {
      if (running >= this.maxInFlight) break;
      if (j.state === 'waiting') { running++; this.run(j); }
    }
  }

  async run(job) {
    job.state = 'running';
    try {
      const r = await this.fetchImpl(`${OPENROUTER_API}/audio/speech`, {
        method: 'POST', headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
        body: JSON.stringify(speechRequest(job.text, { voice: this.voice, model: this.model })),
        signal: AbortSignal.any([this.stopper.signal, AbortSignal.timeout(this.timeout)]),
      });
      if (!r.ok) {
        const said = (await r.text().catch(() => '')).match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1];
        throw Object.assign(new Error(r.status === 429 ? 'OpenRouter is rate limiting' : `OpenRouter: ${said ?? `error ${r.status}`}`), { status: r.status });
      }
      const pcm = this.whole(job, Buffer.from(await r.arrayBuffer()));
      if (!pcm.length) throw new Error('OpenRouter sent no audio');
      job.chunks.push(pcm);
      if (this.state === 'done') return;
      job.state = 'done';
      this.pump();
      this.drain();
    } catch (e) {
      return this.fail(e.name === 'TimeoutError' ? new Error('OpenRouter is taking too long') : e);
    }
  }

  drain() {
    while (this.state !== 'done' && this.head < this.jobs.length) {
      const j = this.jobs[this.head];
      for (const pcm of j.chunks.splice(0)) { this.heard = true; this.onAudio?.(pcm); }
      if (j.state !== 'done') return;
      this.head++;
    }
    if (this.state === 'ending') { this.close(); this.onEnd?.(); }
  }

  whole(job, b) {
    if (job.odd != null) { b = Buffer.concat([Buffer.from([job.odd]), b]); job.odd = null; }
    if (b.length % 2) { job.odd = b[b.length - 1]; b = b.subarray(0, b.length - 1); }
    return b;
  }

  close() {
    if (this.state === 'done') return;
    this.state = 'done';
    this.stopper.abort();
  }

  fail(err) {
    if (this.state === 'done') return;
    this.close();
    err.heard = this.heard;
    this.onError?.(err);
  }
}
