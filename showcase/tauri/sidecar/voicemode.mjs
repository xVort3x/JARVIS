// How you talk to J.A.R.V.I.S: push to talk (hold the talk keys), hands-free (tap, then speak; a pause sends it), or
// text only. And how the microphone decides you've stopped (VAD): the pause that ends a hands-free take, and how
// loud it has to be over the room to count as talking at all. Kept pure so the tests can drive it.

export const VOICE_MODES = [
  ['handsfree', 'Hands-free'],
  ['ptt', 'Push to talk'],
  ['text', 'Text only'],
];
export const VAD_PAUSES = [[0.75, 'Short'], [1.5, 'Normal'], [3, 'Long']];
export const VAD_SENS = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']];

// The level bar speech has to clear (NoiseFloor's VOICE constant), and the fixed bar for "any voice at all"
// (SPEECH_LEVEL). Normal is the shipped default; Low makes the mic pickier (a quiet room or a loud voice),
// High lets quiet speech through (a noisy room or a soft voice).
export const SENSITIVITY = {
  low: { voice: 0.3, level: 0.25, label: 'Low' },
  normal: { voice: 0.2, level: 0.15, label: 'Normal' },
  high: { voice: 0.1, level: 0.07, label: 'High' },
};

export const voiceMode = (cfg) => (['ptt', 'handsfree', 'text'].includes(cfg?.voiceMode) ? cfg.voiceMode : (cfg?.voice === false ? 'text' : 'handsfree'));
export const vadPause = (cfg) => {
  const n = Number(cfg?.vadPause);
  return Number.isFinite(n) ? Math.min(4, Math.max(0.5, n)) : 1.5;
};
export const vadSensitivity = (cfg) => (SENSITIVITY[cfg?.vadSensitivity] ? cfg.vadSensitivity : 'normal');

/** What the voice helper is told: whether a tap starts a hands-free take, the pause that ends it, and the two levels. */
export const helperVad = (cfg) => {
  const mode = voiceMode(cfg);
  const sens = vadSensitivity(cfg);
  return { handsfree: mode === 'handsfree', pause: vadPause(cfg), sensitivity: sens, ...SENSITIVITY[sens] };
};
