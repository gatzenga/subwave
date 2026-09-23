import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-extended-sleeves-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { setCache } = await import('../src/settings/store.js');
test('DJ link-style defaults survive a cold load', async () => {
  await settings.load();
  assert.equal(settings.get().djBehaviour.releaseYearMentions, 'regular');

  await settings.update({ djBehaviour: { releaseYearMentions: 'rare' } } as never);

  setCache(null);
  await settings.load();
  assert.equal(settings.get().djBehaviour.releaseYearMentions, 'rare');
});

test('link style refuses an unknown value', async () => {
  await assert.rejects(
    () => settings.update({ djBehaviour: { releaseYearMentions: 'sometimes' } } as never),
    /djBehaviour\.releaseYearMentions must be regular, occasional or rare/,
  );
});

test.after(() => rmSync(root, { recursive: true, force: true }));
