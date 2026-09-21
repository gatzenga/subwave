'use client';
// Engine picker + voice selector + sample button for any
// `{engine, voice, cloudProvider}` slot: a persona (`personas[].tts`) or the
// station-wide TTS fallback (`settings.tts.fallback`).
import type { ReactNode } from 'react';
import type { VoiceOption } from '../personas/types';
import type { AdminAuth } from '../../../lib/adminAuth';
import { CB_DEFAULT_VOICE, KOKORO_RE } from '../personas/constants';
import { EngineSelector } from './EngineSelector';
import { VoicePreviewButton } from './VoicePreviewButton';
import { VoicePicker, type VoicePickerGroup } from './VoicePicker';
import { ENGINES, INHERIT_ENGINE, PERSONA_ENGINES, type EngineAvailability } from './engineMeta';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../../ui/select';

const ENGINE_IDS = ENGINES.map(e => e.id);
// Personas may also follow the station default; the fallback slot may not.
const PERSONA_ENGINE_IDS = PERSONA_ENGINES.map(e => e.id);

// Matches the controller's shared voice-slot shape (settings/validate.ts
// validateTtsBlock).
export interface VoiceSlot {
  engine: string;
  voice: string;
  cloudProvider: string;
}

// Shared first half of the red notice; each call site appends its own
// consequence. JSX, so it can't live in the React-free engineMeta.ts.
export const ENGINE_UNAVAILABLE: Record<string, ReactNode> = {
  chatterbox: (
    <>
      Chatterbox isn’t currently available. It lives in the optional{' '}
      <code>tts-heavy</code> sidecar. Start it with{' '}
      <code>docker compose --profile tts-heavy up -d</code> (or set{' '}
      <code>COMPOSE_PROFILES=tts-heavy</code> in <code>.env</code>).
    </>
  ),
  'pocket-tts': (
    <>
      PocketTTS isn’t currently available. It lives in the same optional{' '}
      <code>tts-heavy</code> sidecar as Chatterbox. Start it with{' '}
      <code>docker compose --profile tts-heavy up -d</code> (or set{' '}
      <code>COMPOSE_PROFILES=tts-heavy</code> in <code>.env</code>).
    </>
  ),
  remote: (
    <>
      The remote endpoint isn’t reachable. Configure its URL in
      Settings &rarr; Voice.
    </>
  ),
};

// The slice of GET /settings this component reads. Structural on purpose: the
// Personas and Settings pages model the rest of that payload differently.
export interface EngineVoiceData {
  // Which provider keys the controller can see; feeds the Cloud provider badge.
  env?: Record<string, unknown>;
  tts?: {
    kokoroVoices?: string[];
    kokoroVoiceLanguages?: Record<string, string>;
    piperVoices?: string[];
    chatterboxVoices?: string[];
    pocketTtsVoices?: VoiceOption[];
    pocketTtsCustomVoices?: string[];
    available?: EngineAvailability;
    cloudProviders?: string[];
  };
}

interface EngineVoiceFieldsProps {
  value: VoiceSlot;
  onChange: (patch: Partial<VoiceSlot>) => void;
  data: EngineVoiceData | null;
  adminFetch: AdminAuth['adminFetch'];
  // Omitted where the slot has no rate of its own (the fallback slot).
  previewSpeed?: number;
  previewLanguage?: string;
  // Body of the red notice when `engine` can't speak; wording is caller-supplied.
  /** Retained for callers; nothing renders it now that every engine is bundled. */
  unavailableNote?: (engine: string) => ReactNode;
  // Cloud-specific "this won't play" notice (missing key, disabled engine).
  cloudIssue?: ReactNode;
  engineHint?: ReactNode;
  previewHint?: ReactNode;
  // Personas only: offer "Station default" (the 'inherit' engine). The station
  // rescue slot must not — 'inherit' there names the rung below it in the
  // chain. When set, the caller also supplies the note shown while it is picked.
  allowInherit?: boolean;
  inheritNote?: ReactNode;
  // What 'inherit' resolves to (resolvePersonaVoiceSlot(value, station)) —
  // caller-supplied, since this component has no station block. The preview
  // must post a real engine (the controller rejects 'inherit'), and only
  // piper/kokoro carry the persona's own voice id, so only they offer a voice
  // field while inheriting.
  inheritResolvesTo?: VoiceSlot | null;
}

