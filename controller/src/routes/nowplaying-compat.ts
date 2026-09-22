// AzuraCast-compatible now-playing endpoint.
//
// GET /nowplaying/:station returns the field names and nesting AzuraCast's
// /api/nowplaying/<shortcode> uses, so a client written against that API works
// here unchanged. It is a RESHAPE of the same data /now-playing already
// serves, never a second source: both read queue.getNowPlaying() and the
// listener monitor, so the two can't disagree about what is on air.
//
// The `:station` segment is accepted and ignored. AzuraCast hosts many
// stations behind one API and keys them by shortcode; this install is one
// station, so any identifier resolves to it. That lets a client derive the URL
// from whatever it already holds — a stream filename, a slug — without this
// install having to agree on a name.
//
// Fields AzuraCast has and this does not are present with empty/zero values
// rather than absent: a client that reads `song.isrc` should get '' and move
// on, not crash on undefined.
import express from 'express';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { queue } from '../broadcast/queue.js';
import * as settings from '../settings.js';
import * as library from '../music/library.js';
import { getStreamStatus } from '../broadcast/listeners.js';
import { getStationTimezone } from '../time.js';
import { publicOrigin, serveCover } from './public.js';

export const router = express.Router();

interface SongShape {
  id: string;
  text: string;
  artist: string;
  title: string;
  album: string;
  genre: string;
  isrc: string;
  lyrics: string;
  art: string;
  custom_fields: Record<string, unknown>;
}

// AzuraCast's `text` is what a player shows when it has one line: "Artist -
// Title". Built here rather than taken from the annotation so it stays
// consistent whether or not the mixer reported one.
function songOf(
  origin: string,
  shortcode: string,
  stamp: number,
  t: { subsonic_id?: string | null; id?: string | null; title?: string | null; artist?: string | null; album?: string | null; genre?: string | null } | null,
): SongShape {
  const id = String(t?.subsonic_id || t?.id || '');
  const artist = String(t?.artist || '');
  const title = String(t?.title || '');
  return {
    id,
    text: [artist, title].filter(Boolean).join(' - '),
    artist,
    title,
    album: String(t?.album || ''),
    genre: String(t?.genre || ''),
    isrc: '',
    lyrics: '',
    // AzuraCast's own shape, down to the .jpg: clients match on the path and
    // some refuse an extensionless image URL. The trailing -<stamp> is its
    // cache-buster; ours is the airing time, so a re-play refetches.
    // Empty string, not a placeholder URL: a client that tests truthiness
    // should see "no art", not fetch a 404.
    art: id ? `${origin}/api/station/${encodeURIComponent(shortcode)}/art/${encodeURIComponent(id)}-${stamp}.jpg` : '',
    custom_fields: {},
  };
}

const secs = (iso?: string | null): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};

// One built payload, reused for a second.
//
// This is the endpoint a radio client polls, and it polls HARD: Shelv asks
// every 3s PER DEVICE, so three rooms listening is roughly one request a
// second, every second, all day. Building the payload costs a now-playing read
// and a SYNCHRONOUS SQLite lookup, and this controller is one event loop shared
// with the DJ, the tagger and TTS — a blocked loop is a timed-out client, which
// surfaces in the app as "connecting" with no title and no cover while the
// audio (static HLS files, served by the edge) plays on untouched.
//
// A one-second TTL is invisible to a listener sitting ~20s behind the live edge
// and cuts the cost to at most one build per second no matter how many devices
// are tuned in. Single-entry, keyed by origin+shortcode: the key comes from the
// request, so a map would grow with whatever a caller invents.
const NOWPLAYING_CACHE_TTL_MS = 1000;
let npCache: { key: string; at: number; payload: unknown } | null = null;

