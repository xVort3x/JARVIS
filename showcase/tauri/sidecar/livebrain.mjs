// Jarvis's own brain inside a Gemini Live call (live.mjs): the same prompt Classic builds, plus a few lines for talking
// out loud, and the same tools. The tools are declared to Gemini here, in one place, and every call Gemini makes runs
// through that tool's own execute, so Allow prompts, allowActions, skipAllow and read-only folders work as in Classic.
// Everything else (the hotkey, playback, captions, the panel) stays with the caller, which hears it through emit():
// every live.mjs event except toolCall/toolCancel (handled here), plus
//   {type:'tool', id, name, args}      a tool started (args as Gemini sent them)
//   {type:'toolEnd', id, name, ok, output}  it finished (ok false: it failed, was refused or was cancelled); output: its
//                                      answer's text or error (none when cancelled)
// A cancelled call (they cut in) is aborted and gets no answer. A picture in a tool's result (a screenshot) goes into
// the call as an image, its text as the answer. news() holds a background agent's report until the call is quiet.
import { resolveToolSchema } from '@kenkaiiii/gg-ai';
import { unknownToolMessage } from '@kenkaiiii/gg-agent';
import { createLive, val } from './live.mjs';
import { SLOW_TOOLS } from './tools.mjs';

export const LIVE_GUIDANCE = `You're in a live voice call: everything you say is heard out loud, the moment you say it, and they can cut in any time. Talk like on the phone: one to three short sentences, plain words, contractions. No markdown, lists, emoji, links, code, file paths, bracketed cues or tags like [happy]: they'd be read aloud. Name the site, file or app instead. Before anything slow (the web, a page, the screen, an app, a command), say a short beat like "On it, one sec." and keep talking with them while it runs. When a result comes back, tell them briefly. Never say you don't know something about them before looking it up with your tools (their second brain, if they have one). Reply in the language they're speaking and keep that one language for the whole call: never switch because a bit of audio was unclear or sounded foreign, only when they clearly switch themselves. If you're not sure, use English.`;

/** The tools as Live function declarations: [{functionDeclarations}] for the session's config.tools. */
export function liveDeclarations(tools, slow = SLOW_TOOLS) {
  const functionDeclarations = [];
  for (const t of tools) {
    let schema;
    try { schema = resolveToolSchema(t); } catch { continue; } // unconvertible schema: left out
    functionDeclarations.push({ name: t.name, description: t.description, parametersJsonSchema: schema, ...(slow.has(t.name) ? { behavior: 'NON_BLOCKING' } : {}) });
  }
  return [{ functionDeclarations }];
}

const stripNulls = (v) => (Array.isArray(v) ? v.map(stripNulls)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, stripNulls(x)])) : v);
const parse = (tool, args) => {
  try { return tool.parameters.parse(args); } catch (first) {
    try { return tool.parameters.parse(stripNulls(args)); } catch { throw first; }
  }
};

// A chosen speech language (a locale like 'ar-SA'), as a prompt line; '' for 'auto'.
export const langLine = (code) => {
  if (!code || code === 'auto') return '';
  let name = code;
  try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch {}
  return `\nThey've set their language to ${name}: reply in it unless they speak another.`;
};

/**
 * tools: the tool array (or a function returning it, read on every connect and call). system: a function returning the
 * prompt Classic would send (personality, memory, second brain, focus, crew). The rest goes to createLive (key, model,
 * voice, connect). speechLang: 'auto' or a locale like 'ar-SA' (a value or a function, read on every connect); a locale
 * is named in the prompt. Native-audio Live models take their language from the conversation and the system
 * instruction (the Live API guide), so it isn't sent as speechConfig.languageCode.
 */
export function createLiveBrain({ emit, tools, system, slow = SLOW_TOOLS, speechLang = 'auto', ...liveOpts }) {
  const running = new Map(); // call id → AbortController
  const held = []; // agent news waiting for a quiet moment
  const quiet = () => live.state === 'listening' && !running.size;
  const flush = () => { while (held.length && quiet()) live.pushNote(held.shift()); };
  const live = createLive({
    ...liveOpts,
    systemInstruction: () => `${val(system) ?? ''}\n\n${LIVE_GUIDANCE}${langLine(val(speechLang))}`,
    tools: () => liveDeclarations(val(tools), slow),
    emit: (e) => {
      if (e.type === 'toolCall') return batch(e.calls);
      if (e.type === 'toolCancel') return e.ids.forEach((id) => running.get(id)?.abort());
      emit(e);
      if (e.type === 'state') flush();
    },
  });

  // Parallel calls in one turn are answered together, one toolResponse per kind once the last of that kind is done:
  // one per result made her answer once per result. The quick (blocking) ones and the slow (NON_BLOCKING) ones go
  // separately, so a slow one never holds back what Gemini is waiting on. toolEnd fires as the answer goes out. A
  // cancelled call is dropped at once (its tool may ignore the abort) and gets no answer.
  function batch(calls) {
    for (const group of [calls.filter((c) => !slow.has(c.name)), calls.filter((c) => slow.has(c.name))]) if (group.length) answer(group);
  }
  async function answer(group) {
    const done = (await Promise.all(group.map(run))).filter(Boolean);
    for (const { id, name, ok, response } of done) emit({ type: 'toolEnd', id, name, ok, output: response.output ?? response.error });
    if (done.length) live.respond(done.map(({ id, name, response }) => ({ id, name, response })));
    flush();
  }

  async function run({ id, name, args }) {
    const ac = new AbortController();
    running.set(id, ac);
    emit({ type: 'tool', id, name, args });
    const cancelled = new Promise((res) => ac.signal.addEventListener('abort', () => res(null), { once: true }));
    const work = (async () => {
      let response, ok = false;
      try {
        const tool = val(tools).find((t) => t.name === name);
        if (!tool) throw new Error(unknownToolMessage(name, val(tools).map((t) => t.name)));
        const raw = await tool.execute(parse(tool, args), { signal: ac.signal, toolCallId: id });
        const content = typeof raw === 'string' ? raw : raw?.content ?? '';
        const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
        for (const b of parts) if (b.type === 'image' && !ac.signal.aborted) live.pushImage(b.data, b.mediaType);
        const text = parts.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        response = { output: text };
        ok = true;
      } catch (err) {
        response = { error: err?.message || String(err) };
      }
      running.delete(id);
      if (ac.signal.aborted) flush();
      return ac.signal.aborted ? null : { id, name, ok, response };
    })();
    const r = await Promise.race([work, cancelled]);
    if (!r) emit({ type: 'toolEnd', id, name, ok: false });
    return r;
  }

  return {
    get state() { return live.state; },
    start: () => live.start(),
    stop() {
      live.stop();
      held.length = 0;
      for (const ac of running.values()) ac.abort();
    },
    /** True when nothing is going on in the call: she isn't talking or thinking and no tool is running. */
    quiet,
    /** A background agent's news (newsDesk's enqueue text): into the call now if quiet, else at the next quiet moment. */
    news(text) { held.push(String(text)); flush(); },
    pushAudio: (pcm) => live.pushAudio(pcm),
    pushImage: (data, mimeType) => live.pushImage(data, mimeType),
  };
}
