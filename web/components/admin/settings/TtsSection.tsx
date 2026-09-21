'use client';

import type { ChangeEvent, ReactNode } from 'react';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../../ui/select';
import { Card, Pill, Seg } from '../ui';
import { Advanced } from './section-chrome';
import { EngineSelector } from '../tts/EngineSelector';
import { EngineVoiceFields, ENGINE_UNAVAILABLE } from '../tts/EngineVoiceFields';
import { VoicePreviewButton } from '../tts/VoicePreviewButton';
import { defaultEngineVoice } from '../tts/defaultVoice';
import { ENGINE_META } from '../tts/engineMeta';
import { cn } from '../../../lib/cn';
import {
  SectionHeader, SaveBar,
  type SectionProps, type FormState, type FormUpdater,
  type TtsFallbackForm,
} from './shared';

const TTS_GAIN_ENGINES = ['piper', 'kokoro'] as const;
const TTS_GAIN_MIN = -12;
const TTS_GAIN_MAX = 12;
const TTS_GAIN_STEP = 0.5;

interface TtsSectionProps extends SectionProps {
  adminFetch: (path: string, init?: RequestInit) => Promise<Response>;
  refresh: () => Promise<void>;
}

// Kokoro phonemizer language labels, keyed by the controller's lang codes —
// keep in sync with KOKORO_LANGS in settings.ts.
const KOKORO_LANG_LABELS: Record<string, string> = {
  'en-gb': 'English (UK)',
  'en-us': 'English (US)',
  cmn: 'Chinese (Mandarin)',
  'fr-fr': 'French',
  hi: 'Hindi',
  it: 'Italian',
  ja: 'Japanese',
  'pt-br': 'Portuguese (Brazilian)',
  es: 'Spanish',
};

function formatGainDb(v: number): string {
  if (!v) return '0 dB';
  const sign = v > 0 ? '+' : '−';
  return `${sign}${Math.abs(v).toFixed(1)} dB`;
}


function TtsGainField({
  engineId,
  form,
  setForm,
}: {
  engineId: string;
  form: FormState;
  setForm: FormUpdater;
}) {
  const value = form.tts.gainDb?.[engineId] ?? 0;
  return (
    <div className="field mt-4">
      <div className="flex items-center justify-between gap-3">
        <Label>Voice level (dB)</Label>
        <span className="font-mono text-[12px] text-ink tabular-nums">{formatGainDb(value)}</span>
      </div>
      <input
        type="range"
        min={TTS_GAIN_MIN}
        max={TTS_GAIN_MAX}
        step={TTS_GAIN_STEP}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const next = Number(e.target.value);
          setForm(f => ({
            ...f,
            tts: { ...f.tts, gainDb: { ...f.tts.gainDb, [engineId]: next } },
          }));
        }}
        aria-label="Voice level in decibels"
        className="mt-1.5 w-full max-w-[360px] accent-[var(--accent)]"
      />
      <div className="field-hint">
        Trim this engine’s loudness to match your other voices. <code>0 dB</code> = no change.
      </div>
    </div>
  );
}

// Range mirrors the server clamp (clampTtsSpeed: 0.5–2.0×). Piper, Kokoro,
// Cloud and Remote honour speed; chatterbox/pocket-tts ignore it.
const TTS_SPEED_MIN = 0.5;
const TTS_SPEED_MAX = 2;
const TTS_SPEED_STEP = 0.05;

function formatSpeed(v: number): string {
  return `${v.toFixed(2)}×`;
}

function TtsSpeedField({
  engineId,
  form,
  setForm,
}: {
  engineId: string;
  form: FormState;
  setForm: FormUpdater;
}) {
  const value = form.tts.speed?.[engineId] ?? 1;
  const supported = true;
  return (
    <div className="field mt-4">
      <div className="flex items-center justify-between gap-3">
        <Label>Speech speed</Label>
        <span className="font-mono text-[12px] text-ink tabular-nums">{formatSpeed(value)}</span>
      </div>
      <input
        type="range"
        min={TTS_SPEED_MIN}
        max={TTS_SPEED_MAX}
        step={TTS_SPEED_STEP}
        value={value}
        disabled={!supported}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const next = Number(e.target.value);
          setForm(f => ({
            ...f,
            tts: { ...f.tts, speed: { ...f.tts.speed, [engineId]: next } },
          }));
        }}
        aria-label="Speech speed multiplier"
        className={cn('mt-1.5 w-full max-w-[360px] accent-[var(--accent)]', !supported && 'opacity-40')}
      />
      <div className="field-hint">
        {supported
          ? engineId === 'remote'
            ? <>Slow down or speed up this engine. <code>1.00×</code> = no change. Remote applies this base rate locally with ffmpeg when available; persona and programme pacing compose for persona-voiced speech on air. Without ffmpeg, it uses the original audio.</>
            : <>Slow down or speed up this engine. <code>1.00×</code> = no change.</>
          : <>Not supported by this engine: Piper, Kokoro, cloud and Remote honour speed.</>}
      </div>
    </div>
  );
}

