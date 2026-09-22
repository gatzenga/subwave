'use client';

import type { DebugMount, DebugMounts } from './types';

function MountStatus({ m }: { m: DebugMount }) {
  const [label, color] = m.live
    ? ['live', 'text-emerald-500']
    : m.configured
      ? ['down', 'text-red-500']
      : ['off', 'text-muted'];
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${color}`}>
      <span className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

// The right-hand line. `note` wins over a measured bitrate (HLS states its
// fixed ladder instead), and a null listener count reads "not counted" rather
// than 0 — that is the difference between nobody listening and nobody counting.
function mountDetail(m: DebugMount): string {
  if (!m.live) return m.configured ? 'enabled · no source (restart mixer?)' : 'disabled';
  const rate = m.note || (m.bitrate ? `${m.bitrate} kbps` : m.codec === 'FLAC' ? 'lossless' : '—');
  const listeners =
    m.listeners == null
      ? 'listeners not counted'
      : `${m.listeners} ${m.listeners === 1 ? 'listener' : 'listeners'}`;
  const sample = m.sampleRate ? ` · ${(m.sampleRate / 1000).toFixed(1)}k` : '';
  return `${rate} · ${listeners}${sample}`;
}

export function MountsTable({ mounts }: { mounts?: DebugMounts }) {
  if (!mounts) return null;
  return (
    <div className="mt-4 grid gap-3">
      <div className="grid gap-1.5">
        <div className="field-hint tracking-wide uppercase">Listen mounts</div>
        {mounts.list.map(m => (
          <div key={m.path} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[12px]">
            <span className="flex min-w-0 items-center gap-2">
              <MountStatus m={m} />
              <span className="font-medium">{m.codec}</span>
              <code className="truncate text-[11px] text-muted">{m.path}</code>
            </span>
            <span className="text-right text-[11px] text-muted">{mountDetail(m)}</span>
          </div>
        ))}
      </div>
      <div className="grid gap-1">
        <div className="field-hint tracking-wide uppercase">
          Tune-in files · {mounts.tuneIn.entryCount}{' '}
          {mounts.tuneIn.entryCount === 1 ? 'mount' : 'mounts'}
        </div>
        <code className="text-[11px] break-all text-muted">{mounts.tuneIn.pls}</code>
        <code className="text-[11px] break-all text-muted">{mounts.tuneIn.m3u}</code>
      </div>
    </div>
  );
}

// Slugs like "early-morning" / "drive-time" → "Early morning".
export function titleize(s: unknown): string {
  const t = String(s ?? '').replace(/[-_]/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

