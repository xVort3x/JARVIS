// The free advanced Gemini on the user's Google AI Studio key, registered next to the catalogue so it shows up
// in the Model page and the brain's fallback chain (Groq fails → Gemini 3.6 Flash).
import assert from 'node:assert/strict';
import { getModel, getModelsForProvider } from '@kenkaiiii/gg-core';
import { GEMINI_FREE_MODEL } from '../gemini-models.mjs';

assert.equal(GEMINI_FREE_MODEL, 'gemini-3.6-flash', 'the picked free advanced Gemini is the one that answers on this key');
const models = getModelsForProvider('gemini');
assert.ok(models.some((m) => m.id === GEMINI_FREE_MODEL), 'Gemini 3.6 Flash is in the registry');
assert.equal(getModel(GEMINI_FREE_MODEL)?.provider, 'gemini');
assert.ok(getModel(GEMINI_FREE_MODEL)?.supportsThinking, 'it keeps the reasoning ladder, like the catalogue Flash models');
console.log('gemini model tests: passed');
