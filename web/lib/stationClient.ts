'use client';

// The one place player code talks to a controller. Every fetch and every
// controller-relative URL (covers, persona avatars) is built here from a
// StationOrigin, so pointing the player at another station means swapping the
// origin (stationOrigin.ts) — no call site hardcodes a path.
//
// Response handling is deliberately per-endpoint: feed endpoints parse JSON
// without an ok-check, /schedule and /themes throw on non-OK, the beacon is
// fire-and-forget. Keep it that way;
// this module is plumbing, not policy.

import { useMemo } from 'react';
import {
  DEFAULT_STATION_ORIGIN,
  useStationOrigin,
  type StationOrigin,
} from '@/lib/stationOrigin';
import type { Theme } from '@/lib/theme';
import type {
  NowPlayingResponse,
  SchedulePayload,
  SessionPayload,
  StationState,
} from '@/lib/types';

export interface ThemesPayload {
  /** The effective theme — what a client should actually paint. */
  active: string;
  /** Which level decided `active`. Absent on an older controller. */
  activeSource?: 'show' | 'station';
  /** settings.theme.active, i.e. what admin's station picker sets. */
  stationDefault?: string;
  /** Set only when an on-air show's themeId outranked the station default. */
  activeShow?: { id: string; name: string; themeId: string } | null;
  themes: Theme[];
}

export interface BeaconPayload {
  referrer: string;
  path: string;
  utmSource?: string;
}

export interface StationClient {
  origin: StationOrigin;
  /** Prefix a controller-relative path with the station's API base.
   *  Empty/nullish input stays '' so `<img>` fallbacks keep working. */
  resolve(path: string | null | undefined): string;
  coverUrl(subsonicId: string): string;
  nowPlaying(): Promise<NowPlayingResponse>;
  state(): Promise<StationState>;
  session(): Promise<SessionPayload>;
  /** The caller owns timeout/abort. */
  health(init?: { signal?: AbortSignal }): Promise<Response>;
  schedule(): Promise<SchedulePayload>;
  themes(): Promise<ThemesPayload>;
  /** Best-effort: never throws, never blocks. */
  beacon(payload: BeaconPayload): void;
}

export function createStationClient(origin: StationOrigin): StationClient {
  const api = origin.apiUrl;
  const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
  return {
    origin,
    resolve: path => (path ? `${api}${path}` : ''),
    coverUrl: subsonicId => `${api}/cover/${encodeURIComponent(subsonicId)}`,
    nowPlaying: () => fetch(`${api}/now-playing`).then(r => json<NowPlayingResponse>(r)),
    state: () => fetch(`${api}/state`).then(r => json<StationState>(r)),
    session: () => fetch(`${api}/session`).then(r => json<SessionPayload>(r)),
    health: init => fetch(`${api}/health`, { cache: 'no-store', signal: init?.signal }),
    schedule: async () => {
      const r = await fetch(`${api}/schedule`);
      if (!r.ok) throw new Error(`schedule fetch ${r.status}`);
      return json<SchedulePayload>(r);
    },
    themes: async () => {
      const r = await fetch(`${api}/themes`);
      if (!r.ok) throw new Error(`themes fetch ${r.status}`);
      return json<ThemesPayload>(r);
    },
    beacon: payload => {
      fetch(`${api}/beacon`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    },
  };
}

/** The install this page is served from: same-origin `/api`, or the
 *  NEXT_PUBLIC_* dev overrides. Install-level concerns (theme registry,
 *  onboarding status) go through this even inside a showcase pointed at a
 *  remote station — they're about *this* deployment, not the tuned one. */
export const defaultStationClient: StationClient =
  createStationClient(DEFAULT_STATION_ORIGIN);

/** Whatever station the surrounding StationOriginProvider points at, or the
 *  default origin when there's no provider. Memoized on the origin's URL
 *  strings, which stay stable even when the origin object identity doesn't. */
export function useStationClient(): StationClient {
  const {
    apiUrl,
    streams: { mp3, opus },
  } = useStationOrigin();
  return useMemo(
    () => createStationClient({ apiUrl, streams: { mp3, opus } }),
    [apiUrl, mp3, opus],
  );
}
