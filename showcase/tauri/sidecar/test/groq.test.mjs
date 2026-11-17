// Groq as the default brain: its OpenAI-compatible endpoint, the curated models, and the registration that
// puts them in the app (gg-ai's provider registry + gg-core's runtime models).
import assert from 'node:assert/strict';
import { providerRegistry } from '@kenkaiiii/gg-ai';
import { getModel, getModelsForProvider } from '@kenkaiiii/gg-core';
import { GROQ_BASE_URL, GROQ_MODELS, GROQ_DEFAULT_MODEL } from '../groq.mjs';

assert.equal(GROQ_BASE_URL, 'https://api.groq.com/openai/v1');
assert.ok(Array.isArray(GROQ_MODELS) && GROQ_MODELS.length >= 2, 'a curated list of Groq models');
assert.ok(GROQ_MODELS.includes(GROQ_DEFAULT_MODEL));
assert.equal(GROQ_MODELS[0], GROQ_DEFAULT_MODEL, 'the fast model first, so it is the default brain');

assert.equal(providerRegistry.has('groq'), true, 'Groq rides gg-ai’s OpenAI-compatible transport');

const groq = getModelsForProvider('groq');
assert.ok(groq.length >= 2, 'Groq’s curated models are in the registry');
assert.ok(groq.some((m) => m.id === GROQ_DEFAULT_MODEL), 'the default brain’s model is registered');
assert.equal(getModel(GROQ_DEFAULT_MODEL)?.provider, 'groq');
console.log('groq brain tests: passed');
