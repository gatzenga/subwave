'use client';

import { useCopyToClipboard } from 'usehooks-ts';
import { Card, Btn, Pill } from '../ui';
import { notify } from '../../../lib/notify';
import type { Catalog, StreamMountDoc } from './types';

interface Props {
  catalog: Catalog;
}

function CopyUrl({ url }: { url: string }) {
  const [, copyToClipboard] = useCopyToClipboard();
  const copy = async () => {
    if (await copyToClipboard(url)) notify.info('URL copied');
    else notify.err('Could not copy');
  };
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 truncate text-[12px]">{url}</code>
      <Btn sm onClick={copy}>Copy</Btn>
    </div>
  );
}

// Only ever rendered for a mount that is on, so there is no off state to draw:
// the caller filters, and a row here always ends in a URL you can copy. The
// catalog's prose description is deliberately not shown — the mount path and
// format say it, and this page is a place to grab a URL, not to read. The field
// stays in the catalog and the OpenAPI render, where a stranger does need it.
function MountRow({ m, origin }: { m: StreamMountDoc; origin: string }) {
  return (
    <div className="border border-separator-strong bg-bg px-3 py-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <code className="text-[12px] font-semibold">{m.mount}</code>
        <span className="caption text-muted">{m.format}</span>
        <Pill tone="accent">live</Pill>
      </div>
      <CopyUrl url={`${origin}${m.mount}`} />
    </div>
  );
}

export default function IntegrationsTab({ catalog }: Props) {
  const { origin, apiBase } = catalog;
  const nowPlaying = `${apiBase}/now-playing`;

  // `kind` is absent on a controller predating the split; those are all
  // icecast mounts, so default there rather than dropping them from the page.
  //
  // Switched-off mounts are left out rather than listed with "enable it to get
  // a URL". This page answers "what can I point a player at", and a row for
  // something the operator turned off is an answer to a question nobody asked —
  // the same rule the debug console's mount table follows. Turn one on and it
  // reappears here by itself.
  const hlsMounts = catalog.streamMounts.filter(m => m.kind === 'hls' && m.enabled);
  const icecastMounts = catalog.streamMounts.filter(m => m.kind !== 'hls' && m.enabled);

  return (
    <div className="grid gap-4">
      {/* Two transports, listed apart because they behave differently: HLS is a
          playlist of segments a client re-fetches, the icecast mounts are one
          long-lived socket. Grouping them under one heading invited operators to
          treat "the stream URL" as a single thing when the choice of transport
          is exactly what they are making here. */}
      <Card
        title="HLS stream"
        sub="The default. A rolling playlist of AAC segments, served as static files."
      >
        <div className="grid gap-2.5">
          {hlsMounts.map(m => <MountRow key={m.mount} m={m} origin={origin} />)}
          {hlsMounts.length === 0 && (
            <div className="text-[11px] text-muted italic">
              No HLS mount in this build.
            </div>
          )}
        </div>
      </Card>

      <Card title="Icecast mounts">
        <div className="grid gap-2.5">
          {icecastMounts.map(m => <MountRow key={m.mount} m={m} origin={origin} />)}
        </div>
      </Card>

      <Card
        title="Now-playing feeds"
        sub="Poll these for live metadata — the current track, queue, and station context."
      >
        <div className="grid gap-3">
          <div>
            <div className="caption mb-1">Current track + context</div>
            <CopyUrl url={nowPlaying} />
          </div>
          <div>
            <div className="caption mb-1">Queue + history + DJ log</div>
            <CopyUrl url={`${apiBase}/state`} />
          </div>
          <div className="text-[11px] leading-[1.5] text-muted">
            Both are public JSON, no auth. See the API tab for the full response shapes.
          </div>
        </div>
      </Card>
    </div>
  );
}
