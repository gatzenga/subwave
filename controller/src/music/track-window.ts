// Track-length policy: the one answer to "is this track pickable at all?".
// The window itself is resolved by settings.effectiveMinTrackSec /
// effectiveMaxTrackSec (show override → station default); this module only
// applies it.
//
// Not part of show-filter.ts's strict locks: it applies whether or not a show
// is strict.
//
// The floor and the ceiling used to be asymmetric — a 40-second skit left the
// pool while an hour-long DJ set stayed eligible and was cut on air with a
// liq_cue_out stamp. That asymmetry was a deliberate design once (a long track
// CAN be shortened where a short one cannot be lengthened), and the operator
// lever it left behind was a fade-out in the middle of a song. Both halves are
// now SELECTION filters, so the cap normally never has anything to cut: an
// over-long track is simply not picked.
//
// The cue-out stamp stays as the backstop, not as the mechanism. Two paths can
// still put an over-long track on air — an operator's own studio push, which
// `requestedBy` exempts from every length rule by design, and the never-starve
// fallback below — and the station must not hand Liquidsoap an hour-long file
// because a filter emptied the pool.
//
// Pure and import-free, so it unit-tests without a library, settings cache or
// mixer (scripts/track-window.test.ts).

// Subsonic children carry `duration`, library rows `durationSec`; neither means
// unknown length. Structurally satisfied by both, so callers pass their own
// element type through unchanged.
export interface LengthTrack {
  duration?: number | null;
  durationSec?: number | null;
}

/** The window a track has to fall in. Either end may be absent. */
export interface TrackWindow {
  min?: number | null;
  max?: number | null;
}

// Track length in seconds, or null when unknown. Zero, negative and non-finite
// all read as unknown. music/recency.durationSeconds delegates here so the cap
// and the floor cannot answer differently.
export function trackLengthSeconds(t: LengthTrack | null | undefined): number | null {
  // First USABLE value, not first present one: `??` would let a `duration: 0`
  // beside a real `durationSec` read as unmeasured and slip past the floor.
  const usable = (d: unknown): number | null =>
    Number.isFinite(d) && (d as number) > 0 ? Number(d) : null;
  return usable(t?.duration) ?? usable(t?.durationSec);
}

// Unknown length passes: a partly-walked library has rows with no duration, and
// dropping those turns a 60s floor into "play only what we measured". `min` of
// 0/null/undefined means no floor.
export function belowTrackFloor(t: LengthTrack | null | undefined, min: number | null | undefined): boolean {
  if (!min || min <= 0) return false;
  const len = trackLengthSeconds(t);
  return len != null && len < min;
}

// The ceiling half, and unknown length passes here for the SAME reason it
// passes the floor — but the consequence differs and is worth stating: an
// unmeasured track that turns out to be an hour long is exactly the case the
// cue-out backstop still catches on air.
export function aboveTrackCeiling(t: LengthTrack | null | undefined, max: number | null | undefined): boolean {
  if (!max || max <= 0) return false;
  const len = trackLengthSeconds(t);
  return len != null && len > max;
}

export function outsideTrackWindow(t: LengthTrack | null | undefined, w: TrackWindow): boolean {
  return belowTrackFloor(t, w.min) || aboveTrackCeiling(t, w.max);
}

// Drop everything outside the window. `starve` follows show-filter
// .applyStrictLocks' convention: true = hard, even to empty (the agent's
// discovery tools, which have wider dead-air scopes behind them); false =
// never-starve, a window that would empty the pool is skipped (pool picker,
// auto.m3u coast).
//
// Never-starve drops BOTH ends together rather than relaxing one: a pool that
// only a 20-minute track can fill is a pool the floor was not what emptied, and
// guessing which end the operator meant less is how a "never-starve" turns into
// a rule that quietly stops applying.
export function applyTrackWindow<T extends LengthTrack>(
  tracks: T[],
  w: TrackWindow,
  { starve }: { starve: boolean },
): T[] {
  const min = w.min && w.min > 0 ? w.min : null;
  const max = w.max && w.max > 0 ? w.max : null;
  // Never hand the input array back: a caller that rebuilds its pool in place
  // (`pool.length = 0; pool.push(...kept)`, as the auto.m3u coast does) would
  // clear the array it is about to spread back in.
  if (!min && !max) return tracks.slice();
  const kept = tracks.filter((t) => !outsideTrackWindow(t, { min, max }));
  if (!starve && kept.length === 0) return tracks.slice();
  return kept;
}
