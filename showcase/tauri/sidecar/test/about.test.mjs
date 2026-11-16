import assert from 'node:assert/strict';
import { aboutJarvis } from '../about.mjs';

// The app's manual for about_jarvis: each platform's own wording, and only the features this copy has.
const base = { name: 'Jarvis', mac: false, linux: false, snap: false, pointer: false, voice: false, hotkeys: false };
const mac = aboutJarvis({ ...base, mac: true, snap: true, pointer: true, voice: true, hotkeys: true });
const win = aboutJarvis(base);
const linux = aboutJarvis({ ...base, linux: true, voice: true });
assert.match(mac, /lives in the menu bar at the top of the screen/);
assert.match(mac, /Show Jarvis, Ask Jarvis…, Ask About an Area…, Stop, Save Diagnostics…, Quit Jarvis/);
assert.match(mac, /Memory: two tabs, What I Remember/);
assert.match(mac, /Wake word \(say "Hey Jarvis"/);
assert.match(mac, /Voice Provider: Fish Audio, Gemini or VoiceStudio/);
assert.match(win, /bottom right of the taskbar/);
assert.ok(!/Ask About an Area|Wake word|Cursor, a little arrow/.test(win), 'features this copy lacks are left out');
assert.match(linux, /AppIndicator extension/);
assert.ok(!/Wake word/.test(linux), 'the wake word is Mac only');
// The settings pages as the panel names them.
assert.match(mac, /Model \(.*Appearance \(Size:.*Speaking \(Replies:.*Listening \(Voice Control.*Shortcuts \(.*Routines \(Morning Briefing.*General \(.*About \(Setup guide/);
assert.match(linux, /Shortcuts \(the commands to bind/, 'no global keys there: the commands to bind');
for (const t of [mac, win, linux]) {
  assert.match(t, /Save diagnostics/);
  assert.ok(!/Ken Kai|KenKaiii|Roamies|Echo|Anime Girl|Sarah|Adrian|Rita/.test(t), 'Jarvis only: no old branding or characters');
  assert.ok(!/\$\{|undefined/.test(t), 'every part is filled in');
}
console.log('about tests: passed');
