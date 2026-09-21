// Single source of truth for the TTS engine picker, shared by PersonaVoiceCard and
// TtsSection. No React, no DOM — safe to unit-import.

export interface EngineMeta {
  id: string;
  label: string;
  // One-line descriptor under the name — what the operator is choosing.
  blurb: string;
}

// Order mirrors the on-air dispatcher (controller audio/tts.ts ENGINES).
export const ENGINES: EngineMeta[] = [
  { id: 'piper',      label: 'Piper',      blurb: 'Local · fast · keyless' },
  { id: 'kokoro',     label: 'Kokoro',     blurb: 'More natural · multilingual' },
];

// The persona-only "follow the station" card, offered first. Kept out of
// ENGINES because that list also serves the fallback slot and the default-engine
// picker, neither of which can inherit.
export const INHERIT_ENGINE: EngineMeta = {
  id: 'inherit',
  label: 'Station default',
  blurb: 'Follow Settings → TTS voice',
};

export const PERSONA_ENGINES: EngineMeta[] = [INHERIT_ENGINE, ...ENGINES];

/** The engine id as a roster/table chip. Callers that have the station block to
 *  hand should prefer personas/helpers.ts's engineLabel(), which resolves the
 *  inherit sentinel to the engine actually on air. */
export function engineChipLabel(engine: string): string {
  return isInheritEngine(engine) ? 'station default' : engine;
}

/** Whether a slot follows the station rather than naming an engine. */
export function isInheritEngine(engine: string): boolean {
  return engine === INHERIT_ENGINE.id;
}

export const ENGINE_META: Record<string, EngineMeta> = Object.fromEntries(
  [INHERIT_ENGINE, ...ENGINES].map(e => [e.id, e]),
);

export type EngineStatusTone = 'ok' | 'warn';
// Machine-readable readiness; `label` is display copy. 'off' = not usable now
// (EngineSelector mutes the card); 'starting' = transient, badge only.
export type EngineStatusState = 'ready' | 'starting' | 'off';

// Shown by EngineSelector as a persistent note when the *selected* engine isn't ready.
export interface EngineEnableHint {
  reason: string;
  action?: string;
}

export interface EngineStatus {
  label: string;
  tone: EngineStatusTone;
  state: EngineStatusState;
  // Present whenever state !== 'ready'.
  hint?: EngineEnableHint;
}

// SettingsResponse.tts.available — one boolean per engine.
export interface EngineAvailability {
  [engine: string]: boolean | undefined;
}

export type EngineStatusOpts = Record<string, never>;

// Badge + machine state + enable hint in one branch tree so the three can't
// disagree. A missing flag means "not yet known", so only `=== false` is
// flagged. `warn` is the recoverable-problem tone.
export function engineStatus(
  id: string,
  available: EngineAvailability | undefined,
  _opts: EngineStatusOpts = {},
): EngineStatus {
  const a = available || {};
  if (id === 'kokoro') {
    return a.kokoro === false
      ? {
          label: 'unavailable', tone: 'warn', state: 'off',
          hint: { reason: 'Kokoro is not installed in the controller image' },
        }
      : { label: 'ready', tone: 'ok', state: 'ready' };
  }
  if (id === 'piper') return { label: 'ready', tone: 'ok', state: 'ready' };
  return { label: '', tone: 'ok', state: 'ready' };
}
