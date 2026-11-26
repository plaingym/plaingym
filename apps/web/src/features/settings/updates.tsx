// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../lib/response.js';
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { autoUpdateContracts, autoUpdateSettingsResponseSchema, type AutoUpdateSettings } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Label } from '../../components/ui/label.js';
import { CheckboxField, Select } from '../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';
import { clientVersion } from '../../app/version.js';

const text = (key: string, values?: Record<string, string>) => t('health/auto-update:' + key, values);
export const autoUpdateKey = ['settings', 'auto-update'] as const;
type Notice = 'saving' | 'saved' | 'failed' | 'changed' | null;

/** The start hours the owner can pick: the three-hour window from each ends by midnight. */
const windowStarts = Array.from({ length: 22 }, (_, hour) => hour);
const clockHour = (hour: number) => String(hour % 24).padStart(2, '0') + ':00';

/**
 * Settings → Updates (owners). A switch, whether the server installs patch releases on its own each night, and the
 * nightly three-hour window it does so in (gym time). The server's timer reads both through the app; each night's
 * result shows on the Health page's automatic updates tile.
 */
export function AutoUpdateSettings() {
  const windowId = useId();
  const cache = useQueryClient();
  const [notice, setNotice] = useState<Notice>(null);
  const query = useQuery({ queryKey: autoUpdateKey, retry: false, queryFn: async ({ signal }) => {
    const result = await api.GET(autoUpdateContracts.get.path, { signal, cache: 'no-store' });
    if (!result.response.ok) throw new Error('The update setting request failed');
    return parseResponse(autoUpdateSettingsResponseSchema, result.data).data;
  } });
  async function save(current: AutoUpdateSettings, change: { enabled?: boolean; windowStart?: number }) {
    setNotice('saving');
    try {
      // The revision guards both: a save made from a stale page is refused whichever control changed.
      const body = { enabled: change.enabled ?? current.enabled, ...change.windowStart === undefined ? {} : { windowStart: change.windowStart },
        revision: current.revision };
      const result = await api.PUT(autoUpdateContracts.update.path, { body });
      if (result.response.status === 409) {
        // Another owner saved first: show their choice rather than overwriting it.
        setNotice('changed');
        await cache.invalidateQueries({ queryKey: autoUpdateKey });
        return;
      }
      if (!result.response.ok) throw new Error('The update setting save failed');
      cache.setQueryData(autoUpdateKey, parseResponse(autoUpdateSettingsResponseSchema, result.data).data);
      setNotice('saved');
    } catch { setNotice('failed'); }
  }
  return <div className="min-w-0 space-y-4">
    <h2 className="text-lg font-semibold">{text('title')}</h2>
    <p className="text-sm text-muted-foreground">{text('section.description')}</p>
    {clientVersion && <p className="break-all text-sm">{t('health/status:versionRunning', { version: `${clientVersion.version} (${clientVersion.commit.slice(0, 7)})` })}</p>}
    {query.isPending ? <LoadingState label={text('section.loading')}/>
      : query.isError ? <ErrorState message={text('section.loadFailed')} onRetry={() => void query.refetch()}/>
        : <>
          {!query.data.available && <Alert>{text('section.unavailable')}</Alert>}
          <CheckboxField label={text('section.label')} checked={query.data.enabled}
            disabled={notice === 'saving' || query.isFetching || !query.data.available}
            onChange={(event) => void save(query.data, { enabled: event.target.checked })}/>
          <div className="grid min-w-0 gap-2 sm:max-w-xs">
            <Label htmlFor={windowId}>{text('section.window')}</Label>
            <Select id={windowId} value={String(query.data.windowStart)} aria-describedby={windowId + '-help'}
              disabled={notice === 'saving' || query.isFetching || !query.data.available}
              onChange={(event) => void save(query.data, { windowStart: Number(event.target.value) })}>
              {windowStarts.map(hour => <option key={hour} value={String(hour)}>
                {text('section.windowOption', { start: clockHour(hour), end: clockHour(hour + 3) })}</option>)}
            </Select>
            <p id={windowId + '-help'} className="text-sm text-muted-foreground">{text('section.windowHelp')}</p>
          </div>
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {notice === 'saving' ? text('section.saving') : notice === 'saved' ? text('section.saved') : notice === 'changed' ? text('section.changed') : ''}
          </p>
          {notice === 'failed' && <Alert variant="error" focusOnReveal>{text('section.saveFailed')}</Alert>}
        </>}
  </div>;
}