// The payload, built once and shared by the route and the static writer below.
// One builder on purpose: a second one is how the file and the endpoint start
// describing different songs.
export async function buildNowPlayingPayload(origin: string, shortcode: string): Promise<any> {
  {
    const s = settings.get();
    const np = await queue.getNowPlaying();
    const snap = queue.snapshot();
    const stream = getStreamStatus();

    // Duration and elapsed come from the queue's own record for the airing
    // track. An untracked auto-playlist play has no queue item, so both fall
    // to 0 — AzuraCast's own behaviour for a song it cannot time.
    const cur = queue.current;
    const tracked = np?.subsonic_id && cur?.track?.id === np.subsonic_id ? cur : null;
    const startedAt = tracked?.startedAt || null;
    const rec = np?.subsonic_id ? library.getPlaybackMeta(np.subsonic_id) : null;
    const duration = Math.max(
      0,
      Math.round(Number(np?.duration ?? tracked?.track?.duration ?? rec?.durationSec ?? 0)) || 0,
    );
    const elapsed = startedAt
      ? Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Math.floor((Date.now() - Date.parse(startedAt)) / 1000)))
      : 0;

    if (rec && np && !np.genre) {
      np.genre = rec.genres?.length ? rec.genres.join(', ') : rec.genre ?? null;
    }

    const next = snap.upcoming?.[0] || null;

    const payload = {
      station: {
        id: 1,
        name: s.station || 'SUB/WAVE',
        shortcode,
        description: s.stationDescription || '',
        frontend: 'icecast',
        backend: 'liquidsoap',
        timezone: getStationTimezone(),
        listen_url: `${origin}/stream.mp3`,
        url: origin,
        public_player_url: `${origin}/listen`,
        playlist_pls_url: `${origin}/listen.pls`,
        playlist_m3u_url: `${origin}/listen.m3u`,
        is_public: true,
        // Listener requests were removed from this fork; the flag stays so a
        // client can hide its request UI rather than fail on a missing key.
        requests_enabled: false,
        mounts: [
          {
            id: 1,
            name: 'MP3',
            url: `${origin}/stream.mp3`,
            bitrate: stream.bitrate ?? 0,
            format: 'mp3',
            listeners: { total: stream.listeners.icecast, unique: stream.listeners.icecast, current: stream.listeners.icecast },
            path: '/stream.mp3',
            is_default: true,
          },
        ],
        remotes: [],
        hls_enabled: s.stream?.hlsEnabled !== false,
        hls_is_default: s.stream?.hlsEnabled !== false,
        hls_url: `${origin}/hls/live.m3u8`,
        hls_listeners: stream.listeners.hls ?? 0,
      },
      // Both transports, like every other listener figure the station reports:
      // Icecast sockets plus the HLS leg counted from the edge's playlist log
      // (broadcast/hls-listeners.ts). The per-mount figure above stays
      // Icecast-only, because that mount is what it describes.
      listeners: {
        total: stream.listeners.current,
        unique: stream.listeners.current,
        current: stream.listeners.current,
      },
      live: { is_live: false, streamer_name: '', broadcast_start: null, art: null },
      now_playing: {
        sh_id: 0,
        played_at: secs(startedAt),
        duration,
        playlist: '',
        streamer: '',
        is_request: false,
        song: songOf(origin, shortcode, secs(startedAt), np),
        elapsed,
        remaining: Math.max(0, duration - elapsed),
      },
      playing_next: next
        ? {
            cued_at: secs(next.queuedAt),
            played_at: 0,
            duration: 0,
            playlist: '',
            is_request: false,
            song: songOf(origin, shortcode, 0, next),
          }
        : null,
      song_history: (snap.history || []).slice(0, 10).map((h: any, i: number) => ({
        sh_id: i + 1,
        played_at: secs(h.startedAt),
        duration: 0,
        playlist: '',
        streamer: '',
        is_request: false,
        song: songOf(origin, shortcode, secs(h.startedAt), h),
      })),
      is_online: stream.online,
      cache: null,
    };
    return payload;
  }
}

