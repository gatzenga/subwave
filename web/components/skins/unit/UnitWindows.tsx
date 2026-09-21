'use client';

// The listener /schedule payload carries shows, moods, topics and a persona
// index, not the admin-side steering fields, so the detail pane renders only
// what the station publishes.

import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import styles from './Unit.module.css';
import { usePlayerFeed } from '@/components/player/PlayerCore';
import { useStationClient } from '@/lib/stationClient';
import { cn } from '@/lib/cn';
import { normalizeStationLocale, zonedDayHour } from '@/lib/format';
import type { SchedulePayload, ScheduleShow, StationLocale } from '@/lib/types';
import { boothLines, lastVoiceLine, stationIdentity, turnClock } from '../shared';

export type UnitModal = null | 'timeline' | 'booth';

const EYEBROW =
  'font-mono text-[9px] font-bold tracking-[0.24em] text-[var(--accent)] uppercase';
const CAPTION = 'font-mono text-[9px] font-bold tracking-[0.2em] text-[#7c7669] uppercase';

function CloseKey({ onClose, className }: { onClose: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close window"
      className={cn(
        styles.key,
        'v3-focus flex-none cursor-pointer border-0 px-5 py-3.5 font-mono text-[11px] font-bold tracking-[0.2em] uppercase',
        className,
      )}
    >
      close
    </button>
  );
}

function WindowShell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className={cn(
        styles.glass,
        styles.windowShadow,
        'absolute inset-5 z-30 flex flex-col overflow-y-auto',
        'lg:grid lg:grid-cols-[minmax(0,470px)_minmax(0,1fr)] lg:overflow-hidden',
      )}
    >
      <div className={cn(styles.windowSheen, 'pointer-events-none absolute inset-0')} aria-hidden="true" />
      {children}
    </div>
  );
}

/** Carries the CLOSE key below lg, where the right pane's copy is scrolled out
 *  of reach. */
function RailHeader({
  title,
  caption,
  onClose,
}: {
  title: string;
  caption: string;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-none items-start justify-between gap-4 border-b border-white/12 px-5 pt-[22px] pb-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className={cn(styles.doto, 'text-[28px] leading-none text-[#f4f0e6]')}>{title}</div>
        <div className={CAPTION}>{caption}</div>
      </div>
      <CloseKey onClose={onClose} className="px-4 py-2.5 lg:hidden" />
    </div>
  );
}

function PaneHeader({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="flex flex-none items-start justify-between gap-6 border-b border-white/12 px-5 pt-[22px] pb-[18px] lg:px-[26px]">
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
      <CloseKey onClose={onClose} className="hidden lg:flex" />
    </div>
  );
}

function FieldRow({ k, v, wide }: { k: string; v: string; wide?: boolean }) {
  return (
    <div
      className={cn(
        'grid items-baseline gap-3.5',
        wide ? 'grid-cols-[122px_minmax(0,1fr)]' : 'grid-cols-[108px_minmax(0,1fr)]',
      )}
    >
      <span className="font-mono text-[9px] tracking-[0.16em] text-[#7c7669] uppercase">{k}</span>
      <span className="font-mono text-[12px] leading-[1.4] text-[#e6e0d4]">{v}</span>
    </div>
  );
}

interface TlSlot {
  hour: number;
  endHour: number;
  show: ScheduleShow | null;
  host: string;
  status: 'on air' | 'aired' | 'scheduled';
}

function fmtHour(h: number, locale: StationLocale): string {
  if (locale === 'en-US') return `${h % 12 || 12}${h < 12 ? 'AM' : 'PM'}`;
  return `${String(h).padStart(2, '0')}:00`;
}

