'use client';

// The hook siblings of shared.ts (which stays pure derivations). Everything
// here reads only the core contexts, per the skin contract (see types.ts);
// wording and layout stay with each skin.

import { useCallback, useEffect, useState } from 'react';
import { usePlayerActions, usePlayerFeed } from '@/components/player/PlayerCore';
import { useLiteMode } from '@/hooks/useLiteMode';

/** Whether a skin may run a JS-driven (motion) transition right now. Lite
 *  mode's `animation: none !important` reaches only CSS keyframes, so a skin
 *  that skips this gate stops honouring the low-power toggle.
 *
 *  Reduced motion is not this hook's job: MotionConfig's reducedMotion="user"
 *  drops transforms app-wide. It preserves opacity-only transitions, so those
 *  must also call useReducedMotion() (see subamp's LCD latch). */
export function useSkinMotion(): boolean {
  const { lite } = useLiteMode();
  return !lite;
}

export interface TrackLike {
  /** Likes are enabled on this station AND a likeable track is on air (jingles
   *  and spoken segments carry no id). Skins hide the heart when false. */
  available: boolean;
  /** This listener already liked the current airing (server-side dedup — no
   *  account, keyed on a hash of the connection). */
  liked: boolean;
  /** Total likes for the current song, all airings. */
  count: number;
  pending: boolean;
  /** Like the current track. No-op while unavailable, pending, or liked. */
  like: () => Promise<void>;
}

/** The heart button's state machine (#991). Wording and iconography stay with
 *  each skin. */
export function useTrackLike(): TrackLike {
  const { likeCurrent, likeStatus } = usePlayerActions();
  const feed = usePlayerFeed();
  const songId = feed.nowPlaying?.subsonic_id || null;

  // enabled starts false ("unknown") so stations with likes off never flash a
  // heart; the first status fetch flips it on.
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<{ songId: string | null; liked: boolean; count: number }>({
    songId: null,
    liked: false,
    count: 0,
  });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ songId, liked: false, count: 0 });
    if (!songId) return;
    likeStatus().then(st => {
      if (cancelled || !st) return;
      setEnabled(st.enabled !== false);
      // Only apply if the answer is about the track we asked for; a status
      // racing a track change paints the wrong liked-state.
      if (st.songId && st.songId !== songId) return;
      setState({ songId, liked: !!st.liked, count: st.count ?? 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [songId, likeStatus]);

  const like = useCallback(async () => {
    if (!songId || pending || (state.liked && state.songId === songId)) return;
    setPending(true);
    try {
      const res = await likeCurrent(songId);
      if (res && (res.ok || res.alreadyLiked)) {
        setState({ songId, liked: true, count: res.count ?? 0 });
      }
    } finally {
      setPending(false);
    }
  }, [songId, pending, state.liked, state.songId, likeCurrent]);

  return {
    available: enabled && !!songId,
    liked: state.liked && state.songId === songId,
    count: state.songId === songId ? state.count : 0,
    pending,
    like,
  };
}

/** Keyboard/button volume nudge — clamps to [0, 1] on whole-percent steps. */
export function useVolumeNudge(): (delta: number) => void {
  const { setVolume } = usePlayerActions();
  return useCallback(
    (delta: number) =>
      setVolume(v => Math.min(1, Math.max(0, Math.round((v + delta) * 100) / 100))),
    [setVolume],
  );
}
