// Unit pins for the active-station pointer.
// Run: npx tsx scripts/stations-pure.test.ts — auto-discovered by npm test.

import assert from 'node:assert/strict';
import { STATION_ID_RE, parseActivePointer } from '../src/stations/pure.js';

// --- station id validation -------------------------------------------------
assert.ok(STATION_ID_RE.test('main'));
assert.ok(STATION_ID_RE.test('late-night-2'));
assert.ok(STATION_ID_RE.test('a'));
assert.ok(!STATION_ID_RE.test(''));
assert.ok(!STATION_ID_RE.test('Main'));
assert.ok(!STATION_ID_RE.test('-lead'));
assert.ok(!STATION_ID_RE.test('../evil'));
assert.ok(!STATION_ID_RE.test('a/b'));
assert.ok(!STATION_ID_RE.test('a'.repeat(42))); // 41 chars max

// --- active.json parsing ---------------------------------------------------
assert.equal(parseActivePointer('{"activeId":"main"}'), 'main');
assert.equal(parseActivePointer(' {"activeId": "late-night-2"} '), 'late-night-2');
assert.equal(parseActivePointer('{"activeId":"../evil"}'), null);
assert.equal(parseActivePointer('{"activeId":42}'), null);
assert.equal(parseActivePointer('{}'), null);
assert.equal(parseActivePointer('not json'), null);
assert.equal(parseActivePointer(''), null);

console.log('stations-pure.test: OK');
