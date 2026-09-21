import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

// Served by Next at /sitemap.xml. Public, indexable routes only — /admin/* and
// /onboarding are deliberately excluded (noindexed).
const ROUTES = ['/', '/listen'];

// Rendered per-request so SITE_URL comes from the runtime container env rather
// than image-build time: the published image can't know the operator's domain.
// Same reasoning in robots.ts.
export const dynamic = 'force-dynamic';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return ROUTES.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified: now,
    changeFrequency: 'daily' as const,
    priority: route === '/' ? 1 : 0.9,
  }));
}
