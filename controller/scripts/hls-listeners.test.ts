// broadcast/hls-listeners.ts — the HLS leg of the listener count.
// Run: npm test -- hls-listeners
//
// Two halves. The pure half pins what a Caddy access row means (and what it
// does NOT mean: a segment, a master-playlist hit, a 404). The impure half
// drives the real backwards reader over a temp log, including the case the
// design exists for — a roll that would otherwise flash the count to 0 while
// people are listening.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.stateRoot is read from STATE_DIR at import time, so the temp dir has to
// be in place before the module under test is loaded.
const STATE = mkdtempSync(join(tmpdir(), 'subwave-hls-'));
process.env.STATE_DIR = STATE;

const {
  parseHlsLogLine,
  hlsListenerKey,
  foldHits,
  hlsWindowMs,
  refreshHlsListeners,
  hlsListenerCount,
  hlsConnections,
} = await import('../src/broadcast/hls-listeners.js');

const LOG = join(STATE, 'hls-access.log');

// The roll test below leaves a rolled sibling behind, and the reader walks into
// it on purpose — later cases that care about one file clear them first.
function clearRolled() {
  for (const name of readdirSync(STATE)) {
    if (name.startsWith('hls-access-')) rmSync(join(STATE, name));
  }
}

// A real Caddy row, trimmed of the response headers that don't matter here.
function row(opts: {
  atMs: number;
  uri?: string;
  ua?: string;
  ip?: string;
  status?: number;
  clientIp?: string | null;
}): string {
  const request: any = {
    remote_ip: opts.ip ?? '10.0.0.5',
    proto: 'HTTP/1.1',
    method: 'GET',
    host: 'radio.local',
    uri: opts.uri ?? '/hls/aac_320.m3u8',
    headers: { 'User-Agent': [opts.ua ?? 'AppleCoreMedia/1.0'], Accept: ['*/*'] },
  };
  if (opts.clientIp !== null) request.client_ip = opts.clientIp ?? opts.ip ?? '10.0.0.5';
  return JSON.stringify({
    level: 'info',
    ts: opts.atMs / 1000,
    logger: 'http.log.access.hls_access',
    msg: 'handled request',
    request,
    status: opts.status ?? 200,
    size: 412,
  });
}

test('a playlist fetch parses into a hit', () => {
  const hit = parseHlsLogLine(row({ atMs: 1_700_000_000_000 }));
  assert.ok(hit);
  assert.equal(hit.atMs, 1_700_000_000_000);
  assert.equal(hit.rung, 'aac_320');
  assert.equal(hit.ip, '10.0.0.5');
  assert.equal(hit.userAgent, 'AppleCoreMedia/1.0');
  assert.equal(hit.session, null);
});

test('client_ip wins over remote_ip, and falls back to it when absent', () => {
  const forwarded = parseHlsLogLine(
    row({ atMs: 1, ip: '172.18.0.1', clientIp: '203.0.113.9' }),
  );
  assert.equal(forwarded?.ip, '203.0.113.9');
  const direct = parseHlsLogLine(row({ atMs: 1, ip: '172.18.0.1', clientIp: null }));
  assert.equal(direct?.ip, '172.18.0.1');
});

test('a segment is not a listener signal', () => {
  // Caddy is configured not to log these at all; the parser refuses one anyway,
  // because a config that starts logging them must not silently 4x the count.
  assert.equal(parseHlsLogLine(row({ atMs: 1, uri: '/hls/aac_320_17.ts' })), null);
});

test('the master playlist is not counted', () => {
  // Fetched once at tune-in and never again — counting it would keep every
  // curl and link preview on the books for a whole window.
  assert.equal(parseHlsLogLine(row({ atMs: 1, uri: '/hls/live.m3u8' })), null);
});

test('a 404 is a request, not a listener', () => {
  assert.equal(parseHlsLogLine(row({ atMs: 1, status: 404 })), null);
});

test('junk, a torn final line and a non-JSON line are skipped, never thrown on', () => {
  assert.equal(parseHlsLogLine(''), null);
  assert.equal(parseHlsLogLine('   '), null);
  assert.equal(parseHlsLogLine('{"level":"info","ts":17000000'), null);
  assert.equal(parseHlsLogLine('not json at all'), null);
  assert.equal(parseHlsLogLine(JSON.stringify({ ts: 'soon', status: 200 })), null);
});

