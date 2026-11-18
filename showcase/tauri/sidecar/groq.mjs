// Groq as the brain: its OpenAI-compatible endpoint (https://api.groq.com/openai/v1) and the curated models
// J.A.R.V.I.S runs on it. gg-ai streams OpenAI-compatible providers through its provider registry, so Groq
// registers there and takes the curated models into gg-core's runtime models.
import { providerRegistry, stream } from '@kenkaiiii/gg-ai';
import { registerRuntimeModels } from '@kenkaiiii/gg-core';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
// The free plan's models (free tier: 30 RPM / 1,000 requests a day / 200K tokens a day, 450+ tps on Qwen). The
// default is Qwen 3.8 27B: frontier-level reasoning and tool use, and it is free at this tier.
export const GROQ_MODELS = ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];
export const GROQ_DEFAULT_MODEL = GROQ_MODELS[0];

const groqModel = (id, name, maxOutputTokens, costTier) => ({ id, name, provider: 'groq', contextWindow: 131_072, maxOutputTokens, supportsThinking: false, supportsImages: true, supportsVideo: false, costTier, maxThinkingLevel: 'high' });

registerRuntimeModels([
  groqModel(GROQ_MODELS[0], 'Qwen 3.8 27B', 16_384, 'low'),
  groqModel(GROQ_MODELS[1], 'GPT OSS 20B', 65_536, 'low'),
  groqModel(GROQ_MODELS[2], 'GPT OSS 120B', 65_536, 'medium'),
  groqModel(GROQ_MODELS[3], 'Llama 3.3 70B Versatile', 32_768, 'low'),
]);

// Groq's OpenAI-compatible endpoint rejects the OpenAI-only fields gg-ai adds for provider "openai": prompt_cache_key,
// prompt_cache_options, prompt_cache_retention (added when cache retention is long), and reasoning_content on
// assistant turns. Strip them at the wire.
export function forGroq(body) {
  if (!body || typeof body !== 'object') return body;
  for (const k of Object.keys(body)) if (k.startsWith('prompt_cache_')) delete body[k];
  for (const m of body.messages ?? []) if (m && typeof m === 'object') delete m.reasoning_content;
  return body;
}

const groqFetch = (options) => {
  const send = options.fetch ?? fetch;
  return (url, init) => {
    if (typeof init?.body === 'string') {
      try { init = { ...init, body: JSON.stringify(forGroq(JSON.parse(init.body))) }; } catch { /* not JSON: send as-is */ }
    }
    return send(url, init);
  };
};

// Groq: OpenAI-compatible chat completions with tools and vision, on Groq's endpoint. Groq's models are OpenAI
// wire-compatible, so Groq rides the same transport the other OpenAI-compatible providers use.
providerRegistry.register('groq', { stream: (options) => stream({ ...options, provider: 'openai', baseUrl: GROQ_BASE_URL, fetch: groqFetch(options) }) });
