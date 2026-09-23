'use client';

// The hook siblings of shared.ts (which stays pure derivations). Everything
// here reads only the core contexts, per the skin contract (see types.ts);
// wording and layout stay with each skin.

import { useCallback } from 'react';
import { usePlayerActions } from '@/components/player/PlayerCore';
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

/** Keyboard/button volume nudge — clamps to [0, 1] on whole-percent steps. */
export function useVolumeNudge(): (delta: number) => void {
  const { setVolume } = usePlayerActions();
  return useCallback(
    (delta: number) =>
      setVolume(v => Math.min(1, Math.max(0, Math.round((v + delta) * 100) / 100))),
    [setVolume],
  );
}
