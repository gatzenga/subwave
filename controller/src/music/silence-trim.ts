// Dead-air trim: the single answer to where a track starts and stops making
// sound, read by the queue drain, the auto.m3u rewrite and /now-playing's clock.
//
// Input is the analyzer's ABSOLUTE-floor measurements only. `introMs` and
// `outro.startMs` are relative to the track's own loud level, so a quiet piano
// intro reads as silence; never wire one to a cue point.
//
// Three guards: a minimum gap, a margin at each edge, and MAX_TRIM_SEC.
// Unmeasured input yields null both sides and the track plays whole.
//
// NOT A CUT ANY MORE. autocue trims every track in the mixer from the audio
// itself; nothing computed here is sent to Liquidsoap. What remains is the
// controller's own ESTIMATE of where a track makes sound — the now-playing
// clock, the playable span, the DJ's talk-over runway all read it. So there is
// no operator dial either: a knob that changes an estimate and not the sound
// would be a knob that appears to do nothing.

import * as library from './library.js';

// Keeps the cut off the attack or the decay's last ring; must clear the
// analyzer's frame quantisation (~93ms at 22.05 kHz).
const MARGIN_MS = 250;

// Hard ceiling on what a single edge may lose, whatever the measurement says.
const MAX_TRIM_SEC = 30;

export interface SilenceTrimTrack {
  id?: string | null;
  // Subsonic songs spell it `duration`, library rows `durationSec`; both seconds.
  duration?: number | string | null;
  durationSec?: number | string | null;
  leadSilenceMs?: number | null;
  tailSilenceMs?: number | null;
  tailStartMs?: number | null;
}

export interface SilenceTrimResult {
  // Seconds into the file where the audio begins; null = from byte zero.
  cueInSec: number | null;
  // Seconds into the file where the audio stops, absolute (not a duration);
  // null = to the end.
  cueOutSec: number | null;
}

const NONE: SilenceTrimResult = { cueInSec: null, cueOutSec: null };

// Silence to skip at one edge after the margin, min gap and ceiling apply.
function usableTrimSec(gapMs: number | null | undefined, minGapMs: number): number | null {
  if (typeof gapMs !== 'number' || !Number.isFinite(gapMs) || gapMs <= 0) return null;
  if (gapMs < minGapMs) return null;
  const kept = gapMs - MARGIN_MS;
  if (kept <= 0) return null;
  return Math.min(MAX_TRIM_SEC, kept / 1000);
}

// Resolved in one library read. Track object first, else the library record.
interface Measured {
  leadMs: number | null | undefined;
  tailMs: number | null | undefined;
  tailStartMs: number | null | undefined;
  durSec: number;
}

function measure(track: SilenceTrimTrack): Measured {
  let leadMs = track.leadSilenceMs;
  let tailMs = track.tailSilenceMs;
  let tailStartMs = track.tailStartMs;
  let durSec = Number(track.duration ?? track.durationSec) || 0;
  if ((leadMs == null || tailMs == null || tailStartMs == null || durSec <= 0) && track.id) {
    const rec = library.get(track.id);
    if (leadMs == null) leadMs = rec?.leadSilenceMs ?? null;
    if (tailMs == null) tailMs = rec?.tailSilenceMs ?? null;
    if (tailStartMs == null) tailStartMs = rec?.tailStartMs ?? null;
    if (durSec <= 0) durSec = rec?.durationSec ?? 0;
  }
  return { leadMs, tailMs, tailStartMs, durSec };
}

// Where the analyzer's decode ended, file-absolute. Preferred over the tagged
// duration, which disagrees with the decoded file. Tagged duration is the
// fallback for pre-column rows; null when neither is known, never a guess.
function endReferenceSec(m: Measured): number | null {
  const measuredEndSec = m.tailStartMs != null && m.tailMs != null
    ? (m.tailStartMs + m.tailMs) / 1000
    : null;
  return measuredEndSec ?? (m.durSec > 0 ? m.durSec : null);
}

// Cue-point arithmetic over a resolved measurement set; split out so
// playableSpanSec reaches both halves from one measure() call.
function trimFrom(m: Measured, minGapMs: number): SilenceTrimResult {
  const leadSec = usableTrimSec(m.leadMs, minGapMs);
  const tailSec = usableTrimSec(m.tailMs, minGapMs);
  const endRefSec = endReferenceSec(m);

  // A tail longer than the song yields no stamp: a cue_out at or before the
  // cue_in resolves as an empty request in Liquidsoap.
  let cueOutSec: number | null = null;
  if (tailSec != null && endRefSec != null && endRefSec > 0) {
    const end = endRefSec - tailSec;
    if (end > (leadSec ?? 0) + 1) cueOutSec = Math.round(end * 1000) / 1000;
  }

  return {
    cueInSec: leadSec != null ? Math.round(leadSec * 1000) / 1000 : null,
    cueOutSec,
  };
}

// Gaps shorter than this are not counted as dead air: a track legitimately
// opens a beat after zero. The station default the old dial shipped with.
const MIN_GAP_MS = 1500;

export function resolveSilenceTrim(
  track: SilenceTrimTrack | null | undefined,
): SilenceTrimResult {
  if (!track) return NONE;
  return trimFrom(measure(track), MIN_GAP_MS);
}

// Seconds this track will actually make sound. Null means "no answer", never
// zero. Never subtract the cue points locally (#1594). The end is
// `cueOutSec ?? endReferenceSec`, never the tagged duration, and excludes the
// #447 length cap, which is an on-air cut its one caller is exempt from.
export function playableSpanSec(
  track: SilenceTrimTrack | null | undefined,
): number | null {
  if (!track) return null;
  const m = measure(track);
  const { cueInSec, cueOutSec } = trimFrom(m, MIN_GAP_MS);
  const endSec = cueOutSec ?? endReferenceSec(m);
  if (endSec == null) return null;
  const span = endSec - (cueInSec ?? 0);
  return span > 0 ? Math.round(span * 1000) / 1000 : null;
}

// Shift a file-relative onset onto the TRIMMED timeline: the analyzer measures
// from byte zero, a trimmed track starts at cueInSec. No trim = untouched.
export function shiftOnsetMs(
  track: SilenceTrimTrack | null | undefined,
  onsetMs: number | null | undefined,
): number | null {
  if (onsetMs == null || !Number.isFinite(onsetMs)) return null;
  const { cueInSec } = resolveSilenceTrim(track);
  if (cueInSec == null) return onsetMs;
  return Math.max(0, Math.round(onsetMs - cueInSec * 1000));
}

// Inverse of shiftOnsetMs: a played-timeline offset back onto the file's own
// timeline, which is what `liq_cue_out` carries. Takes a resolved `cueInSec`.
export function absoluteOffsetSec(
  cueInSec: number | null | undefined,
  playedSec: number,
): number {
  const cueIn = typeof cueInSec === 'number' && Number.isFinite(cueInSec) && cueInSec > 0
    ? cueInSec
    : 0;
  return cueIn + playedSec;
}
