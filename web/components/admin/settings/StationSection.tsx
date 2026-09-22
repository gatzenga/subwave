'use client';

import type { ChangeEvent } from 'react';
import { normalizeStationLocale } from '../../../lib/format';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup,
} from '../../ui/select';
import { Card, Pill, Seg } from '../ui';
import { Advanced } from './section-chrome';
import { LocationPicker } from '../../LocationPicker';
import {
  SectionHeader, SaveBar, SettingsFieldError,
  type SectionProps,
} from './shared';

const ON_OFF = [
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
] as const;

export function StationSection({ data, form, setForm, busy, saveSettings, fieldErrors }: SectionProps) {
  // Persisted state, for the "restart required" pill and the password placeholder.
  const authOnFile = data.values?.privacy?.listenerAuth === true;
  const passwordOnFile = data.values?.privacy?.password === 'set';
  const save = () => saveSettings({
    station: form.station,
    stationDescription: form.stationDescription,
    // Pinned rather than read off the form: their cards are gone, so a value
    // stored before this would be one nothing could change again. '' is the
    // AUTO timezone, i.e. the container's TZ — docker-compose sets
    // Europe/Zurich, which is the point.
    timezone: '',
    locale: form.locale,
    weather: {
      lat: parseFloat(form.weather.lat),
      lng: parseFloat(form.weather.lng),
      locationName: form.weather.locationName,
      units: 'metric',
    },
    privacy: {
      privatePlayer: form.privacy.privatePlayer,
      listenerAuth: form.privacy.listenerAuth,
      // 'set' is the redaction sentinel: the controller ignores it, so an untouched
      // field never clobbers the stored password.
      password: form.privacy.password,
      publishPersonaSouls: form.privacy.publishPersonaSouls,
    },
  });


  return (
    <>
      <SectionHeader
        eyebrow="station"
        title="How the DJ identifies this radio on air."
        metrics={[
          { n: data.values?.station || 'SUB/WAVE', l: 'station', accent: true },
        ]}
      />

      <Card title="Station identity" sub="What the DJ calls this radio on air, and how shared links describe it">
        <div className="field">
          <Label>Station name</Label>
          <Input
            placeholder="SUB/WAVE"
            value={form.station}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setForm(f => ({ ...f, station: e.target.value }))
            }
            className="w-[260px] max-w-full"
            maxLength={80}
          />
          <SettingsFieldError path="station" errors={fieldErrors} />
          <div className="field-hint">
            Substituted into the DJ prompt’s {'{station}'} placeholder (current: {data.values?.station || 'SUB/WAVE'}). Applies live.
          </div>
        </div>

        <div className="field">
          <Label>Share description</Label>
          <Input
            placeholder="A short line describing your station…"
            value={form.stationDescription}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setForm(f => ({ ...f, stationDescription: e.target.value }))
            }
            className="w-full"
            maxLength={200}
          />
          <SettingsFieldError path="stationDescription" errors={fieldErrors} />
          <div className="field-hint">
            The blurb shown when someone shares a link to this station on social
            media or chat. Stays the same whoever is on air; leave it empty and
            the preview falls back to the current DJ’s tagline, which changes
            with the schedule. Never read on air. {form.stationDescription.length}/200.
          </div>
        </div>
      </Card>

      <Card title="Station location" sub="Private forecast point + what the DJ says on air">
        <div className="field">
          <Label>Location</Label>
          <LocationPicker
            variant="admin"
            value={{
              locationName: form.weather.locationName,
              lat: form.weather.lat,
              lng: form.weather.lng,
            }}
            onChange={next =>
              setForm(f => ({ ...f, weather: { ...f.weather, ...next } }))
            }
          />
          <div className="field-hint">
            The point the Open-Meteo forecast is read for (current: {data.values?.weather?.locationName} @ {data.values?.weather?.lat}, {data.values?.weather?.lng}).
            Stays on this page: never spoken on air, never returned by a public
            endpoint. Applies live.
          </div>
        </div>

      </Card>

      <Card title="Localization" sub="Language variant and clock display">
        <div className="field">
          <Label>Station locale</Label>
          <Select
            value={form.locale}
            onValueChange={val =>
              setForm(f => ({ ...f, locale: normalizeStationLocale(val) }))
            }
          >
            <SelectTrigger className="w-[260px] max-w-full" aria-label="Station locale"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="en-GB">English (UK), 24-hour</SelectItem>
                <SelectItem value="en-US">English (US), AM/PM</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <div className="field-hint">
            Sets station-facing display language and clock style. US English uses AM/PM for visible clock times. Applies live.
          </div>
        </div>
      </Card>

      <Card title="Privacy" sub="Keep the station off the open web — one password, two locks">
        <div className="grid gap-3">
          <div className="field">
            <Label>Private player</Label>
            <Seg
              options={[...ON_OFF]}
              value={form.privacy.privatePlayer ? 'on' : 'off'}
              onChange={id =>
                setForm(f => ({ ...f, privacy: { ...f.privacy, privatePlayer: id === 'on' } }))
              }
            />
            <div className="field-hint">
              On: <code>/</code> and <code>/listen</code> ask for the station password
              before showing the player. Hides the interface only — the now-playing
              JSON stays public, so pair it with the stream password to actually gate
              the audio. Applies live.
            </div>
          </div>

          <div className="field">
            <div className="flex items-center gap-2">
              <Label>Stream password</Label>
              {form.privacy.listenerAuth !== authOnFile && (
                <Pill tone="ink">restart required</Pill>
              )}
            </div>
            <Seg
              options={[...ON_OFF]}
              value={form.privacy.listenerAuth ? 'on' : 'off'}
              onChange={id =>
                setForm(f => ({ ...f, privacy: { ...f.privacy, listenerAuth: id === 'on' } }))
              }
            />
            <div className="field-hint">
              Icecast checks every listener connect against the controller, on every
              mount. Turning this on or off needs a mixer restart (danger zone) to
              re-render the Icecast config; password changes apply live. While it&apos;s
              on, the tune-in files (<code>/listen.pls</code>, <code>/listen.m3u</code>)
              are disabled, and if the controller is down new listeners can&apos;t
              connect (already-tuned listeners keep playing).
            </div>
          </div>

          <div className="field">
            <Label>Station password</Label>
            <Input
              type="password"
              autoComplete="new-password"
              value={form.privacy.password === 'set' ? '' : form.privacy.password}
              placeholder={passwordOnFile ? '••••••••  (saved)' : 'shared station password'}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setForm(f => ({ ...f, privacy: { ...f.privacy, password: e.target.value } }))
              }
              className="w-[320px] max-w-full"
            />
            {/* break-words: the tune-in URL below is one 48-char token, wider
                than a phone card. */}
            <div className="field-hint break-words">
              One password for everyone, used by both locks above (Icecast is
              basic-auth only, so there are no per-user accounts). The web player asks
              for it once and remembers it. Radio apps, VLC, Sonos and the native app
              tune in with <code>https://listener:PASSWORD@your-station/stream.mp3</code>
              {' '}— or append <code>?auth=PASSWORD</code> where userinfo isn&apos;t
              supported. No whitespace; max 128 chars. Required before either lock can
              be turned on.
            </div>
          </div>
        </div>
      </Card>

      <Advanced note="the public-API switch">
      <Card title="Public API" sub="What the unauthenticated reads hand out">
        <div className="field">
          <Label>Publish persona souls</Label>
          <Seg
            options={[...ON_OFF]}
            value={form.privacy.publishPersonaSouls ? 'on' : 'off'}
            onChange={id =>
              setForm(f => ({ ...f, privacy: { ...f.privacy, publishPersonaSouls: id === 'on' } }))
            }
          />
          <div className="field-hint">
            On: <code>/schedule</code> and <code>/personas</code> include every
            persona&apos;s soul, so an external site can render the whole roster with
            bios in one request. Off (the default) publishes names, taglines and
            avatars only. A soul is the persona&apos;s system prompt rather than a
            written bio, so leave this off if yours carry private direction — the
            tagline is the field meant for public display. Either way{' '}
            <code>/dj</code> keeps publishing the on-air persona&apos;s soul, as it
            always has. Applies live.
          </div>
        </div>
      </Card>
      </Advanced>

      <SaveBar
        note="Station name, location, timezone, locale, the private player, listener-request limits, and the public-API toggle apply live. Turning the stream password on or off needs a mixer restart."
        busy={busy}
        onSave={save}
        saveLabel="Save station settings"
        errors={fieldErrors}
        ownedKeys={['station', 'stationDescription', 'timezone', 'locale', 'weather', 'privacy']}
      />
    </>
  );
}
