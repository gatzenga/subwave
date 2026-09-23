// music/silence-trim.ts — the controller's dead-air ESTIMATE: which measured
// edge gaps count as silence, and how a trimmed head shifts every onset the
// analyzer measured from byte zero. Nothing here reaches the mixer (autocue
// trims on air); the clock, the playable span and the talk runway read it.
//
// Pinned here: the three guards' DIRECTIONS. Every one of them is a "cut less than the
//     measurement said" rule, and each fails silently in the expensive
//     direction — a min-gap that stops filtering eats a segued album's
//     deliberate space, a lost margin cuts the attack, a lost ceiling lets one
//     bad measurement halve a song.
//
// No audio, no library DB: tracks carry their own measurements so the library
// fallback is never reached HERE. That fallback is the path every real caller
// actually takes, and it has its own file — scripts/silence-trim-library.test.ts.
// Keep the split: this file is the arithmetic, that one is the plumbing, and a
// break in the plumbing is invisible to every assertion below.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), 'subwave-silence-trim-'));

const { resolveSilenceTrim, shiftOnsetMs } = await import('../src/music/silence-trim.js');

// A 200s track with a 6s leading blank and a 9s trailing one. `tailStartMs`
// is where that trailing gap opens, absolute: 200s - 9s.
const GAPPY = {
  duration: 200,
  leadSilenceMs: 6_000,
  tailSilenceMs: 9_000,
  tailStartMs: 191_000,
};

test('a measured gap becomes a cue point, margin kept', async () => {
  const t = resolveSilenceTrim(GAPPY);
  // 6000ms of blank, 250ms left in place → cue in at 5.75s, NOT 6s. The margin
  // is what keeps the cut off the attack; a test asserting 6 here would pass
  // on a build that clipped every transient.
  assert.equal(t.cueInSec, 5.75);
  // The tail is an ABSOLUTE offset: 200s − (9000 − 250)ms.
  assert.equal(t.cueOutSec, 191.25);
});

test('the min gap is a floor, not a hint', async () => {
  // A track that opens a beat late is not dead air.
  assert.equal(resolveSilenceTrim({ duration: 200, leadSilenceMs: 900 }).cueInSec, null);
  // Exactly at the floor still qualifies.
  assert.equal(resolveSilenceTrim({ duration: 200, leadSilenceMs: 1_500 }).cueInSec, 1.25);
});

test('the ceiling bounds one bad measurement', async () => {
  // 5 minutes of "silence" on a 600s track is a broken measurement. It is
  // still acted on — but only up to MAX_TRIM_SEC, so the damage is bounded at
  // 30s rather than five minutes.
  const t = resolveSilenceTrim({
    duration: 600, leadSilenceMs: 300_000, tailSilenceMs: 300_000, tailStartMs: 300_000,
  });
  assert.equal(t.cueInSec, 30);
  assert.equal(t.cueOutSec, 570);
});

test('a degenerate pair yields no cue_out rather than an empty request', async () => {
  // A 4s track whose tail "silence" outlasts it: cue_out would land at or
  // before cue_in, which Liquidsoap resolves as a request with no audio.
  const t = resolveSilenceTrim({
    duration: 4, leadSilenceMs: 2_000, tailSilenceMs: 3_500, tailStartMs: 500,
  });
  assert.equal(t.cueOutSec, null);
  // An unknown duration is the same refusal — a cue_out is absolute, so it
  // cannot be computed without a length to subtract from.
  assert.equal(resolveSilenceTrim({ tailSilenceMs: 9_000 }).cueOutSec, null);
});

test('the cue_out comes off the measured end, not the tagged duration', async () => {
  // The tag says 200s; the analyzer decoded a file that really ends at 203s and
  // reports the gap opening at 194s. Deriving the cue as (duration - gap) would
  // put it at 191.25s — 3s of real music cut off the end for no reason but a
  // stale header. tailStartMs + tailSilenceMs is the end the measurement SAW.
  const t = resolveSilenceTrim({
    duration: 200, tailSilenceMs: 9_000, tailStartMs: 194_000,
  });
  assert.equal(t.cueOutSec, 194.25);
});

test('a row analysed before tailStartMs existed falls back to the duration', async () => {
  // null is "this column predates the measurement", not "the gap opens at 0" —
  // the tagged duration is still better than refusing to trim at all.
  const t = resolveSilenceTrim({ duration: 200, tailSilenceMs: 9_000, tailStartMs: null });
  assert.equal(t.cueOutSec, 191.25);
});

test('durationSec is accepted alongside duration', async () => {
  // /now-playing resolves the trim off the lean library row, which spells the
  // length `durationSec`. Reading only `duration` there silently dropped the
  // tail side for every auto-playlist play.
  const t = resolveSilenceTrim({ durationSec: 200, leadSilenceMs: 6_000, tailSilenceMs: 9_000 });
  assert.equal(t.cueInSec, 5.75);
  assert.equal(t.cueOutSec, 191.25);
});

test('unmeasured edges stay untouched', async () => {
  // null is "not measured" (old analysis, capped download, an entirely-silent
  // analysis window), never "zero-length gap".
  assert.deepEqual(
    resolveSilenceTrim({ duration: 200, leadSilenceMs: null, tailSilenceMs: null }),
    { cueInSec: null, cueOutSec: null },
  );
});

test('onsets shift onto the trimmed timeline', async () => {
  // An 8s intro on a track whose first 5.75s are cut is a 2.25s runway on air.
  // Un-shifted, the DJ writes to 8s of runway and talks over the vocal.
  assert.equal(shiftOnsetMs(GAPPY, 8_000), 2_250);
  // An onset inside the trimmed head clamps to zero, never negative.
  assert.equal(shiftOnsetMs(GAPPY, 1_000), 0);
  // No leading trim → the value is passed through untouched.
  assert.equal(shiftOnsetMs({ duration: 200, leadSilenceMs: 100 }, 8_000), 8_000);
  // Un-analysed stays un-analysed: null in, null out, so the intro budget
  // stays a bonus rather than a precondition.
  assert.equal(shiftOnsetMs(GAPPY, null), null);
});
