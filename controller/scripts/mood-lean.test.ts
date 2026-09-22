// The hour's-mood clause on the pick event turn (broadcast/mood-lean.ts).
//
// What is pinned is the SHAPE of the steer, not its wording: that it carries
// the CLAP sound description rather than the mood word (the whole point — the
// tag shelf is small and the sound index is not), that it names searchBySound
// only when the run actually carries it, that it keeps the never-dead-air
// escape, and that it stands down where saying anything would be wrong.

import assert from 'node:assert/strict';
import test from 'node:test';

import { moodLeanClause } from '../src/broadcast/mood-lean.js';

const ENERGETIC = 'high-energy, upbeat, powerful music with a strong driving beat';
const MORNING = 'fresh, gentle, optimistic early-morning music';

test('the clause carries the SOUND description, not just the mood word', () => {
  const c = moodLeanClause('energetic', ENERGETIC, false, true);
  assert.match(c, /"energetic"/);
  assert.ok(c.includes(ENERGETIC), 'the CLAP prompt is the steer — the word alone is what failed');
});

test('with the sound index it names searchBySound and says why', () => {
  const c = moodLeanClause('energetic', ENERGETIC, false, true);
  assert.match(c, /searchBySound/);
  // The reason matters: it is what tells the model this reaches past the tags.
  assert.match(c, /no mood tag covers/);
});

test('without the sound index it steers but never names a tool the run lacks', () => {
  // searchBySound is conditionally registered; pointing at an absent tool
  // spends the single discovery round on a call that cannot resolve.
  const c = moodLeanClause('energetic', ENERGETIC, false, false);
  assert.doesNotMatch(c, /searchBySound/);
  assert.ok(c.includes(ENERGETIC));
  assert.match(c, /Judge your candidates against that feel/);
});

test('a time-of-day mood reads as a feel, which is the case it was written for', () => {
  // "morning" is the mood an LLM tagger almost never returns, so the tag shelf
  // is tiny — the description is the only usable form of it.
  const c = moodLeanClause('morning', MORNING, false, true);
  assert.ok(c.includes(MORNING));
  assert.match(c, /searchBySound/);
});

test('both shapes keep the never-dead-air escape and nothing stronger', () => {
  for (const c of [
    moodLeanClause('energetic', ENERGETIC, false, true),
    moodLeanClause('energetic', ENERGETIC, false, false),
  ]) {
    assert.match(c, /step outside it only when nothing can follow this track/);
  }
});

test('a cleared description falls back to the mood word rather than to silence', () => {
  // moodPromptFor returns the bare word for a mood whose prompt an operator
  // has emptied. A one-word CLAP query is weak, not wrong.
  for (const empty of ['', '   ', null, undefined]) {
    const c = moodLeanClause('energetic', empty, false, true);
    assert.match(c, /feel like: energetic\./);
  }
});

test('a show that pins its own moods is left alone', () => {
  // Operator intent already steers, and on a strict show pickViaAgent turns it
  // into a real lock — a second, softer voice could only argue with it.
  assert.equal(moodLeanClause('energetic', ENERGETIC, true, true), '');
  assert.equal(moodLeanClause('energetic', ENERGETIC, true, false), '');
});

test('no mood is silence, whatever else is passed', () => {
  assert.equal(moodLeanClause(null, ENERGETIC, false, true), '');
  assert.equal(moodLeanClause(undefined, ENERGETIC, false, true), '');
  assert.equal(moodLeanClause('', ENERGETIC, false, true), '');
  assert.equal(moodLeanClause('   ', ENERGETIC, false, true), '');
});

test('the clause opens with a space — it is concatenated, not joined', () => {
  // promptSuffix is a bare template literal of clauses; one that forgot its
  // leading space would weld itself to the favourites list.
  assert.equal(moodLeanClause('energetic', ENERGETIC, false, true).startsWith(' '), true);
  assert.equal(moodLeanClause('energetic', ENERGETIC, false, false).startsWith(' '), true);
});
