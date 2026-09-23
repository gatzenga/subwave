// Pure helper for the active-station pointer — no fs, no config import
// (config.ts depends on stations/resolve.ts, which depends on this file; keep it
// leaf-level). Only the read path is left: the station is resolved once at boot,
// and a single-station install resolves to the state root.

// Station id = directory name under state/stations/. Also the containment
// guard's first line of defence (no dots, no slashes, no uppercase).
export const STATION_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

// stations/active.json is controller-written as {"activeId":"<id>"} but parsed
// defensively — a hand-edited or truncated file must never crash a boot path.
export function parseActivePointer(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    const id = parsed?.activeId;
    if (typeof id === 'string' && STATION_ID_RE.test(id)) return id;
  } catch {}
  return null;
}
