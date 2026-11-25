import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The renovation's defaults: the summon hotkey is off (the wake word is the summon path, and a saved key stays),
// and the arrival greets by voice only — silent when replies are text, never animated as an intro beat, nothing opens.
const side = readFileSync(fileURLToPath(new URL('../sidekick.mjs', import.meta.url)), 'utf8');
// New installs get no summon hotkey on either platform.
assert.equal(side.match(/summon: 'off'/g)?.length, 2, 'the summon hotkey defaults to off');
assert.ok(!/summon: 'Control/.test(side), 'no default summon accelerator');
// The tray menu shows the summon accelerator only when one is set.
assert.ok(side.includes("...(HOTKEYS_OK && keys().summon !== 'off' ? { accel: keys().summon } : {})"), 'no stray summon accelerator in the tray menu');
// The prompt names the wake word when the summon hotkey is off, never a bare "off".
assert.ok(side.includes("show or hide you ${keys().summon === 'off' ? 'the wake word' : keyWords(keys().summon)}"), 'the prompt stays truthful when the hotkey is off');
// Arrival: voice-only. In text mode the launch is silent; nothing opens either way.
assert.ok(side.includes("if (config.onboarded && VOICE_ON()) ui({ kind: 'greet' });"), 'the arrival greets by voice only (if any)');
assert.ok(side.includes('brief: false, // short replies'), 'Brief Mode defaults off');
assert.ok(side.includes('local_awareness: true, // send the'), 'Local awareness defaults on (with the opt-out)');
assert.ok(side.includes('localAwareness: config.local_awareness !== false,'), 'Panel state carries local awareness so the toggle can turn it on');
assert.ok(side.includes("if (studioWriting) { ui({ kind: 'studio_append', text: m.text.trim() }); return; }"), 'dictation appends to the canvas, never to the agent');
assert.ok(side.includes("else if (id === 'studiolisten') { studioWriting = !studioWriting; panel(); }"), 'the dictate toggle flips the flag');
console.log('defaults tests: passed');
