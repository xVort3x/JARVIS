// Groq as the brain: its OpenAI-compatible endpoint (https://api.groq.com/openai/v1) and the curated models
// J.A.R.V.I.S runs on it. gg-ai streams OpenAI-compatible providers through its provider registry, so Groq
// registers there and takes the curated models into gg-core's runtime models.
import { providerRegistry, stream } from '@kenkaiiii/gg-ai';
import { registerRuntimeModels } from '@kenkaiiii/gg-core';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
// Groq's curated models, fastest first — the default brain runs the fast one.
export const GROQ_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-4-scout-70b', 'llama-3.3-70b-versatile'];
export const GROQ_DEFAULT_MODEL = GROQ_MODELS[0];

const groqModel = (id, name, maxOutputTokens, costTier) => ({ id, name, provider: 'groq', contextWindow: 131_072, maxOutputTokens, supportsThinking: false, supportsImages: true, supportsVideo: false, costTier, maxThinkingLevel: 'high' });

registerRuntimeModels([
  groqModel(GROQ_DEFAULT_MODEL, 'GPT OSS 20B', 8_192, 'low'),
  groqModel(GROQ_MODELS[1], 'GPT OSS 120B', 16_384, 'medium'),
  groqModel(GROQ_MODELS[2], 'Llama 4 Scout 70B', 8_192, 'medium'),
  groqModel(GROQ_MODELS[3], 'Llama 3.3 70B Versatile', 8_192, 'low'),
]);

// Groq: OpenAI-compatible chat completions with tools and vision, on Groq's endpoint. Groq's models are OpenAI
// wire-compatible, so Groq rides the same transport the other OpenAI-compatible providers use.
providerRegistry.register('groq', { stream: (options) => stream({ ...options, provider: 'openai', baseUrl: GROQ_BASE_URL }) });