test('a session id in the query becomes the key, otherwise ip+ua does', () => {
  const withSession = parseHlsLogLine(row({ atMs: 1, uri: '/hls/aac_192.m3u8?s=abc123' }));
  assert.equal(withSession?.session, 'abc123');
  assert.equal(hlsListenerKey(withSession!), 's:abc123');

  const anon = parseHlsLogLine(row({ atMs: 1, ip: '10.0.0.7', ua: 'VLC/3.0' }));
  assert.equal(hlsListenerKey(anon!), 'a:10.0.0.7|VLC/3.0');

  // Two clients behind one address with the same UA collapse into one row. That
  // UNDERSTATES the audience and can never invent one — the documented cost of
  // having no socket to count.
  const twin = parseHlsLogLine(row({ atMs: 2, ip: '10.0.0.7', ua: 'VLC/3.0' }));
  assert.equal(hlsListenerKey(twin!), hlsListenerKey(anon!));
});

test('the window is derived from the segment duration, floored and capped', () => {
  assert.equal(hlsWindowMs(4), 12_000);   // the default ladder
  assert.equal(hlsWindowMs(10), 30_000);
  assert.equal(hlsWindowMs(20), 45_000);  // capped
  assert.equal(hlsWindowMs(1), 12_000);   // floored
  assert.equal(hlsWindowMs(undefined), 12_000);
  assert.equal(hlsWindowMs('nonsense'), 12_000);
});

test('folding dedupes per listener, keeps the newest rung and drops stale hits', () => {
  const now = 1_800_000_000_000;
  const hits = [
    parseHlsLogLine(row({ atMs: now - 9000, ip: '1.1.1.1', uri: '/hls/aac_320.m3u8' }))!,
    parseHlsLogLine(row({ atMs: now - 4000, ip: '1.1.1.1', uri: '/hls/aac_128.m3u8' }))!,
    parseHlsLogLine(row({ atMs: now - 1000, ip: '2.2.2.2', ua: 'VLC/3.0' }))!,
    parseHlsLogLine(row({ atMs: now - 60_000, ip: '3.3.3.3', ua: 'Gone/1.0' }))!,
  ];
  const rows = foldHits(hits, now - 12_000);
  assert.equal(rows.length, 2, 'the client last seen a minute ago is not listening');
  const stepped = rows.find(r => r.ip === '1.1.1.1')!;
  assert.equal(stepped.rung, 'aac_128', 'the rung the client stepped down to is the current one');
  assert.equal(stepped.hits, 2);
  assert.equal(stepped.firstHitMs, now - 9000);
  assert.equal(stepped.lastSeenMs, now - 4000);
});

test('an unreadable log reads UNKNOWN, never a measured zero', async () => {
  // No file yet: an edge that predates the hls_access logger must leave the
  // Icecast leg to decide, exactly as before.
  assert.equal(await refreshHlsListeners(), null);
  assert.equal(hlsListenerCount(), null);
});

test('two live clients count, a departed one does not', async () => {
  const now = Date.now();
  writeFileSync(
    LOG,
    [
      row({ atMs: now - 40_000, ip: '10.0.0.9', ua: 'Old/1.0' }), // left half a minute ago
      row({ atMs: now - 7000, ip: '10.0.0.1', ua: 'Safari/17' }),
      row({ atMs: now - 3000, ip: '10.0.0.1', ua: 'Safari/17' }),
      row({ atMs: now - 2000, ip: '10.0.0.2', ua: 'VLC/3.0', uri: '/hls/aac_128.m3u8' }),
      '', // Caddy's trailing newline
    ].join('\n'),
  );
  assert.equal(await refreshHlsListeners(), 2);
  assert.equal(hlsListenerCount(), 2);

  const conns = hlsConnections(now);
  assert.equal(conns.length, 2);
  const safari = conns.find(c => c.ip === '10.0.0.1')!;
  assert.equal(safari.mount, '/hls/aac_320');
  assert.equal(safari.connections, 1);
  // Measured from the first poll of this run, not fabricated.
  assert.ok(safari.connectedSeconds >= 6 && safari.connectedSeconds <= 9, `got ${safari.connectedSeconds}`);
  assert.equal(conns.find(c => c.ip === '10.0.0.2')!.mount, '/hls/aac_128');
});

test('an empty log is a measured zero, not unknown', async () => {
  writeFileSync(LOG, '');
  assert.equal(await refreshHlsListeners(), 0);
  assert.equal(hlsListenerCount(), 0);
});

