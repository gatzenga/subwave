'use client';

import { Label } from '../../ui/label';
import { Input } from '../../ui/input';
import { Card, Seg } from '../ui';
import { fieldAria } from '../../../lib/form';
import {
  SectionHeader, SaveBar, SettingsFieldError, settingsFieldAria,
  type SectionProps,
} from './shared';
import {
  DJ_RECAP_CHARS_BOUNDS,
  DJ_RECAP_LIMIT_BOUNDS,
  DJ_RECAP_MINUTES_BOUNDS,
} from '@/lib/schemas.generated';

/**
 * Home for decisions about WHEN and HOW the DJ speaks, rather than the engine
 * which renders that speech. Keep policy controls here as they are introduced
 * so the TTS panel remains concerned solely with voice configuration.
 */
export function DjBehaviourSection({ form, setForm, busy, saveSettings, fieldErrors }: SectionProps) {
  const talkPlacementAria = fieldAria('dj-talk-placement', undefined, { hasDescription: true });
  const linkStyleAria = fieldAria('dj-link-release-year', undefined, { hasDescription: true });
  const recapLimitAria = settingsFieldAria(
    'dj-recap-limit',
    fieldErrors['djBehaviour.recapLimit'],
  );
  const recapMinutesAria = settingsFieldAria(
    'dj-recap-minutes',
    fieldErrors['djBehaviour.recapMinutes'],
  );
  const recapCharsAria = settingsFieldAria(
    'dj-recap-chars',
    fieldErrors['djBehaviour.recapChars'],
  );
  const save = async () => {
    await saveSettings({
      djTalkOnlyBetweenTracks: form.djTalkOnlyBetweenTracks,
      djBehaviour: {
        ...form.djBehaviour,
        recapLimit: Number(form.djBehaviour.recapLimit),
        recapMinutes: Number(form.djBehaviour.recapMinutes),
        recapChars: Number(form.djBehaviour.recapChars),
      },
    });
  };

  return (
    <>
      <SectionHeader
        eyebrow="dj behaviour"
        title="Decide how the DJ occupies the station."
      />

      <Card title="Talk placement" sub={form.djTalkOnlyBetweenTracks ? 'between tracks' : 'any time'}>
        <div className="field">
          <Label {...talkPlacementAria.labelledByProps}>Scheduled speech</Label>
          <Seg
            {...talkPlacementAria.groupProps}
            value={form.djTalkOnlyBetweenTracks ? 'between' : 'any'}
            options={[
              { id: 'any', label: 'Any time', title: 'Scheduled segments air on the minute they are written' },
              { id: 'between', label: 'Between tracks', title: 'Scheduled segments wait for the next track boundary' },
            ]}
            onChange={v => setForm(f => ({ ...f, djTalkOnlyBetweenTracks: v === 'between' }))}
          />
          <p {...talkPlacementAria.descriptionProps} className="mt-2 text-[13px] leading-[1.55] text-muted">
            {form.djTalkOnlyBetweenTracks ? (
              <>
                Every <strong>scheduled</strong> segment — station IDs, the hourly time
                check, banter, programme beats and between-track segments — is written
                ahead of time and held for the <strong>next track boundary</strong>, so the
                DJ never ducks a song mid-play. A segment can therefore air a track later
                than its scheduled minute; stale time-sensitive speech is dropped.
              </>
            ) : (
              <>
                Scheduled segments air on the minute they are written, ducking the current
                song. <strong>Station IDs are the exception</strong> and always wait for the
                next track boundary. Turn this on to give every scheduled segment the same
                between-track treatment.
              </>
            )}
          </p>
        </div>
      </Card>

      <Card title="Prompt memory" sub={`${form.djBehaviour.recapLimit} lines · ${form.djBehaviour.recapMinutes} min`}>
        <div className="grid gap-5 sm:grid-cols-3">
          <div className="field" data-invalid={recapLimitAria.invalid || undefined}>
            <Label {...recapLimitAria.labelProps}>Recent lines</Label>
            <Input
              {...recapLimitAria.controlProps}
              type="number"
              min={DJ_RECAP_LIMIT_BOUNDS.min}
              max={DJ_RECAP_LIMIT_BOUNDS.max}
              step="1"
              value={form.djBehaviour.recapLimit}
              onChange={e => setForm(f => ({
                ...f,
                djBehaviour: { ...f.djBehaviour, recapLimit: e.target.value },
              }))}
            />
            <SettingsFieldError
              path="djBehaviour.recapLimit"
              errors={fieldErrors}
              {...recapLimitAria.errorProps}
            />
          </div>
          <div className="field" data-invalid={recapMinutesAria.invalid || undefined}>
            <Label {...recapMinutesAria.labelProps}>Lookback window (minutes)</Label>
            <Input
              {...recapMinutesAria.controlProps}
              type="number"
              min={DJ_RECAP_MINUTES_BOUNDS.min}
              max={DJ_RECAP_MINUTES_BOUNDS.max}
              step="1"
              value={form.djBehaviour.recapMinutes}
              onChange={e => setForm(f => ({
                ...f,
                djBehaviour: { ...f.djBehaviour, recapMinutes: e.target.value },
              }))}
            />
            <SettingsFieldError
              path="djBehaviour.recapMinutes"
              errors={fieldErrors}
              {...recapMinutesAria.errorProps}
            />
          </div>
          <div className="field" data-invalid={recapCharsAria.invalid || undefined}>
            <Label {...recapCharsAria.labelProps}>Characters per line</Label>
            <Input
              {...recapCharsAria.controlProps}
              type="number"
              min={DJ_RECAP_CHARS_BOUNDS.min}
              max={DJ_RECAP_CHARS_BOUNDS.max}
              step="1"
              value={form.djBehaviour.recapChars}
              onChange={e => setForm(f => ({
                ...f,
                djBehaviour: { ...f.djBehaviour, recapChars: e.target.value },
              }))}
            />
            <SettingsFieldError
              path="djBehaviour.recapChars"
              errors={fieldErrors}
              {...recapCharsAria.errorProps}
            />
          </div>
        </div>
        <p className="mt-3 text-[13px] leading-[1.55] text-muted">
          Every DJ script carries this much recent aired speech so the host can avoid
          repeating topics and phrasing. Larger values use more model context. The
          session rolls after four hours; extended and storyteller segments keep their
          longer per-line detail automatically.
        </p>
      </Card>

      <Card title="Link style" sub={form.djBehaviour.releaseYearMentions + ' release-year mentions'}>
        <div className="field">
          <Label {...linkStyleAria.labelledByProps}>Release-year mentions</Label>
          <Seg
            {...linkStyleAria.groupProps}
            value={form.djBehaviour.releaseYearMentions}
            options={[
              { id: 'regular', label: 'Regular', title: 'Keep release years available on every eligible link' },
              { id: 'occasional', label: 'Occasional', title: 'Make release years available on roughly one in four eligible links' },
              { id: 'rare', label: 'Rare', title: 'Make release years available on roughly one in six eligible links' },
            ]}
            onChange={v => setForm(f => ({
              ...f,
              djBehaviour: { ...f.djBehaviour, releaseYearMentions: v as typeof f.djBehaviour.releaseYearMentions },
            }))}
          />
          <p {...linkStyleAria.descriptionProps} className="mt-2 text-[13px] leading-[1.55] text-muted">
            Release years stay verified in the library. This controls how often one is supplied
            to the DJ for a link, keeping factual grounding intact without making every link sound like metadata.
          </p>
        </div>
      </Card>

      <SaveBar
        note="DJ behaviour applies to newly scheduled speech straight away · no mixer restart."
        busy={busy}
        onSave={save}
        saveLabel="Save DJ behaviour"
        errors={fieldErrors}
        ownedKeys={['djTalkOnlyBetweenTracks', 'djBehaviour']}
      />
    </>
  );
}
