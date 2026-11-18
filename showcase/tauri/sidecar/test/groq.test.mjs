// Groq as the default brain: its OpenAI-compatible endpoint, the curated models, and the registration that
// puts them in the app (gg-ai's provider registry + gg-core's runtime models).
import assert from 'node:assert/strict';
import { providerRegistry } from '@kenkaiiii/gg-ai';
import { getModel, getModelsForProvider } from '@kenkaiiii/gg-core';
import { GROQ_BASE_URL, GROQ_MODELS, GROQ_DEFAULT_MODEL, forGroq } from '../groq.mjs';

assert.equal(GROQ_BASE_URL, 'https://api.groq.com/openai/v1');
assert.equal(GROQ_DEFAULT_MODEL, 'qwen/qwen3.8-27b', 'the default Groq model is the free Qwen 3.8 27B');
assert.equal(GROQ_MODELS[0], GROQ_DEFAULT_MODEL, 'the fast model first, so it is the default brain');

assert.equal(providerRegistry.has('groq'), true, 'Groq rides gg-ai’s OpenAI-compatible transport');

const groq = getModelsForProvider('groq');
assert.ok(groq.length >= 2, 'Groq’s curated models are in the registry');
assert.ok(groq.some((m) => m.id === GROQ_DEFAULT_MODEL), 'the default brain’s model is registered');
assert.equal(getModel(GROQ_DEFAULT_MODEL)?.provider, 'groq');

// Groq 400s on these two OpenAI-only fields; the wire rewriter must remove them and change nothing else.
const body = { model: 'qwen/qwen3.8-27b', prompt_cache_key: 'ggcoder', messages: [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello', reasoning_content: 'thought' },
] };
const clean = forGroq(structuredClone(body));
assert.equal('prompt_cache_key' in clean, false, 'prompt_cache_key is stripped for Groq');
assert.equal(clean.messages[1].reasoning_content, undefined, 'reasoning_content is stripped from assistant turns');
assert.equal(clean.messages[0].content, 'hi', 'other message fields survive');
assert.equal(clean.model, body.model, 'the model survives');
assert.equal(typeof forGroq('not json'), 'string', 'non-objects pass through');
console.log('groq brain tests: passed');
