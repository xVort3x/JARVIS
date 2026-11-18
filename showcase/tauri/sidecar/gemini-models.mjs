// Gemini's free advanced reasoning model on the Google AI Studio key, registered alongside the catalogue:
// gemini-3.8-flash is Google's flagship Flash but shared and often at capacity, and the Pro models are quota-limited
// (429) on the free tier — gemini-3.6-flash answers on this key, with the full reasoning ladder, tools and vision.
import { registerRuntimeModels } from '@kenkaiiii/gg-core';

export const GEMINI_FREE_MODEL = 'gemini-3.6-flash';
registerRuntimeModels([
  { id: GEMINI_FREE_MODEL, name: 'Gemini 3.6 Flash', provider: 'gemini', contextWindow: 1_048_576, maxOutputTokens: 65_536, supportsThinking: true, supportsImages: true, supportsVideo: true, costTier: 'low', maxThinkingLevel: 'high' },
]);