test('a listener whose polls stop drops out when the window closes', async () => {
  const now = Date.now();
  writeFileSync(LOG, row({ atMs: now - 11_000, ip: '10.0.0.3', ua: 'Safari/17' }) + '\n');
  assert.equal(await refreshHlsListeners(), 1, 'still inside the 12s window');
  // No new read: the rows are filtered against the clock on every access, so
  // the listener leaves on time rather than at the next tick.
  assert.equal(hlsListenerCount(), 1);
  assert.equal(hlsConnections(now + 2000).length, 0);
});

test('a roll does not flash the count to zero', async () => {
  const now = Date.now();
  // The live file holds only the newest client; the rest is in the rolled
  // sibling Caddy just created. Without the walk-back this would read 1.
  writeFileSync(LOG, row({ atMs: now - 1000, ip: '10.0.0.1', ua: 'Safari/17' }) + '\n');
  writeFileSync(
    join(STATE, 'hls-access-2026-09-22T12-00-00.000.log'),
    [
      row({ atMs: now - 90_000, ip: '10.0.0.8', ua: 'Ancient/1.0' }), // outside the window
      row({ atMs: now - 6000, ip: '10.0.0.2', ua: 'VLC/3.0' }),
      row({ atMs: now - 5000, ip: '10.0.0.4', ua: 'Sonos/1.0' }),
      '',
    ].join('\n'),
  );
  assert.equal(await refreshHlsListeners(), 3);
});

test('HLS switched off is a measured zero, not unknown', async () => {
  // Unknown would leave the combined GATED count unknown forever on an
  // Icecast-only station, and llm.pauseWhenEmpty would never see an empty room.
  const store = await import('../src/settings/store.js');
  const now = Date.now();
  clearRolled();
  writeFileSync(LOG, row({ atMs: now - 1000, ip: '10.0.0.1', ua: 'Safari/17' }) + '\n');
  store.setCache({ stream: { hlsEnabled: false } });
  try {
    assert.equal(await refreshHlsListeners(), 0);
    assert.equal(hlsListenerCount(), 0);
    assert.deepEqual(hlsConnections(), []);
  } finally {
    store.setCache(null);
  }
  assert.equal(await refreshHlsListeners(), 1, 'switching it back on counts again');
});

test('the window follows the configured segment duration', async () => {
  const store = await import('../src/settings/store.js');
  const now = Date.now();
  clearRolled();
  // 26s old: outside the default 12s window, inside the 30s one a 10s segment
  // ladder implies.
  writeFileSync(LOG, row({ atMs: now - 26_000, ip: '10.0.0.1', ua: 'Safari/17' }) + '\n');
  assert.equal(await refreshHlsListeners(), 0);
  store.setCache({ stream: { hlsSegmentDuration: 10 } });
  try {
    assert.equal(await refreshHlsListeners(), 1);
  } finally {
    store.setCache(null);
  }
});

test('playlist freshness ignores the master, which the mixer writes once', async () => {
  // The bug this pins: live.m3u8 only lists the rungs, so Liquidsoap writes it
  // at startup and never again. Reading ITS mtime reported a healthy stream as
  // "no source" a few seconds after boot. The variants are the heartbeat.
  const { hlsPlaylistAgeSec } = await import('../src/broadcast/hls-listeners.js');
  const { mkdirSync, utimesSync } = await import('node:fs');
  const hlsDir = join(STATE, 'hls');
  mkdirSync(hlsDir, { recursive: true });
  const nowSec = Date.now() / 1000;

  assert.equal(await hlsPlaylistAgeSec(), null, 'an empty hls dir reads as no playlist at all');

  writeFileSync(join(hlsDir, 'live.m3u8'), '#EXTM3U\n');
  utimesSync(join(hlsDir, 'live.m3u8'), nowSec - 3600, nowSec - 3600); // written at boot
  writeFileSync(join(hlsDir, 'aac_320.m3u8'), '#EXTM3U\n');
  utimesSync(join(hlsDir, 'aac_320.m3u8'), nowSec - 2, nowSec - 2);    // rewritten every segment

  const age = await hlsPlaylistAgeSec();
  assert.ok(age !== null && age <= 5, `hour-old master must not win, got ${age}`);

  // A mixer that stopped writing goes stale on the variants, which is the
  // reading the debug console turns into "no source".
  utimesSync(join(hlsDir, 'aac_320.m3u8'), nowSec - 300, nowSec - 300);
  const stale = await hlsPlaylistAgeSec();
  assert.ok(stale !== null && stale >= 290, `a stopped mixer must read stale, got ${stale}`);
});
