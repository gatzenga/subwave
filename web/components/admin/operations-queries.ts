'use client';

import { adminJson, type AdminFetch } from '@/lib/admin-query';
import { useAdminQuery } from '@/lib/admin-query';

export interface StationRow {
  id: string | null;
  name: string;
  configured: boolean;
  createdAt: string | null;
  active: boolean;
}

export interface StationsResponse {
  multiStation: boolean;
  activeId: string | null;
  limit?: number;
  stations: StationRow[];
}

export interface ArchiveEntry {
  path: string;
  date: string;
  hour: number;
  bytes: number;
  mtime: string;
}

export interface RestorableFile {
  name: string;
  size: number;
  mtime: string;
  /** Written by the backup schedule (#1570) rather than copied in by hand.
   *  Resolved server-side from the same name grammar retention prunes by, so
   *  the badge and the sweep cannot disagree about which files are the
   *  station's own. Absent on an older controller → reads as false. */
  auto?: boolean;
}

export interface RestorableBackups {
  files: RestorableFile[];
  stateDir: string | null;
}

export const operationKeys = {
  stations: () => ['operations', 'stations'] as const,
  archives: () => ['operations', 'archives'] as const,
  restorableBackups: () => ['operations', 'restorable-backups'] as const,
};

export function useStationsQuery(adminFetch: AdminFetch, enabled = true) {
  return useAdminQuery<StationsResponse>({
    key: operationKeys.stations(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const response = await adminJson<StationsResponse>(fetcher, '/stations', undefined, signal);
      return { ...response, stations: Array.isArray(response.stations) ? response.stations : [] };
    },
    toastOnError: false,
  });
}

/**
 * Authorization headers must exist only long enough to build the request.
 * TanStack receives void variables/data; the short-lived refs are cleared in
 * finally, and only the redacted response is allowed into the shared cache.
 */
export function useArchivesQuery(adminFetch: AdminFetch, enabled = true) {
  return useAdminQuery<ArchiveEntry[]>({
    key: operationKeys.archives(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const response = await adminJson<{ archives?: ArchiveEntry[] }>(
        fetcher, '/archives', undefined, signal,
      );
      return Array.isArray(response.archives) ? response.archives : [];
    },
    toastOnError: false,
  });
}

export function useRestorableBackupsQuery(adminFetch: AdminFetch, enabled = true) {
  return useAdminQuery<RestorableBackups>({
    key: operationKeys.restorableBackups(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const response = await adminJson<{ files?: RestorableFile[]; stateDir?: string }>(
        fetcher, '/backup/restorable', undefined, signal,
      );
      return {
        files: Array.isArray(response.files) ? response.files : [],
        stateDir: response.stateDir || null,
      };
    },
    toastOnError: false,
  });
}
