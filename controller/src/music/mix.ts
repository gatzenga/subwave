// Pure tempo/key maths over {bpm, key} analysis pairs — SELECTION only (which
// track fits after which); the handover itself is autocue's. Keep it
// import-free: callers resolve analysis (via library.get) and hand it in.

export interface Analysis {
  bpm: number | null;
  key: string | null;
  // Keys the track OPENS / ENDS in, from the measured per-region key ranges.
  // Optional; consumers fall back to the whole-window dominant `key`.
  keyStart?: string | null;
  keyEnd?: string | null;
}

// Duck-typed mirror of library-db's TrackKeyRange (no imports here).
export interface KeyRangeLike {
  startMs: number;
  endMs: number;
  tonic: string;
  mode: string;
}

// Camelot code for a tonic + mode, indexed by pitch class. Mirrors the analyze
// worker's tables, which spell tonics with sharps.
const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_CAMELOT = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const MINOR_CAMELOT = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

export function camelotFor(tonic: string | null | undefined, mode: string | null | undefined): string | null {
  if (!tonic || !mode) return null;
  const pc = PITCH_NAMES.indexOf(tonic.trim().toUpperCase());
  if (pc < 0) return null;
  const m = mode.trim().toLowerCase();
  if (m === 'major') return MAJOR_CAMELOT[pc];
  if (m === 'minor') return MINOR_CAMELOT[pc];
  return null;
}

// The key the track opens in — the first measured range, else the fallback.
export function openingKeyFrom(
  ranges: KeyRangeLike[] | null | undefined,
  fallback: string | null,
): string | null {
  const first = ranges?.[0];
  return (first && camelotFor(first.tonic, first.mode)) ?? fallback;
}

// Slack for "the ranges reach the end": codecs pad/truncate and the duration is
// Subsonic's rounded seconds.
const ENDING_KEY_SLACK_MS = 5000;

// The key the track ends in — the last measured range, but only when the ranges
// cover the track's ending. The analysis window is leading-only (~40s), so on a
// longer track the last range is the key at ~40s and the fallback wins.
export function endingKeyFrom(
  ranges: KeyRangeLike[] | null | undefined,
  durationMs: number | null,
  fallback: string | null,
): string | null {
  const last = ranges && ranges.length ? ranges[ranges.length - 1] : null;
  if (!last || durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) return fallback;
  if (last.endMs < durationMs - ENDING_KEY_SLACK_MS) return fallback;
  return camelotFor(last.tonic, last.mode) ?? fallback;
}

// 0..1 — how close two tempos are, folding half/double time (70 ≈ 140).
export function bpmCompat(a: number | null, b: number | null): number {
  if (!a || !b || a <= 0 || b <= 0) return 0;
  const candidates = [b, b * 2, b / 2];
  let best = 1;
  for (const c of candidates) best = Math.min(best, Math.abs(a - c) / a);
  if (best < 0.03) return 1;
  if (best < 0.06) return 0.6;
  if (best < 0.12) return 0.3;
  return 0;
}

// Parse a Camelot code like '8A' → { n: 8, letter: 'A' }.
export function parseCamelot(code: string | null): { n: number; letter: string } | null {
  if (!code) return null;
  const m = /^(\d{1,2})([AB])$/.exec(code.trim().toUpperCase());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (n < 1 || n > 12) return null;
  return { n, letter: m[2] };
}

// 0..1 — harmonic compatibility on the Camelot wheel: same key, ±1 around the
// wheel, or relative major/minor (same number, other letter).
export function keyCompat(a: string | null, b: string | null): number {
  const ka = parseCamelot(a);
  const kb = parseCamelot(b);
  if (!ka || !kb) return 0;
  if (ka.n === kb.n && ka.letter === kb.letter) return 1;
  if (ka.n === kb.n) return 0.8; // relative major/minor
  if (ka.letter === kb.letter) {
    const d = Math.abs(ka.n - kb.n);
    const wheel = Math.min(d, 12 - d);
    if (wheel === 1) return 0.8; // adjacent on the wheel
  }
  return 0;
}

// Overall mix compatibility 0..1, tempo weighted a touch over key. Key compares
// the pair the seam meets: outgoing ENDING vs incoming OPENING, falling back to
// the whole-window dominant keys.
export function mixCompat(cur: Analysis, next: Analysis): number {
  return 0.6 * bpmCompat(cur.bpm, next.bpm) + 0.4 * keyCompat(cur.keyEnd ?? cur.key, next.keyStart ?? next.key);
}

// Target for a short tempo/key run: nudges BPM with the daypart's energy
// direction, holding the current key. null when the current track is
// un-analysed (nothing to anchor to).
export function pickRunTarget(
  current: Analysis,
  energy: { speed: number; register?: string },
): Analysis | null {
  if (current.bpm == null && current.key == null) return null;
  const dir = energy.speed > 1.0 ? 1 : energy.speed < 1.0 ? -1 : 0;
  const delta = 6 * dir; // ~6 BPM per step in the run's direction
  const bpm = current.bpm != null ? Math.max(50, current.bpm + delta) : null;
  return { bpm, key: current.key };
}
