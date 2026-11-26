// Spoken replies through OpenRouter's speech endpoint (the user's own OpenRouter key), with Gemini's voices behind it.
// There's no live socket: each sentence is its own request, started the moment it's said, a few at a time. The whole
// PCM comes back with the response (not as a stream), and it's handed on strictly in the order the sentences were said:
// the first one plays as soon as it lands, the ones behind it wait their turn. Raw 16-bit mono PCM at 24 kHz, the same
// rate as Gemini's own voice. Same shape as FishVoice and GeminiVoice, so the speaker can use either.
import { GEMINI_LOOK_VOICES, GEMINI_PITCH, GEMINI_RATE, GEMINI_VOICES, plain } from './gemini.mjs';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
// Gemini's TTS through OpenRouter: the same voices, and PCM at Gemini's 24 kHz (other providers' PCM is 44.1 kHz).
// Priciest first, like Fish's; one is enough because OpenRouter falls back between its own providers.
export const OPENROUTER_MODELS = ['google/gemini-2.5-flash-tts'];
export const OPENROUTER_MODEL = OPENROUTER_MODELS[0];
export const OPENROUTER_RATE = GEMINI_RATE;
// Played a little fast so the voice sits higher, exactly like the Gemini provider's (see gemini.mjs).
export const OPENROUTER_PITCH = GEMINI_PITCH;
// Left alone Gemini talks slowly. This goes on every sentence, after its mood (gemini.mjs does the same).
export const OPENROUTER_PACE = 'speaking quickly';
export const OPENROUTER_DEFAULT_VOICE = GEMINI_LOOK_VOICES.jarvis;
export const OPENROUTER_VOICES = GEMINI_VOICES;
// Sentences being made at once. Gemini's own endpoint takes three; OpenRouter queues per provider behind it.
const MAX_IN_FLIGHT = 3;

// The documented body of POST /audio/speech. instructions is free text (tone, pacing, emotion); Gemini TTS honours it.
export const speechRequest = (text, { voice = OPENROUTER_DEFAULT_VOICE, model = OPENROUTER_MODEL, instructions = null } = {}) => ({
  model, input: text, voice, response_format: 'pcm', ...(instructions ? { instructions } : {}),
});

/** Is the key good, and what's left on it? Never throws. Same answer shape as fishAccount and geminiAccount. */
export async function openrouterAccount(key, { fetchImpl = fetch, timeout = 6000 } = {}) {
  try {
    const r = await fetchImpl(`${OPENROUTER_API}/key`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeout) });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: 'key' };
    if (!r.ok) return { ok: false, reason: 'network' };
    // limit_remaining is null when the key has no spending limit: no credit to read, like Gemini.
    const left = (await r.json().catch(() => null))?.data?.limit_remaining;
    return { ok: true, credit: typeof left === 'number' ? left : null };
  } catch {
    return { ok: false, reason: 'network' };
  }
}

/**
 * One reply's voice. say() as many times as needed, then end(). abort() stops at once, silently.
 * onAudio(Uint8Array) gets PCM (whole 16-bit samples); onEnd() once after the last audio; onError(err) instead
 * of onEnd when it fails (heard = whether any audio had arrived; status = the HTTP status, if there was one).
 * It never says a failure is the key's fault: a 400 is also what an unknown voice gets. The speaker checks.
 */
export class OpenRouterVoice {
  constructor({ key, voice = OPENROUTER_DEFAULT_VOICE, model = OPENROUTER_MODEL, fetchImpl = fetch, onAudio, onEnd, onError, timeout = 30_000, maxInFlight = MAX_IN_FLIGHT }) {
    Object.assign(this, { key, voice, model, fetchImpl, onAudio, onEnd, onError, timeout, maxInFlight });
    this.jobs = []; // one per sentence, in the order said: { text, style, chunks, state: waiting → running → done }
    this.head = 0; // the sentence whose audio is being handed on now
    this.state = 'open'; // open → ending → done
    this.heard = false;
    this.stopper = new AbortController();
  }

  open() { return this; } // nothing to connect ahead of time

  say(text) {
    if (this.state !== 'open') return;
    const p = plain(text);
    if (!/[\p{L}\p{N}]/u.test(p.text.replace(/<[^>]*>/g, ''))) return; // nothing to say ("…", a lone cue or tag): asking would get no audio and fail the reply
    this.jobs.push({ ...p, chunks: [], state: 'waiting', odd: null });
    this.pump();
  }

  end() {
    if (this.state !== 'open') return;
    this.state = 'ending';
    this.drain();
  }

  abort() { this.close(); }

  // Start the sentences that are waiting, up to the limit.
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
        body: JSON.stringify(speechRequest(job.text, { voice: this.voice, model: this.model, instructions: [job.style, OPENROUTER_PACE].filter(Boolean).join(', ') })),
        // Whichever comes first: the reply stopped, or this one sentence taking too long to come back.
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

  // Hand on what's ready, in the order said; a sentence still out holds back the ones after it.
  drain() {
    while (this.state !== 'done' && this.head < this.jobs.length) {
      const j = this.jobs[this.head];
      for (const pcm of j.chunks.splice(0)) { this.heard = true; this.onAudio?.(pcm); }
      if (j.state !== 'done') return;
      this.head++;
    }
    if (this.state === 'ending') { this.close(); this.onEnd?.(); }
  }

  // PCM samples are 2 bytes; a chunk can end mid-sample, so carry the odd byte into the sentence's next one.
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
