import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// One identity: Jarvis, with one voice. No look picker, no people.js, no character greetings.
const src = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const side = src('../sidekick.mjs'), guide = src('../../../onboarding/onboarding.js'), guidePage = src('../../../onboarding/index.html');
const looks = [...side.slice(side.indexOf('const LOOKS = ['), side.indexOf('];', side.indexOf('const LOOKS = ['))).matchAll(/\['(\w+)', '([^']+)', '([^']+)'\]/g)];
assert.deepEqual(looks.map((m) => m[1]), ['jarvis'], 'Jarvis is the only look');
assert.equal(looks[0][2], 'Jarvis');
assert.equal(looks[0][3], 'e13fa398a7f445a685316a3de6089ce7');
assert.match(side, /const lookName = \(\) => 'Jarvis'/);
{
  const at = side.indexOf('function setLook(');
  const set = side.slice(at, side.indexOf('return true;', at) + 20);
  assert.match(set, /if \(l !== 'jarvis'\) return false;/, 'any other look is refused');
  assert.ok(!/LOOK_GREETINGS|geminiVoice\(|studioVoice\(|speech\./.test(set), 'no per-look voice or greeting');
}
// The prompt and the manual name Jarvis only. The frontend's internal `Roamie.*` API namespace is not
// user-visible, so it does not count as branding.
const withoutApi = (text) => text.replace(/\bRoamie\./g, '');
assert.match(side.slice(side.indexOf('const stablePrompt'), side.indexOf('const stablePrompt') + 700), /You are Jarvis/);
for (const [name, text] of [['sidekick', side], ['setup guide', guide], ['setup guide page', guidePage]]) {
  assert.ok(!/Roamie|Anime Girl|Rita X|Ken Kai|By Ken Kai/.test(withoutApi(text)), `${name}: old names are gone`);
}
assert.ok(!/id="looks"|look-h|LOOK_QUIPS|LOOK_GREETINGS/.test(guide + guidePage), 'the setup guide has no look picker');
assert.ok(!/roamies\/people\.js|roamies\/sfx\.js/.test(src('../../../desktop.html') + src('../../../panel/index.html')), 'no character or sound-effect scripts');

// The bubbles, tags and step list draw with glass.js, so the overlay loads it before them.
{
  const page = src('../../../desktop.html'), at = (f) => page.indexOf(`roamies/${f}`);
  assert.ok(at('glass.js') > 0 && at('glass.js') < at('agent.js') && at('glass.js') < at('agent-cards.js'), 'desktop.html loads glass.js before agent.js and agent-cards.js');
}

// Regression: the hands trailed behind the body when it moved fast (they sprang after screen points, not body ones).
{
  const kit = src('../../../roamies/10-dither.js');
  assert.match(kit, /spring\(h\.o, tg\[0\] \* R, tg\[1\] \* R/, 'hands spring in the body\'s own space');
  assert.match(kit, /h\.y = m\.y \+ oy \+ h\.o\.y/, 'and ride its hop once');
  assert.match(kit, /lerp\(sx, bx \+ h\.o\.x, arms\)/, 'hands are drawn from where the body is drawn');
}
console.log('looks tests: passed');