router.get('/nowplaying/:station', async (req, res) => {
  try {
    const origin = publicOrigin(req);
    const shortcode = String(req.params.station || 'subwave');
    const cacheKey = `${origin}|${shortcode}`;
    if (npCache && npCache.key === cacheKey && Date.now() - npCache.at < NOWPLAYING_CACHE_TTL_MS) {
      res.json(npCache.payload);
      return;
    }
    const payload = await buildNowPlayingPayload(origin, shortcode);
    npCache = { key: cacheKey, at: Date.now(), payload };
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- The static payload the edge serves ------------------------------------
//
// A radio client polls this endpoint HARD — Shelv every 3s PER DEVICE — and
// this controller is ONE event loop shared with the DJ, the tagger and TTS.
// Whenever that loop is busy, every poll waits behind it, the client hits its
// 8s timeout and shows "connecting" with no title and no cover, while the audio
// (static HLS files, served by the edge) plays on untouched.
//
// So the hot path stops going through this process at all: the payload is
// rendered to a file and docker/aio/Caddyfile serves THAT for
// `/api/nowplaying/<anything>`. This is AzuraCast's own answer, in their words
// — "Write JSON file to disk so nginx can serve it without calling the PHP
// stack at all" — and it buys the same resilience: a busy, or even a dead,
// controller still answers instantly with the last known song.
//
// The cost is that `elapsed`/`remaining` are as old as the last write (one
// second). Every client that matters computes elapsed from `played_at` anyway,
// and a listener sits ~20s behind the live edge regardless.
//
// SITE_URL is required, because a file has no request to read a Host from. No
// SITE_URL, no file — and the Caddyfile then falls through to the route above,
// which is the pre-existing behaviour.
const STATIC_FILE = join(config.stateDir, 'nowplaying-static.json');
const STATIC_WRITE_MS = 1000;
let lastStaticJson = '';

async function writeNowPlayingStatic(): Promise<void> {
  const origin = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (!origin) return;
  const payload = await buildNowPlayingPayload(origin, 'subwave');
  const json = JSON.stringify(payload);
  if (json === lastStaticJson) return;
  lastStaticJson = json;
  // Atomic: the edge reads this file constantly, and a half-written one is a
  // parse error in every client at once.
  const tmp = `${STATIC_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, json, 'utf8');
  await rename(tmp, STATIC_FILE);
}

// Starts the writer. One write up front so the file exists before the first
// client asks; failures only log, since a missing file degrades to the route.
export async function startNowPlayingStaticWriter(): Promise<void> {
  if (!(process.env.SITE_URL || '').trim()) {
    console.log('[nowplaying] static file off: SITE_URL not set');
    return;
  }
  await writeNowPlayingStatic().catch(err =>
    console.warn('[nowplaying] static write failed:', err?.message || err),
  );
  setInterval(() => {
    void writeNowPlayingStatic().catch(() => {});
  }, STATIC_WRITE_MS);
}

// --- AzuraCast-shaped artwork paths ----------------------------------------
//
// AzuraCast serves media art at /api/station/{station}/art/{id}[-{stamp}].jpg
// and the current song's art at /api/nowplaying/{station}/art. Clients built
// against it hit those paths directly — Shelv, for one, derives its own
// station-artwork fallback URL from the shortcode without ever reading a field
// we could point elsewhere. Serving the shapes is the only way to answer that.
//
// Everything funnels into the same serveCover() the /cover/:id route uses, so
// there is one proxy, one cache and one failure mode.

// `abc123-1699999999.jpg` → `abc123`. The stamp is a cache-buster, not an
// identifier, so it is stripped before the id is validated. Extension
// optional: AzuraCast's own route makes it optional too.
function mediaIdFrom(file: string): string {
  return String(file || '')
    .replace(/\.jpe?g$/i, '')
    .replace(/-\d+$/, '');
}

async function serveCurrentCover(res: express.Response): Promise<void> {
  const np = await queue.getNowPlaying();
  const id = np?.subsonic_id ? String(np.subsonic_id) : '';
  // 404, never a placeholder image: a client that falls back to its own art
  // should be told there is none, not handed a grey square it will cache.
  if (!id) { res.status(404).end(); return; }
  await serveCover(id, res);
}

router.get('/station/:station/art/:file', async (req, res) => {
  await serveCover(mediaIdFrom(req.params.file), res);
});

router.get('/station/:station/art', async (_req, res) => {
  await serveCurrentCover(res);
});

router.get('/nowplaying/:station/art/:file', async (_req, res) => {
  await serveCurrentCover(res);
});

router.get('/nowplaying/:station/art', async (_req, res) => {
  await serveCurrentCover(res);
});
