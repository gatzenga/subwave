'use client';

// The multi-select action bar under the track table: block every selected
// title in one press. Albums and artists stay per-row on purpose — a bulk
// artist block launched from a filtered search takes far more off the air than
// the rows the operator can actually see.

import { Btn } from '../ui';

interface Props {
  count: number;
  busy: boolean;
  onBlock: () => void;
  onClear: () => void;
}

export function BlockSelectedBar({ count, busy, onBlock, onClear }: Props) {
  return (
    <div className="sticky bottom-3 z-20 flex flex-wrap items-center gap-3 border border-ink bg-surface px-3.5 py-2.5 shadow-[0_2px_0_var(--ink)]">
      <span className="text-[12px] font-bold text-ink">
        {count} track{count === 1 ? '' : 's'} selected
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Btn sm onClick={onClear} disabled={busy}>Clear</Btn>
        <Btn sm tone="danger" onClick={onBlock} disabled={busy}>
          {busy ? 'blocking…' : 'Block titles'}
        </Btn>
      </div>
    </div>
  );
}
