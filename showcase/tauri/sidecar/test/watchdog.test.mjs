// The first-token deadline: fires only while nothing has arrived, and any event disarms it.
import assert from 'node:assert/strict';
import { firstEventWatch } from '../watchdog.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let fired = 0;
const slow = firstEventWatch(25, () => { fired++; });
await wait(60);
assert.equal(fired, 1, 'fires once after the deadline');
slow.event();
assert.equal(slow.timedOut, true);
slow.stop();
assert.equal(fired, 1, 'stop after the fact changes nothing');

let early = 0;
const quick = firstEventWatch(40, () => { early++; });
await wait(5);
quick.event({ type: 'text_delta' });
await wait(60);
assert.equal(early, 0, 'the first event disarms it');
assert.equal(quick.timedOut, false);

let stopped = 0;
const cancelled = firstEventWatch(20, () => { stopped++; });
cancelled.stop();
await wait(45);
assert.equal(stopped, 0, 'stop before the deadline prevents it');

console.log('watchdog tests: passed');