export function EngineVoiceFields({
  value, onChange, data, adminFetch,
  previewSpeed, previewLanguage,
  engineHint, previewHint,
  allowInherit = false, inheritNote, inheritResolvesTo,
}: EngineVoiceFieldsProps) {
  const inheriting = value.engine === INHERIT_ENGINE.id;
  // What will actually speak. Identical to `value` unless the slot inherits.
  const effective = inheriting && inheritResolvesTo ? inheritResolvesTo : value;
  // Which engine's voice field to render. While inheriting that is only
  // piper/kokoro, the shared id-space the stored voice belongs to (see
  // TTS_INHERITABLE_VOICE_ENGINES in the controller's schemas/persona).
  const voiceEngine = inheriting
    ? (effective.engine === 'piper' || effective.engine === 'kokoro' ? effective.engine : '')
    : value.engine;
  const kokoroVoices: string[] = data?.tts?.kokoroVoices || [];
  const kokoroLanguages = data?.tts?.kokoroVoiceLanguages || {};

  // `voice` is one field shared across engines that each validate it
  // differently, so normalize on engine change: a leftover value (a Kokoro id
  // under pocket-tts) fails the new engine's check on save.
  const selectEngine = (v: string) => {
    const patch: Partial<VoiceSlot> = { engine: v };
    const cur = value.voice.trim();
    if (v === INHERIT_ENGINE.id) {
      // No engine known yet, so no rule to normalise against; the stored id is
      // still wanted if the station is on a local engine, and
      // resolvePersonaVoiceSlot drops it at speak time when it isn't.
      onChange(patch);
      return;
    }
    if (v === 'kokoro' && !KOKORO_RE.test(cur)) patch.voice = 'bf_isabella';
    onChange(patch);
  };

  const selectorAvailable = data?.tts?.available as EngineAvailability | undefined;

  return (
    <>
      <div className="field mb-4">
        <Label>Engine</Label>
        <EngineSelector
          value={value.engine}
          engineIds={allowInherit ? PERSONA_ENGINE_IDS : ENGINE_IDS}
          available={selectorAvailable}
          onChange={selectEngine}
        />
        {engineHint && <div className="field-hint max-w-[70ch]">{engineHint}</div>}
      </div>

      {inheriting && inheritNote && (
        <div className="field-hint mb-4 max-w-[70ch]">{inheritNote}</div>
      )}

      {voiceEngine === 'piper' && (() => {
        const piperVoices: string[] = data?.tts?.piperVoices || [];
        const selected = value.voice || CB_DEFAULT_VOICE;
        // The default entry auditions with voice '' (the engine's built-in);
        // the sentinel only exists because an empty select value is invalid.
        const groups: VoicePickerGroup[] = [{
          voices: [
            { id: CB_DEFAULT_VOICE, label: 'Built-in default voice', previewVoice: '' },
            ...piperVoices.map(v => ({ id: v, label: v })),
            ...(value.voice && !piperVoices.includes(value.voice)
              ? [{ id: value.voice, label: value.voice, hint: 'missing' }]
              : []),
          ],
        }];
        return (
          <div className="field max-w-[360px]">
            <Label>Voice</Label>
            <VoicePicker
              value={selected}
              onChange={val => onChange({ voice: val === CB_DEFAULT_VOICE ? '' : val })}
              groups={groups}
              title="Piper voice"
              placeholder="Built-in default voice"
              preview={{ engine: 'piper', speed: previewSpeed, language: previewLanguage, adminFetch }}
            />
            <div className="field-hint">
              Piper is fast, local, and keyless. Drop a voice’s <code>.onnx</code> and its{' '}
              <code>.onnx.json</code> manifest into <code>state/voices/</code> on the host (the
              same files Home Assistant uses) and they’ll show up here. Leave on the built-in
              default if you don’t have any.
            </div>
          </div>
        );
      })()}

      {voiceEngine === 'kokoro' && (() => {
        const voice = value.voice || 'bf_isabella';
        const langPrefix = voice.charAt(0);
        const filtered = kokoroVoices.filter(v => v.startsWith(langPrefix));
        const fmt = (code: string) => {
          const [lg, name = ''] = code.split('_');
          const g = (lg?.[1] ?? '').toUpperCase();
          const n = name.charAt(0).toUpperCase() + name.slice(1);
          return `${n} (${g})`;
        };
        return (
          <div className="field max-w-[320px]">
            <Label>Kokoro voice</Label>
            <div className="field mt-3">
              <Label>Language</Label>
              <Select
                value={langPrefix}
                onValueChange={lang => {
                  const first = kokoroVoices.find(v => v.startsWith(lang));
                  if (first) onChange({ voice: first });
                }}
              >
                <SelectTrigger aria-label="Language"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {Object.entries(kokoroLanguages).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="field mt-3">
              <Label>Voice</Label>
              <VoicePicker
                value={voice}
                onChange={val => onChange({ voice: val })}
                groups={[{
                  voices: [
                    ...(!filtered.includes(voice) ? [{ id: voice, label: fmt(voice) }] : []),
                    ...filtered.map(v => ({ id: v, label: fmt(v) })),
                  ],
                }]}
                title="Kokoro voice"
                preview={{ engine: 'kokoro', speed: previewSpeed, language: previewLanguage, adminFetch }}
              />
            </div>
            <div className="field-hint">The kokoro-onnx voice id.</div>
          </div>
        );
      })()}

      <div className="mt-4">
        <VoicePreviewButton
          engine={effective.engine}
          voice={effective.voice}
          speed={previewSpeed}
          language={previewLanguage}
          adminFetch={adminFetch}
        />
        {previewHint && <div className="field-hint mt-1.5">{previewHint}</div>}
      </div>
    </>
  );
}
