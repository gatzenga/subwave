// The 'inherit' sentinel at the seam that reads a persona's engine without
// going through djPersonaTts(): tts.describeRouting(). It asks
// `engine === '<something>'`, and a raw sentinel answers no, so a missed
// resolve reads as "pinned elsewhere".
//
// Driven against real settings, since the raw and resolved slots differ only
// once the STATION is configured a particular way. STATE_DIR is redirected
// before the first import, hence the dynamic imports.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-persona-seams-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const tts = await import('../src/audio/tts.js');

const INHERIT_PERSONA = {
  id: 'p_seam',
  name: 'Seam',
  soul: 'A test persona.',
  tts: { engine: 'inherit', cloudProvider: 'openai', voice: 'bm_george', gainDb: 0, speed: 1 },
};

test.after(() => rmSync(root, { recursive: true, force: true }));

test('describeRouting reports the RESOLVED engine and voice, and no phantom fallback', async () => {
  // piper is always usable, so an inherit persona resolving to it falls back
  // from nothing. Against the raw slot this read as a standing fallback warn
  // in /debug and the doctor for the shipped default roster.
  await settings.update({
    tts: { defaultEngine: 'piper' },
    personas: settings.get().personas.map((p: any, i: number) =>
      i === 0
        ? { ...p, tts: { engine: 'inherit', cloudProvider: 'openai', voice: 'bm_george', gainDb: 0, speed: 1 } }
        : p,
    ),
    activePersonaId: settings.get().personas[0].id,
  });

  const { spoken } = tts.describeRouting();
  assert.equal(spoken.requested, 'piper', 'the sentinel is not an engine an operator can act on');
  assert.equal(spoken.engine, 'piper');
  assert.equal(spoken.fellBack, false, 'nothing fell back — piper is what the station asked for');
  // piper is one of the two engines an inherited voice id carries to.
  assert.equal(spoken.voice, 'bm_george');
});

test('describeRouting on an inherit persona matches the equivalent PINNED one', async () => {
  // The same station described two ways: any difference is a reporting bug.
  const base = settings.get().personas;
  const withEngine = (engine: string) =>
    base.map((p: any, i: number) =>
      i === 0
        ? { ...p, tts: { engine, cloudProvider: 'openai', voice: 'bm_george', gainDb: 0, speed: 1 } }
        : p,
    );

  await settings.update({ tts: { defaultEngine: 'piper' }, personas: withEngine('inherit') });
  const inherited = tts.describeRouting().spoken;

  await settings.update({ tts: { defaultEngine: 'piper' }, personas: withEngine('piper') });
  const pinned = tts.describeRouting().spoken;

  assert.deepEqual(inherited, pinned);
});
