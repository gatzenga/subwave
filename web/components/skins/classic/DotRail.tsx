'use client';

import { isValidElement, memo, type ReactNode } from 'react';
import { m } from 'motion/react';
import { cn } from '@/lib/cn';
import OdometerNumber from '@/components/OdometerNumber';
import type { PlayerDrawer } from './CommandPalette';

interface RailItem {
  k: PlayerDrawer;
  l: string;
}

const ITEMS: readonly RailItem[] = [
  { k: 'schedule', l: 'Schedule' },
  { k: 'timeline', l: 'Timeline' },
  { k: 'booth',    l: 'Booth' },
];

export interface DotRailProps {
  /** Counts (or icon nodes) keyed by drawer id. */
  counts?: Partial<Record<PlayerDrawer, ReactNode>>;
  active: PlayerDrawer | null;
  onSelect: (id: PlayerDrawer | null) => void;
}

export default memo(function DotRail({ counts, active, onSelect }: DotRailProps) {
  return (
    <div
      // Slimmed on phones; CenterStage's right reserve tracks these widths.
      className="absolute top-20 right-0 bottom-20 z-20 flex w-[76px] flex-col items-center justify-center gap-1 sm:w-24"
    >
      {ITEMS.map(item => {
        const isActive = active === item.k;
        const n: ReactNode = counts?.[item.k] ?? 0;
        const isIcon = isValidElement(n);
        return (
          <button
            key={item.k}
            onClick={() => onSelect(isActive ? null : item.k)}
            className={cn(
              'v3-focus relative flex w-full cursor-pointer flex-col items-center gap-[6px] border-0 px-1 py-[14px] font-[inherit] sm:px-2',
              isActive ? 'text-bg' : 'bg-transparent text-ink',
            )}
            aria-pressed={isActive}
          >
            {/* The spans below need `relative` to sit above this
                absolutely-positioned element. */}
            {isActive && (
              <m.span
                layoutId="dot-rail-active"
                className="absolute inset-0 bg-ink"
                initial={false}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                aria-hidden="true"
              />
            )}
            <span
              className={cn(
                'v3-tab-num relative leading-none',
                'text-[22px] font-extralight',
                isIcon && 'inline-flex h-[22px] items-center justify-center',
                isActive ? 'text-vermilion' : 'text-ink',
              )}
            >
              {typeof n === 'number' ? <OdometerNumber value={n} /> : n}
            </span>
            <span
              className={cn(
                // Tighter tracking so "SCHEDULE" still fits the slim phone rail.
                'relative text-[8px] tracking-[0.2em] uppercase sm:text-[9px] sm:tracking-[0.3em]',
                isActive ? 'text-bg' : 'text-ink',
              )}
            >
              {item.l}
            </span>
          </button>
        );
      })}
    </div>
  );
});
