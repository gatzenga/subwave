import { AnimatedLink } from '@/components/ui/animated-link';

// The site-wide 404, catching unmatched URLs and any `notFound()` without a
// closer not-found.tsx. Without this file Next serves its own bare 404 inside
// the root layout.

export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-6 text-ink">
      <main className="max-w-[46ch] text-center">
        <p className="font-mono text-[10px] tracking-[0.2em] text-muted uppercase">Off the dial</p>
        <h1 className="mt-2 text-[clamp(28px,5vw,44px)] leading-[1.1] font-extrabold tracking-[-0.02em]">
          Dead air.
        </h1>
        <p className="mt-3 text-[14px] leading-[1.6] text-muted">
          There&rsquo;s nothing broadcasting on this frequency. The stream itself is
          unaffected — the music keeps playing whatever this page does.
        </p>
        <div className="mt-6">
          <AnimatedLink href="/listen" variant="arrow">
            Back to the player
          </AnimatedLink>
        </div>
      </main>
    </div>
  );
}