export function TimelineWindow({ onClose }: { onClose: () => void }) {
  const client = useStationClient();
  const { activeShow, timezone, locale } = usePlayerFeed();
  const [data, setData] = useState<SchedulePayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  // Snapshotted on open: the grid resolves to whole hours anyway.
  const [now] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const j = await client.schedule();
        if (!cancelled) setData(j);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const tz = data?.timezone ?? timezone;
  const stationLocale = normalizeStationLocale(data?.locale ?? locale);
  const { dow: today, hour: nowHour } = zonedDayHour(now, tz ?? null);

  // Collapse today's 24 hourly cells into contiguous blocks, autonomous gaps
  // included.
  const slots = useMemo<TlSlot[]>(() => {
    if (!data) return [];
    const grid: Array<string | null> = Array.isArray(data.schedule?.[today])
      ? data.schedule[today]
      : Array(24).fill(null);
    const showById = new Map(data.shows.map(s => [s.id, s]));
    const personaById = new Map(data.personas.map(p => [p.id, p.name]));
    const out: TlSlot[] = [];
    let i = 0;
    while (i < 24) {
      const id = grid[i] ?? null;
      let j = i;
      while (j + 1 < 24 && (grid[j + 1] ?? null) === id) j++;
      const show = id ? showById.get(id) || null : null;
      out.push({
        hour: i,
        endHour: j,
        show,
        host: show ? personaById.get(show.personaId) || 'host' : 'unhosted',
        status: nowHour >= i && nowHour <= j ? 'on air' : j < nowHour ? 'aired' : 'scheduled',
      });
      i = j + 1;
    }
    return out;
  }, [data, today, nowHour]);

  const dateLabel = useMemo(() => {
    const opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short' };
    try {
      return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz ?? undefined })
        .format(now)
        .toLowerCase();
    } catch {
      return new Intl.DateTimeFormat('en-GB', opts).format(now).toLowerCase();
    }
  }, [now, tz]);

  const selAt =
    sel ??
    (() => {
      const onAir = slots.findIndex(s => s.status === 'on air');
      if (onAir >= 0) return onAir;
      const firstShow = slots.findIndex(s => s.show);
      return firstShow >= 0 ? firstShow : 0;
    })();
  const selected = slots[selAt] ?? null;
  const showCount = slots.filter(s => s.show).length;
  // Guest names are only published for the LIVE show (they ride /now-playing);
  // future slots stay host-only rather than guessing.
  const selGuests =
    selected?.status === 'on air' && selected.show
      ? (activeShow?.guests ?? []).map(g => g?.name).filter(Boolean).join(', ')
      : '';

  return (
    <WindowShell label="Timeline — today's schedule">
      <div className="flex min-h-0 flex-col border-b border-white/12 lg:border-r lg:border-b-0">
        <RailHeader
          title="TONIGHT"
          caption={`schedule window · ${dateLabel} · ${showCount} slot${showCount === 1 ? '' : 's'}`}
          onClose={onClose}
        />
        <div className="min-h-0 flex-none overflow-y-auto lg:flex-1">
          {!data && !err && (
            <div className={cn(CAPTION, 'px-5 py-6')}>tuning the schedule…</div>
          )}
          {err && (
            <div className={cn(CAPTION, 'px-5 py-6 text-[var(--accent)]')}>
              schedule unavailable · {err}
            </div>
          )}
          {slots.map((s, i) => {
            const on = i === selAt;
            return (
              <button
                key={s.hour}
                type="button"
                onClick={() => setSel(i)}
                aria-pressed={on}
                className={cn(
                  on ? styles.rowSelected : styles.rowIdle,
                  'v3-focus grid w-full cursor-pointer grid-cols-[74px_minmax(0,1fr)] items-baseline gap-3.5 border-0 border-b border-white/9 bg-transparent px-[18px] py-4 text-left',
                )}
              >
                <span
                  className={cn(
                    styles.doto,
                    'text-[17px]',
                    on ? 'text-[#f4f0e6]' : 'text-[#8a8478]',
                  )}
                >
                  {fmtHour(s.hour, stationLocale)}
                </span>
                <span className="flex min-w-0 flex-col gap-1.5">
                  <span
                    className={cn(
                      'truncate font-display text-[21px] leading-[1.05] font-extrabold',
                      on ? 'text-[#f4f0e6]' : 'text-[#b8b1a4]',
                    )}
                  >
                    {s.show ? s.show.name : 'Autonomous'}
                  </span>
                  <span
                    className={cn(
                      'font-mono text-[9px] font-bold tracking-[0.18em] uppercase',
                      s.status === 'on air' ? 'text-[var(--accent)]' : 'text-[#7c7669]',
                    )}
                  >
                    {s.status} · {s.host}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-0 flex-col">
        <PaneHeader onClose={onClose}>
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3.5 gap-y-1">
            <span className={cn(styles.doto, 'text-[20px] text-[var(--accent)]')}>
              {selected ? fmtHour(selected.hour, stationLocale) : '--:--'}
            </span>
            <span className="min-w-0 truncate font-display text-[clamp(24px,2.6vw,34px)] leading-none font-extrabold text-[#f4f0e6]">
              {selected?.show ? selected.show.name : 'Autonomous'}
            </span>
            {selected && (
              <span className={CAPTION}>{selected.status}</span>
            )}
          </div>
          <div className="font-display text-[17px] leading-[1.45] text-[#b8b1a4] italic">
            {selected?.show
              ? selected.show.topic ||
                'No episode notes — the booth plays it by ear.'
              : 'No host this block — the station picks on its own from the time of day, the weather, and whatever the calendar suggests.'}
          </div>
        </PaneHeader>

        <div className="grid min-h-0 flex-1 content-start gap-y-4 overflow-y-auto lg:grid-cols-2 lg:gap-y-0">
          <div className="flex flex-col lg:border-r lg:border-white/12">
            <div className={cn(EYEBROW, 'flex-none px-5 pt-[18px] pb-2.5 lg:px-[26px]')}>
              identity &amp; cast
            </div>
            <div className="flex flex-col gap-2.5 px-5 pb-4 lg:px-[26px]">
              <FieldRow k="host" v={selected?.host ?? '—'} />
              <FieldRow
                k="guests"
                v={selGuests || (selected?.show ? 'none — solo show' : '—')}
              />
              <FieldRow k="id" v={selected?.show?.id ?? '—'} />
            </div>
          </div>
          <div className="flex flex-col">
            <div className={cn(EYEBROW, 'flex-none px-5 pt-[18px] pb-2.5 lg:px-[26px]')}>
              music steering
            </div>
            <div className="flex flex-col gap-2.5 px-5 pb-4 lg:px-[26px]">
              <FieldRow
                k="moods"
                v={
                  selected?.show?.moods?.length
                    ? selected.show.moods.join(', ')
                    : 'the booth reads the room'
                }
              />
              <FieldRow k="lead" v={selected?.show?.mood || '—'} />
              <FieldRow
                k="window"
                v={
                  selected
                    ? `${fmtHour(selected.hour, stationLocale)} – ${fmtHour((selected.endHour + 1) % 24, stationLocale)}`
                    : '—'
                }
              />
            </div>
          </div>
        </div>
        <div className={cn(CAPTION, 'flex-none border-t border-white/12 px-5 py-3 tracking-[0.16em] lg:px-[26px]')}>
          times shown in station local time
        </div>
      </div>
    </WindowShell>
  );
}

export function BoothWindow({ onClose }: { onClose: () => void }) {
  const { dj, activeShow, context, session, streamOnline, timezone, locale } = usePlayerFeed();
  const stationLocale = normalizeStationLocale(locale);
  const { djName, showName } = stationIdentity(dj, activeShow, context);
  const offline = streamOnline === false;
  const tagline = typeof dj?.tagline === 'string' ? dj.tagline : '';
  const voice = lastVoiceLine(session.messages);
  // The kind column prefers the turn's own segment kind over the coarse
  // display class; timestamps key the lookup.
  const kindByT = new Map(
    session.messages.map(m => [String(m.t), typeof m.kind === 'string' ? m.kind : '']),
  );
  const tail = boothLines(session.messages, 8)
    .reverse()
    .map(line => ({ ...line, label: kindByT.get(String(line.t)) || line.kind }));
  const info = session.session;
  const sessionId = typeof info?.id === 'string' ? info.id : null;
  const sinceRaw = info?.['startedAt'];
  const since =
    typeof sinceRaw === 'string' || typeof sinceRaw === 'number'
      ? turnClock(sinceRaw, timezone, stationLocale)
      : null;
  const guests = (activeShow?.guests ?? []).map(g => g?.name).filter(Boolean).join(', ');

  return (
    <WindowShell label="Booth — live session feed">
      <div className="flex min-h-0 flex-col border-b border-white/12 lg:border-r lg:border-b-0">
        <RailHeader
          title="BOOTH"
          caption="live session feed · GET /session · read only"
          onClose={onClose}
        />
        <div className="flex flex-none flex-col gap-3.5 border-b border-white/12 px-5 py-[22px]">
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 truncate font-display text-[30px] leading-none font-extrabold text-[#f4f0e6]">
              {djName}
            </span>
            <span
              className={cn(
                'flex flex-none items-center gap-2 font-mono text-[9px] font-bold tracking-[0.18em] uppercase',
                offline ? 'text-[#7c7669]' : 'text-[var(--accent)]',
              )}
            >
              <span
                className={cn(
                  styles.lamp,
                  offline ? styles.lampIdle : styles.lampLive,
                  'size-2',
                )}
                aria-hidden="true"
              />
              {offline ? 'mic cold' : 'mic live'}
            </span>
          </div>
          {tagline && (
            <div className="font-display text-[16px] leading-[1.45] text-[#b8b1a4] italic">
              {tagline}
            </div>
          )}
          <div className="flex flex-col gap-2.5">
            <FieldRow
              wide
              k="show"
              v={`${showName || 'freeform'}${since ? ` · since ${since}` : ''}`}
            />
            <FieldRow wide k="guests" v={guests || 'none — solo show'} />
            <FieldRow
              wide
              k="session"
              v={`${sessionId ?? '—'} · ${session.messages.length} turns · polled 5s`}
            />
          </div>
        </div>
        <div className="min-h-0 flex-1" />
      </div>

      <div className="flex min-h-0 flex-col">
        <PaneHeader onClose={onClose}>
          <div className={EYEBROW}>last off the mic</div>
          <div className={cn(CAPTION, 'tracking-[0.16em]')}>
            {voice ? `${turnClock(voice.t, timezone, stationLocale)} · spoken on air` : 'nothing aired yet'}
          </div>
        </PaneHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 px-5 py-6 lg:px-[26px]">
          <div className="font-display text-[21px] leading-[1.45] text-[#e6e0d4] italic">
            “{voice?.text ?? 'The mic is cold — the music is doing the talking.'}”
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 border-t border-white/12 pt-[18px]">
            <div className={EYEBROW}>session tail · read only</div>
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
              {tail.length === 0 && (
                <div className={CAPTION}>the log fills as the session runs</div>
              )}
              {tail.map((line, i) => (
                <div
                  key={`${line.t ?? i}-${i}`}
                  className="grid grid-cols-[58px_72px_minmax(0,1fr)] items-baseline gap-3.5"
                >
                  <span className={cn(styles.doto, 'text-[13px] text-[#7c7669]')}>
                    {turnClock(line.t, timezone, stationLocale)}
                  </span>
                  <span className="truncate font-mono text-[9px] font-bold tracking-[0.16em] text-[var(--accent)] uppercase">
                    {line.label}
                  </span>
                  <span className="line-clamp-3 font-mono text-[12px] leading-[1.45] text-[#e6e0d4]">
                    {line.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </WindowShell>
  );
}
