// Drain-side clock policy: how long the drain may spend before it must commit
// the music, and when the empty-queue backstop fires a pick. Pure and I/O-free
// for scripts/drain-policy.test.ts.

// Remaining time at which the backstop picks a successor for an on-air track
// that has nothing queued behind it.
export const DRAIN_DEADLINE_SEC = 120;

// Past this the backstop stands down: Liquidsoap needs the next track resolved
// well before the handover, and the auto playlist owns the endgame.
export const HARD_DEADLINE_SEC = 45;

// Minimum gap between deadline-pick ATTEMPTS. The watcher re-enters every 1.5s,
// so without this a fast-failing pick re-fires ~50 times per window. A
// successful pick self-limits, so this only meters failures.
export const DEADLINE_PICK_COOLDOWN_SEC = 25;

// Effective on-air span: [cue_in, min(duration, cue_out)]. Cue values are
// absolute file offsets while startedAt is stamped at cue_in, so the skipped
// head must not count toward the remaining clock.
export function playableDurationSec(
  durationSec: number | null | undefined,
  cueOutSec?: number | null,
  cueInSec?: number | null,
): number | null {
  const dur = typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null;
  if (dur == null) return null;
  const cueOut = typeof cueOutSec === 'number' && Number.isFinite(cueOutSec) && cueOutSec > 0 ? cueOutSec : null;
  const cueIn = typeof cueInSec === 'number' && Number.isFinite(cueInSec) && cueInSec > 0 ? cueInSec : 0;
  return Math.max(0, Math.min(dur, cueOut ?? dur) - cueIn);
}

// Seconds left before the on-air track's EFFECTIVE end (playable span after
// both cue points), so a capped or trimmed track ends when Liquidsoap does.
// Null when unknowable; callers treat null as "cannot schedule".
export function remainingSec(
  nowMs: number,
  startedAtMs: number | null | undefined,
  durationSec: number | null | undefined,
  cueOutSec?: number | null,
  cueInSec?: number | null,
): number | null {
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs)) return null;
  const playable = playableDurationSec(durationSec, cueOutSec, cueInSec);
  if (playable == null) return null;
  return (startedAtMs + playable * 1000 - nowMs) / 1000;
}

// Runway kept for the commit tail after the intro render in one drain pass:
// the bed and track handoff writes (up to 5s each), the loudness lookup and the
// annotate. The pre-render must never eat into it.
export const DRAIN_COMMIT_RESERVE_SEC = 12;

// Below this there is no honest render window left — starting a TTS call that
// cannot finish only delays the music commit for a WAV nobody will use.
export const MIN_PRERENDER_BUDGET_SEC = 5;

// How long the drain may pre-render an intro/link WAV before it MUST commit the
// music (#1409). On a slow TTS engine the render alone can outlast the runway
// and the pick then airs one track late.
//   null — unbounded; the clock is unknowable, so there is no seam to miss.
//   0    — skip the pre-render; airIntro re-renders from introScript at air
//          time, so skipping is cheap and a missed seam is not.
//   >0   — seconds the render may take before the drain moves on without it.
export function introRenderBudgetSec(remaining: number | null): number | null {
  if (remaining == null) return null;
  const budget = remaining - DRAIN_COMMIT_RESERVE_SEC;
  return budget >= MIN_PRERENDER_BUDGET_SEC ? budget : 0;
}

// Whether the deadline routine fires the successor pick this tick: inside the
// deadline window and not past the hard deadline, which owns the endgame.
export function shouldDeadlinePick(remaining: number | null): boolean {
  return remaining != null && remaining < DRAIN_DEADLINE_SEC && remaining >= HARD_DEADLINE_SEC;
}
