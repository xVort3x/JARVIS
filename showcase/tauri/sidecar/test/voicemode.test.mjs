import assert from 'node:assert/strict';
import { VOICE_MODES, VAD_PAUSES, VAD_SENS, SENSITIVITY, voiceMode, vadPause, vadSensitivity, helperVad } from '../voicemode.mjs';

assert.deepEqual(VOICE_MODES.map(([id]) => id), ['handsfree', 'ptt', 'text']);
assert.deepEqual(VAD_PAUSES.map(([id]) => id), [0.75, 1.5, 3]);
assert.deepEqual(VAD_SENS.map(([id]) => id), ['low', 'normal', 'high']);

// The mode comes from the config; a config from before modes existed keeps the tap gesture, and a voice-off one is text.
assert.equal(voiceMode({ voiceMode: 'ptt' }), 'ptt');
assert.equal(voiceMode({ voiceMode: 'handsfree' }), 'handsfree');
assert.equal(voiceMode({ voiceMode: 'text' }), 'text');
assert.equal(voiceMode({ voiceMode: 'nonsense', voice: true }), 'handsfree', 'an unknown mode falls back from the old flag, keeping tap-to-talk');
assert.equal(voiceMode({ voice: true }), 'handsfree');
assert.equal(voiceMode({ voice: false }), 'text');
assert.equal(voiceMode({}), 'handsfree');

// The pause: a number in seconds, clamped into something a person means.
assert.equal(vadPause({ vadPause: 3 }), 3);
assert.equal(vadPause({ vadPause: 0 }), 0.5);
assert.equal(vadPause({ vadPause: 99 }), 4);
assert.equal(vadPause({ vadPause: 'nonsense' }), 1.5);
assert.equal(vadPause({}), 1.5);

// Sensitivity: one of the three, else the shipped default.
assert.equal(vadSensitivity({ vadSensitivity: 'low' }), 'low');
assert.equal(vadSensitivity({ vadSensitivity: 'high' }), 'high');
assert.equal(vadSensitivity({ vadSensitivity: 'best' }), 'normal');
assert.equal(vadSensitivity({}), 'normal');
for (const [id] of VAD_SENS) assert.ok(SENSITIVITY[id].voice > SENSITIVITY[id].level, `${id}: the noise gate stays above the voice bar`);

// What the helper is told.
const hf = helperVad({ voiceMode: 'handsfree', vadPause: 3, vadSensitivity: 'high' });
assert.deepEqual({ handsfree: hf.handsfree, pause: hf.pause, sensitivity: hf.sensitivity }, { handsfree: true, pause: 3, sensitivity: 'high' });
assert.equal(hf.voice, SENSITIVITY.high.voice);
assert.equal(hf.level, SENSITIVITY.high.level);
assert.deepEqual(helperVad({ voiceMode: 'ptt' }), { handsfree: false, pause: 1.5, sensitivity: 'normal', voice: 0.2, level: 0.15, label: 'Normal' });
assert.equal(helperVad({ voiceMode: 'text' }).handsfree, false);
console.log('voice mode tests: passed');
