// The alarm sound itself: a real WAV the OS players can loop, not a beep. The ring/stop wiring is exercised by
// running the app (see the plan's manual check). Run: npm test
import assert from 'node:assert/strict';
import path from 'node:path';
import { ALARM_FILE, chimeWav } from '../alarm.mjs';

const wav = chimeWav();
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
assert.equal(wav.readUInt16LE(20), 1, 'uncompressed PCM');
assert.equal(wav.readUInt16LE(22), 1, 'mono');
assert.equal(wav.readUInt32LE(24), 44_100);
assert.equal(wav.readUInt16LE(34), 16, '16-bit samples');
assert.equal(wav.readUInt32LE(40), wav.length - 44, 'the data chunk length agrees with the file');
assert.ok(wav.length > 44 + 44_100, 'more than a second of sound');
let loud = 0;
for (let i = 44; i + 1 < wav.length; i += 2) if (Math.abs(wav.readInt16LE(i)) > 200) loud++;
assert.ok(loud > 1000, 'it actually makes a sound');
assert.ok(ALARM_FILE.endsWith(path.join('.gg', 'alarm.wav')), 'the generated chime lives beside the rest of the data');
console.log('alarm tests: passed');
