// Echo's think_it_through tool: a decision checked, then the cards it draws. Run: npm test
import assert from 'node:assert/strict';
import { checkDraw, DrawArgs } from '../draw.mjs';
import { createTools } from '../tools.mjs';
import { THINK_MAX_OPTIONS, thinkBeats, thinkProblems } from '../think.mjs';

const call = {
  decision: 'Take the new job?',
  options: [
    { name: 'Stay', good: 'Steady work and time with family', bad: 'Less room to grow' },
    { name: 'Move', good: 'New work and more money', bad: 'Uproot everyone' },
  ],
  values: ['family', 'growth'],
  lean: 'Stay',
  why: 'The people around you matter more than the raise right now.',
  next: 'Ask whether the new role can be done from home.',
};

assert.deepEqual(thinkProblems(call), [], 'a complete decision is ready');
assert.deepEqual(thinkProblems({ ...call, lean: 'stay' }), [], 'the lean matches an option in any case');
assert.equal(THINK_MAX_OPTIONS, 5);

// Every problem says what to fix, and the lean has to be one of the options.
assert.match(thinkProblems({ ...call, decision: '' }).join('\n'), /decision: needs the choice/);
assert.match(thinkProblems({ ...call, options: [{ name: 'Only', good: 'x' }] }).join('\n'), /options: give 2 to 5/);
assert.match(thinkProblems({ ...call, options: [{ name: 'Same', good: 'x' }, { name: 'same', bad: 'y' }] }).join('\n'), /listed twice/);
assert.match(thinkProblems({ ...call, options: [{ name: 'A' }, { name: 'B' }] }).join('\n'), /give good, bad, or both/);
assert.match(thinkProblems({ ...call, lean: 'Go' }).join('\n'), /lean: "Go" is not one of the options \("Stay", "Move"\)/);
assert.match(thinkProblems({ ...call, why: ' ' }).join('\n'), /why: a sentence/);
assert.match(thinkProblems({ ...call, values: ['a', 'b', 'c', 'd', 'e'] }).join('\n'), /values: at most 4/);

// The cards: what matters, the options, then the lean and why.
const beats = thinkBeats(call, 'Echo');
assert.equal(beats.length, 3);
assert.deepEqual(beats.map((b) => b.marks[0].kind), ['list', 'table', 'quote']);
assert.deepEqual(beats[0].marks[0], { kind: 'list', title: 'what matters most', items: ['family', 'growth'] });
assert.deepEqual(beats[1].marks[0].rows, [
  ['Stay', 'Steady work and time with family', 'Less room to grow'],
  ['Move', 'New work and more money', 'Uproot everyone'],
]);
assert.match(beats[2].marks[0].text, /^I'd lean toward Stay\. The people around you/);
assert.match(beats[2].marks[0].text, /First step: Ask whether/);
assert.equal(beats[2].marks[0].author, 'Echo');
assert.equal(beats[2].say, "I'd lean toward Stay.");

// Without values there is no empty card; a side left out of a trade-off is a dash.
const leanBeats = thinkBeats({ ...call, values: [], options: [{ name: 'Stay', good: 'Steady' }, { name: 'Move', bad: 'Uproot' }], lean: 'stay' }, 'JARVIS');
assert.equal(leanBeats.length, 2);
assert.deepEqual(leanBeats[0].marks[0].rows, [['Stay', 'Steady', '—'], ['Move', '—', 'Uproot']], 'a side left out is a dash');
assert.match(leanBeats[1].marks[0].text, /I'd lean toward Stay\./, "the option's own spelling");
assert.equal(leanBeats[1].marks[0].author, 'JARVIS', 'the card is signed by the look');

// The cards are a valid draw call, and the quote's author survives the schema (it used to be dropped).
const parsed = DrawArgs.parse({ beats });
assert.equal(parsed.beats[2].marks[0].author, 'Echo', 'the author reaches the overlay');
assert.deepEqual(checkDraw({ beats }), [], 'nothing for the draw tool to refuse');

// End to end: the tool draws its three cards through the same pipeline as draw, and a bad decision draws nothing.
{
  const noop = async () => {};
  const events = [];
  const made = createTools({
    allowActions: () => false, userName: 'Test', assistantName: () => 'Echo',
    ui: (m) => { if (m.kind === 'agent' && m.e?.type === 'draw') { events.push(m.e); setImmediate(() => made.ink.started(m.e.id, m.e.seg)); } },
    ask: async () => false, openUrl: noop, onCommitments: noop, showList: noop, fmtWhen: String, commitmentsText: () => '',
  });
  const tool = made.tools.find((t) => t.name === 'think_it_through');
  const result = await tool.execute(call, { toolCallId: 'think1' });
  assert.match(result, /Drew p\d+ list “what matters most”, p\d+ table “Take the new job\?”, p\d+ quote /);
  assert.equal(events.length, 3, 'one draw segment per beat');
  const shown = events.flatMap((e) => e.beats);
  assert.deepEqual(shown.map((b) => b.marks[0].kind), ['list', 'table', 'quote']);
  assert.equal(shown[2].marks[0].author, 'Echo', 'the card is signed by the look');
  assert.equal(shown[2].caption, "I'd lean toward Stay.", 'the beat is captioned as spoken');
  events.length = 0;
  await assert.rejects(tool.execute({ ...call, lean: 'Go' }, { toolCallId: 'think2' }), /lean: "Go" is not one of the options/, 'a bad decision is refused');
  assert.equal(events.length, 0, 'and nothing is drawn');
}
console.log('think it through tests: passed');
