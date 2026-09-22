// docker/aio/entrypoint.sh — who the station runs as.
// Run: npm test -- aio-entrypoint
//
// The load-bearing case is the one that looks boring: NO PUID/PGID must mean
// root, unchanged, because that is every station that exists today upgrading
// into this image. A wrong answer there does not degrade the feature, it
// changes the uid of a running station's files.
//
// Drives the real script through its SUBWAVE_ENTRYPOINT_LIB seam, the same way
// aio-log-link.test.ts drives the supervisor.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(here, '../../docker/aio/entrypoint.sh');

// puid, pgid, current uid → what the script decides.
function decide(puid: string, pgid: string, currentUid: string): string {
  return execFileSync(
    'bash',
    ['-c', `SUBWAVE_ENTRYPOINT_LIB=1 source "${SCRIPT}"; subwave_target_ids "${puid}" "${pgid}" "${currentUid}"`],
    { encoding: 'utf8' },
  ).trim();
}

test('no PUID/PGID means root — the upgrade path for every existing station', () => {
  assert.equal(decide('', '', '0'), 'root');
});

test('both set and numeric switches user', () => {
  assert.equal(decide('1001', '1001', '0'), '1001:1001');
  assert.equal(decide('1', '100', '0'), '1:100');
});

test('one without the other is refused, not half-applied', () => {
  // A uid without a gid would leave the group as whatever the image baked in,
  // which is the half-owned state dir this feature exists to end.
  assert.equal(decide('1001', '', '0'), 'root');
  assert.equal(decide('', '1001', '0'), 'root');
});

test('malformed reads as unset, like every other setting in this codebase', () => {
  assert.equal(decide('abc', '1001', '0'), 'root');
  assert.equal(decide('1001', 'root', '0'), 'root');
  assert.equal(decide('10 01', '1001', '0'), 'root');
  assert.equal(decide('-1', '1001', '0'), 'root');
});

test('PUID=0 is "run as root", stated rather than omitted', () => {
  assert.equal(decide('0', '0', '0'), 'root');
});

test('already non-root: nothing to drop from, nothing to rewrite', () => {
  // `docker run --user` got there first. Honour it rather than failing.
  assert.equal(decide('1001', '1001', '1001'), 'root');
  assert.equal(decide('', '', '1001'), 'root');
});
