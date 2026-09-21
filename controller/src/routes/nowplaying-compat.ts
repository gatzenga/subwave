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
import { queue } from '../broadcast/queue.js';
import * as settings from '../settings.js';
import * as library from '../music/library.js';
import { getStreamStatus } from '../broadcast/listeners.js';
import { getStationTimezone } from '../time.js';
import { publicOrigin } from './public.js';

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
    // The cover proxy already fronts Navidrome without exposing credentials.
    // Empty string, not a placeholder URL: a client that tests truthiness
    // should see "no art", not fetch a 404.
    art: id ? `${origin}/api/cover/${encodeURIComponent(id)}` : '',
    custom_fields: {},
  };
}

const secs = (iso?: string | null): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};

router.get('/nowplaying/:station', async (req, res) => {
  try {
    const origin = publicOrigin(req);
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

    res.json({
      station: {
        id: 1,
        name: s.station || 'SUB/WAVE',
        shortcode: String(req.params.station || 'subwave'),
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
            listeners: { total: stream.listeners.current, unique: stream.listeners.current, current: stream.listeners.current },
            path: '/stream.mp3',
            is_default: true,
          },
        ],
        remotes: [],
        hls_enabled: s.stream?.hlsEnabled !== false,
        hls_is_default: s.stream?.hlsEnabled !== false,
        hls_url: `${origin}/hls/live.m3u8`,
        hls_listeners: 0,
      },
      // Icecast counts sockets on its own mounts; an HLS listener fetches
      // static files and never reaches it, so this figure covers the MP3 mount
      // alone. Reported honestly rather than guessed.
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
        song: songOf(origin, np),
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
            song: songOf(origin, next),
          }
        : null,
      song_history: (snap.history || []).slice(0, 10).map((h: any, i: number) => ({
        sh_id: i + 1,
        played_at: secs(h.startedAt),
        duration: 0,
        playlist: '',
        streamer: '',
        is_request: false,
        song: songOf(origin, h),
      })),
      is_online: stream.online,
      cache: null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
