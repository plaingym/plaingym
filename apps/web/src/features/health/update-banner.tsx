// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../lib/response.js';
import { useQuery } from '@tanstack/react-query';
import { healthContracts, updateAvailableResponseSchema } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';

const label = (key: string, values?: Record<string, string | number>) => t('health/updates:banner.' + key, values);
/**
 * The heading says what the banner is about. A release the check couldn't read has no changelog link (an invalid
 * `RELEASE_REPOSITORY`); a newer patch that shows at all is one that didn't install by itself; anything else is a newer
 * minor or major release.
 */
export function bannerTitle(details: { currentVersion: string; latestVersion: string; releaseUrl: string | null }) {
  if (details.releaseUrl === null) return label('titleBlocked');
  const series = (version: string) => version.split('.').slice(0, 2).join('.');
  return label(series(details.currentVersion) === series(details.latestVersion) ? 'titlePatchHeld' : 'title');
}
/**
 * "Update available — changelog" for staff who manage settings, when the latest release is a newer minor or major, or a
 * patch that won't install by itself. The server's message says which and what to do about it.
 * The server reads the release list at most once a day; any failure here (offline, a refused request) shows nothing.
 */
export function UpdateBanner({ gymId }: { gymId: string }) {
  // Under the health query's key, so the health page's Refresh also rereads it.
  const query = useQuery({ queryKey: ['health', gymId, 'update'], queryFn: async ({ signal }) => {
    const result = await api.GET(healthContracts.getUpdate.path, { signal, cache: 'no-store' });
    if (!result.response.ok) throw new Error('Update check failed');
    return parseResponse(updateAvailableResponseSchema, result.data).data;
  }, staleTime: 60 * 60_000, retry: false,
    // While the server's first read of the release list is running it answers `unavailable` with no check time, so ask again
    // soon. An `unavailable` with a time is a failed read: the server retries hourly by itself, so the usual pace is enough.
    refetchInterval: (current) => current.state.data?.status === 'unavailable' && current.state.data.checkedAt === null ? 60_000 : 6 * 60 * 60_000 });
  const details = query.data?.details;
  if (!query.data || !details?.available) return null;
  return <div role="status" data-testid="update-banner"
    className="flex flex-col gap-2 border-b border-border bg-muted px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-4 sm:px-6">
    <p className="min-w-0 flex-1">
      <span className="font-semibold">{bannerTitle(details)}</span>
      <span aria-hidden="true"> — </span>
      {query.data.message}
    </p>
    {details.releaseUrl && <a href={details.releaseUrl} target="_blank" rel="noreferrer"
      className="inline-flex min-h-11 items-center font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{label('changelog')}</a>}
  </div>;
}