// ElevenLabs voice_settings. Ranges match their native 0..1 (stability, style,
// similarity_boost) plus the boolean use_speaker_boost. Rendered only for the
// `elevenlabs` provider — every other provider ignores these fields.

export function TtsSection({ data, form, setForm, busy, saveSettings, adminFetch }: TtsSectionProps) {
  const engines = data.tts?.engines || ['piper'];
  const selectorAvailable = data.tts?.available || {};
  // engineMeta.ts is the one label table (it already backs EngineSelector).
  const engineLabelOf = (id: string) => ENGINE_META[id]?.label || id;

  const save = async () => {
    await saveSettings({
      tts: {
        enabled: form.tts.enabled,
        defaultEngine: form.tts.defaultEngine,
        fallback: form.tts.fallback,
        kokoro: { voice: form.tts.kokoro?.voice, lang: form.kokoroLang },
        // Always sent — the server clamps and drops unknown keys.
        gainDb: form.tts.gainDb,
        speed: form.tts.speed,
      },
    });
  };

  const selectEngine = (engine: string) =>
    setForm(f => ({ ...f, tts: { ...f.tts, defaultEngine: engine } }));

  const savedTts: {
    enabled?: boolean;
    defaultEngine?: string;
    kokoro?: { voice?: string; lang?: string };
    gainDb?: Record<string, number>;
    speed?: Record<string, number>;
  } = data.values?.tts || {};
  const savedEngine: string = savedTts.defaultEngine || 'piper';
  const savedKokoroVoice: string = savedTts.kokoro?.voice || '';
  const savedKokoroLang: string = savedTts.kokoro?.lang || '';
  const savedEngineLabel = engineLabelOf(savedEngine);
  const formEngineLabel = engineLabelOf(form.tts.defaultEngine);

  const savedGainDb: Record<string, number> = savedTts.gainDb || {};
  // Absent reads as 0 unity.
  const gainDirty = TTS_GAIN_ENGINES.some(
    e => (form.tts.gainDb?.[e] ?? 0) !== (savedGainDb[e] ?? 0),
  );

  const savedSpeed: Record<string, number> = savedTts.speed || {};
  // Absent reads as 1.0 unity.
  const speedDirty = TTS_GAIN_ENGINES.some(
    e => (form.tts.speed?.[e] ?? 1) !== (savedSpeed[e] ?? 1),
  );

  const ttsDirty =
    // Absent reads as ON, matching the controller's coercion — so an untouched
    // pre-upgrade settings.json never shows up as dirty.
    form.tts.enabled !== (savedTts.enabled !== false)
    || form.tts.defaultEngine !== savedEngine
    || (form.tts.kokoro?.voice || '') !== savedKokoroVoice
    || (form.kokoroLang || '') !== savedKokoroLang
    || gainDirty
    || speedDirty;

  let activeDetail: ReactNode = null;
  if (savedEngine === 'piper') {
    activeDetail = <>Bundled, no key, no config. Always the safe fallback.</>;
  } else if (savedEngine === 'kokoro') {
    activeDetail = <>Voice <code>{savedKokoroVoice || '—'}</code>. Falls back to Piper if the model isn’t loaded.</>;
  }
  const savedEngineMissing = selectorAvailable[savedEngine] === false;

  return (
    <>
      <SectionHeader
        eyebrow="tts voice"
        title="Pick a voice engine, then configure it."
        sub={<>
          Every spoken segment is voiced by the <strong>persona on air</strong>. Set each
          persona’s engine and voice on the Personas page. Here you pick the station’s
          default engine (used for jingles and as the fallback) and configure whichever
          one you choose.
          {selectorAvailable.kokoro === false && (
            <span className="text-[var(--danger)]"> Kokoro is unavailable in this build.</span>
          )}
        </>}
        metrics={[
          { n: String(engines.length), l: 'engines', accent: true },
        ]}
      />

      <Card title="Station voice" sub={form.tts.enabled ? 'on air' : 'music only'}>
        <div className="field">
          <Label>DJ speech</Label>
          <Seg
            accent
            value={form.tts.enabled ? 'on' : 'off'}
            options={[
              { id: 'on', label: 'On', title: 'The DJ speaks as configured' },
              { id: 'off', label: 'Music only', title: 'The DJ never speaks' },
            ]}
            onChange={v => setForm(f => ({ ...f, tts: { ...f.tts, enabled: v === 'on' } }))}
          />
          <p className="mt-2 text-[13px] leading-[1.55] text-muted">
            {form.tts.enabled ? (
              <>
                Turning this off makes the station <strong>music only</strong>: no links,
                idents, hourly checks, segments, banter, mic-passes, programme beats or
                spoken request intros — and no LLM tokens spent writing them. Music keeps
                playing, listener requests are still queued, and manual triggers on the DJ
                page still fire.
              </>
            ) : (
              <>
                The DJ is <strong>silent</strong>. Tracks are still picked and listener
                requests still queue — they just play without a spoken intro. Manual
                triggers on the DJ page still fire.{' '}
                <strong>Jingles are separate</strong>: pre-rendered stingers keep playing on
                Liquidsoap’s own rotate. Silence those with Jingle ratio <code>0</code> under
                Station (needs a mixer restart).
              </>
            )}
          </p>
        </div>

      </Card>

      <Card title="Voice engine" sub="active default">
        <div className="grid gap-[18px]">
          <div className="flex items-start gap-2.5 border border-[var(--accent)] bg-[var(--ink-softer)] p-3">
            <span className="mt-1 size-1.5 flex-none rounded-full bg-vermilion" />
            <div className="grid min-w-0 gap-0.5">
              <span className="text-[11px] font-bold tracking-[0.12em] text-vermilion uppercase">
                Default engine now · {savedEngineLabel}
              </span>
              <span className="text-[14px] leading-[1.5] text-muted">
                {activeDetail} {ttsDirty ? 'Your edits below aren’t live until you Save.' : 'This is the saved, running config.'}
                {savedEngineMissing && (
                  <span className="text-[var(--danger)]"> This engine isn’t installed in this build, so segments fall back to Piper. See the setup steps below.</span>
                )}
              </span>
            </div>
          </div>

          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Engine</Label>
              {ttsDirty && <Pill tone="accent" dot>unsaved</Pill>}
            </div>
            <EngineSelector
              value={form.tts.defaultEngine}
              engineIds={engines}
              available={selectorAvailable}
              onChange={selectEngine}
            />
            <div className="field-hint">
              {ttsDirty
                ? <>Engine changed. Hit "Save TTS settings" below to make <strong>{formEngineLabel}</strong> the new default.</>
                : <>The station default. Renders jingles and is the fallback when a persona’s own engine fails. Per-segment voice still comes from the persona on air.</>}
            </div>
          </div>

        {form.tts.defaultEngine === 'piper' && (
          <>
            <div className="field mt-4">
              <div className="field-hint">
                Piper is bundled with the controller: fast, lightweight, and always
                available. Nothing else to configure.
              </div>
            </div>
            <TtsGainField engineId="piper" form={form} setForm={setForm} />
            <TtsSpeedField engineId="piper" form={form} setForm={setForm} />
          </>
        )}

        {form.tts.defaultEngine === 'kokoro' && (() => {
          const voices = data.tts?.kokoroVoices || [];
          const languages = data.tts?.kokoroVoiceLanguages || {};
          const voice = form.tts.kokoro?.voice ?? 'bf_isabella';
          const langPrefix = voice.charAt(0);
          const filtered = voices.filter(v => v.startsWith(langPrefix));
          const fmt = (code: string) => {
            const [lg, name = ''] = code.split('_');
            const g = (lg?.[1] ?? '').toUpperCase();
            const n = name.charAt(0).toUpperCase() + name.slice(1);
            return `${n} (${g})`;
          };
          const setVoice = (val: string) => setForm(f => ({
            ...f, tts: { ...f.tts, kokoro: { ...f.tts.kokoro, voice: val } },
          }));
          return (
            <>
              <div className="field mt-4">
                <Label>Kokoro voice</Label>
                {selectorAvailable.kokoro === false && (
                  <div className="field-hint text-[var(--danger)]">
                    Kokoro is not installed in this build, so it will fall back to Piper.
                  </div>
                )}
                {voices.length > 0 ? (
                  <>
                    <div className="field mt-3">
                      <Label>Language</Label>
                      <Select
                        value={langPrefix}
                        onValueChange={lang => {
                          const first = voices.find(v => v.startsWith(lang));
                          if (first) setVoice(first);
                        }}
                      >
                        <SelectTrigger aria-label="Language"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {Object.entries(languages).map(([k, v]) => (
                              <SelectItem key={k} value={k}>{v}</SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="field mt-3">
                      <Label>Voice</Label>
                      <Select value={voice} onValueChange={setVoice}>
                        <SelectTrigger aria-label="Voice"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {!filtered.includes(voice) && (
                              <SelectItem value={voice}>{fmt(voice)}</SelectItem>
                            )}
                            {filtered.map(v => (
                              <SelectItem key={v} value={v}>{fmt(v)}</SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                ) : (
                  <div className="field-hint">This build reports no Kokoro voices.</div>
                )}
              </div>
              <div className="field mt-3">
                <Label>Language override</Label>
                <Select
                  value={form.kokoroLang || '__auto__'}
                  onValueChange={val =>
                    setForm(f => ({ ...f, kokoroLang: val === '__auto__' ? '' : val }))
                  }
                >
                  <SelectTrigger className="w-[260px] max-w-full" aria-label="Language override"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="__auto__">Natural, voice default</SelectItem>
                      {(data.tts?.kokoroLangs || []).map(v => (
                        <SelectItem key={v} value={v}>{KOKORO_LANG_LABELS[v] || v}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <div className="field-hint">
                  Force the Kokoro TTS engine to assume a specific language. Leave on <em>Natural</em> to auto-detect from each selected voice.
                </div>
              </div>
              <TtsGainField engineId="kokoro" form={form} setForm={setForm} />
              <TtsSpeedField engineId="kokoro" form={form} setForm={setForm} />
            </>
          );
        })()}

          {(() => {
            const e = form.tts.defaultEngine;
            const previewVoice = defaultEngineVoice(e, form.tts);
            return (
              <div className="field">
                <VoicePreviewButton
                  engine={e}
                  voice={previewVoice}
                  cloudProvider={form.tts.cloud.provider}
                  speed={form.tts.speed?.[e] ?? 1}
                  lang={form.kokoroLang || undefined}
                  adminFetch={adminFetch}
                />
                <div className="field-hint">
                  Auditions the selected engine&apos;s base voice and speed. For persona-voiced
                  speech, persona and programme pacing are applied later on air; so is the dB trim.
                  {e === 'kokoro' ? 'Sample text is English; non-English language settings may sound strange' : ''}
                </div>
              </div>
            );
          })()}
        </div>
      </Card>

      {/* The operator's explicit rescue, ahead of the hardcoded
          default-engine → Piper → Kokoro floor. */}
      <Advanced note="the rescue voice for a persona whose own engine fails">
      <Card
        title="Fallback voice"
        sub="what speaks when a persona's engine fails"
      >
        <div className="field">
          <Label>Fallback</Label>
          <Seg
            value={form.tts.fallback.enabled ? 'on' : 'off'}
            options={[{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }]}
            onChange={v => setForm(f => ({
              ...f,
              tts: { ...f.tts, fallback: { ...f.tts.fallback, enabled: v === 'on' } },
            }))}
          />
          <div className="field-hint max-w-[70ch]">
            When a persona’s engine can’t speak — a sidecar that’s down, a cloud
            provider with no key, or a call that fails mid-render — the station
            rescues the segment so the DJ never goes silent. Off, it rescues onto
            the default engine above and whatever voice that engine happens to
            carry. On, it uses the engine <em>and voice</em> you pick here first,
            and only falls through to Piper if that can’t speak either.
          </div>
        </div>

        {form.tts.fallback.enabled && (
          <div className="mt-4 max-w-[560px]">
            <EngineVoiceFields
              value={form.tts.fallback}
              onChange={(patch: Partial<TtsFallbackForm>) => setForm(f => ({
                ...f,
                tts: { ...f.tts, fallback: { ...f.tts.fallback, ...patch } },
              }))}
              data={data}
              adminFetch={adminFetch}
              engineHint={<>
                Pick something that’s reliably up — a local engine is the safest
                rescue, since the usual reason to need one is a sidecar or cloud
                provider being unreachable.
              </>}
              unavailableNote={(engine: string) => (
                <>{ENGINE_UNAVAILABLE[engine]} A fallback that can’t speak is
                  skipped, so the station would drop to <strong>Piper</strong> instead.</>
              )}
              previewHint={<>
                Plays a short sample in the fallback voice. Worth auditioning —
                you’ll normally only hear it when something has already gone
                wrong.
              </>}
            />
          </div>
        )}
      </Card>
      </Advanced>

      <SaveBar
        note={ttsDirty
          ? `Saving will switch the default engine to ${formEngineLabel}. Applies to jingle rendering and the engine fallback · no mixer restart.`
          : `Default engine: ${savedEngineLabel}. Applies to jingle rendering and the engine fallback · no mixer restart.`}
        busy={busy}
        onSave={save}
        saveLabel="Save TTS settings"
      />
    </>
  );
}
