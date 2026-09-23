// The DRAIN side of the show-boundary fade (#1574): `queue.resolveBoundaryCut`
// and the contracts hanging off it. show-boundary.test.ts drives the pure
// policy instead.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-boundary-drain-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { queue } = await import('../src/broadcast/queue.js');
const { getAnnotatedUri } = await import('../src/music/subsonic.js');
const { BOUNDARY_TOLERANCE_SEC } = await import('../src/broadcast/show-boundary.js');

const REMAINING_SEC = 30;   // what is left of the on-air track
const TRACK_SEC = 25 * 60;  // the long record the feature exists for
// A timed TAKEOVER, not a grid hour, so these assertions do not depend on when
// the suite runs: the grid names one show in all 168 slots, leaving the
// takeover's start (#930) as the only candidate.
const boundaryMs = Date.now() + 600_000;

async function seed(opts: { station: boolean; showFade?: boolean | null }) {
  await settings.load();
  await settings.update({ timezone: 'UTC' });
  const personaId = settings.get().personas[0].id;
  const week: Record<number, (string | null)[]> = {};
  for (let d = 0; d < 7; d++) week[d] = Array(24).fill('long');
  await settings.update({
    fadeAtShowEnd: opts.station,
    shows: [{
      id: 'long', name: 'Long Player', topic: 'ambient', personaId,
      fadeAtShowEnd: opts.showFade ?? null,
    }],
    schedule: week,
    // showId null = a Default-programming takeover, so the show on air changes
    // at startedAt even though the grid never stops naming it.
    scheduleOverride: { showId: null, startedAt: boundaryMs, expiresAt: boundaryMs + 3_600_000 },
  });
}

// One track on air and one pick behind it: everything resolveBoundaryCut reads.
function stage(item: Record<string, unknown> = {}) {
  queue.current = {
    track: { id: 'on-air', title: 'On air', artist: 'A', duration: 600 },
    startedAt: new Date(Date.now() - (600 - REMAINING_SEC) * 1000).toISOString(),
  } as never;
  const pick = {
    track: { id: 'pick', title: 'The Long One', artist: 'B', duration: TRACK_SEC },
    ...item,
  } as never;
  queue.upcoming = [pick];
  return pick as unknown as Parameters<typeof queue.resolveBoundaryCut>[0];
}

const NO_TRIM = { cueInSec: null, cueOutSec: null };
const cutFor = (pick: Parameters<typeof queue.resolveBoundaryCut>[0]) =>
  queue.resolveBoundaryCut(pick, TRACK_SEC, NO_TRIM);

// The pick airs when the on-air track ends, so the boundary falls this many
// seconds into it. Same clock the drain reads, hence the tolerance below.
const expectedCueSec = () => (boundaryMs - (Date.now() + REMAINING_SEC * 1000)) / 1000;
const near = (actual: number | undefined, expected: number, what: string) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 3,
    `${what}: expected ~${Math.round(expected)}s, got ${actual}`);

test('a pick that would cross the boundary is cut where the boundary falls', async () => {
  await seed({ station: true });
  const cut = cutFor(stage());
  assert.ok(cut, 'a 25-minute record over a show change is cut');
  near(cut?.cueOutSec, expectedCueSec(), 'the cue lands at the boundary');
  // The overshoot is the policy's own figure, not recomputed from the cue.
  near(cut?.overshootSec, TRACK_SEC - expectedCueSec(), 'the prevented spill rides along');
});

test('the three exemptions each fail toward leaving the track alone', async () => {
  await seed({ station: true });
  assert.equal(cutFor(stage({ requestedBy: 'a listener' })), null,
    'a listener request is an explicit ask and plays in full');

  const pick = stage();
  queue.current = null;
  assert.equal(cutFor(pick), null,
    'no on-air clock means no expected air time to measure a boundary from');

  await seed({ station: false });
  assert.equal(cutFor(stage()), null, 'the station default off leaves every show alone');

  await seed({ station: true, showFade: false });
  assert.equal(cutFor(stage()), null, 'a show can opt out of a station default that is on');

  await seed({ station: false, showFade: true });
  assert.ok(cutFor(stage()), 'and can opt in with the station default off');
});

test('a queued bed pushes the cut back by exactly what it delays the track', async () => {
  await seed({ station: true });
  const plain = cutFor(stage());
  // maybePushBed writes straight to next.txt, so nothing walking `upcoming`
  // sees the bed; uncounted, the cut lands BED_DELAY seconds early.
  const BED_DELAY = 45;
  const bedded = cutFor(stage({ bedded: true, bedDelaySec: BED_DELAY }));
  assert.ok(plain && bedded, 'both pick shapes are cut');
  near(bedded.cueOutSec - plain.cueOutSec, -BED_DELAY,
    'the bed delays the track, so LESS of it plays before the boundary');

  // A bed on an item AHEAD in the chain delays this one just as much.
  queue.current = {
    track: { id: 'on-air', title: 'On air', artist: 'A', duration: 600 },
    startedAt: new Date(Date.now() - (600 - REMAINING_SEC) * 1000).toISOString(),
  } as never;
  const ahead = { sent: true, bedded: true, bedDelaySec: BED_DELAY,
    track: { id: 'ahead', title: 'Ahead', artist: 'C', duration: 0 } } as never;
  const pick = { track: { id: 'pick', title: 'The Long One', artist: 'B', duration: TRACK_SEC } } as never;
  queue.upcoming = [ahead, pick];
  // The ahead item has no usable duration, so the forecast is unknowable.
  assert.equal(cutFor(pick), null, 'an unknowable chain stays unknowable, bed or no bed');
});

test('a queued pause-and-talk break pushes the boundary cut back by its net delay', async () => {
  await seed({ station: true });
  const plain = cutFor(stage());
  const PAUSE_DELAY = 35;
  const paused = cutFor(stage({ pauseDelaySec: PAUSE_DELAY }));
  assert.ok(plain && paused, 'both pick shapes are cut');
  near(paused.cueOutSec - plain.cueOutSec, -PAUSE_DELAY,
    'the hidden break delays the track, so less of it plays before the boundary');
});

test('an armed cut is always earlier than a trimmed tail', async () => {
  await seed({ station: true });
  const late = Math.ceil(expectedCueSec() + 10 * 60);
  const trimmed = queue.resolveBoundaryCut(
    stage(), TRACK_SEC, { cueInSec: null, cueOutSec: late },
  );
  assert.ok(trimmed && trimmed.cueOutSec <= late - BOUNDARY_TOLERANCE_SEC,
    'the cut precedes a trimmed tail by at least the tolerance');
});

test('the cut is the one cue point the mixer is sent', () => {
  const uri = getAnnotatedUri(
    { id: 'pick', title: 'The Long One', artist: 'B' } as never,
    { cueOutSec: 300 } as never,
  );
  assert.match(uri, /liq_cue_out="300"/, 'the cut reaches the mixer');
  assert.doesNotMatch(getAnnotatedUri({ id: 'pick', title: 'T', artist: 'B' } as never),
    /liq_cue_out/, 'and nothing else stamps one — autocue owns the ends');
});

test.after(() => rmSync(root, { recursive: true, force: true }));
