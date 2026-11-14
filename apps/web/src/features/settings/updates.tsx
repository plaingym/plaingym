// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../lib/response.js';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { autoUpdateContracts, autoUpdateSettingsResponseSchema, type AutoUpdateSettings } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { CheckboxField } from '../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';
import { clientVersion } from '../../app/version.js';

const text = (key: string) => t('health/auto-update:' + key);
export const autoUpdateKey = ['settings', 'auto-update'] as const;
type Notice = 'saving' | 'saved' | 'failed' | 'changed' | null;

/**
 * Settings → Updates (owners). One switch: whether the server installs patch releases on its own each night. The
 * server's timer reads it through the app; each night's result shows on the Health page's automatic updates tile.
 */
export function AutoUpdateSettings() {
  const cache = useQueryClient();
  const [notice, setNotice] = useState<Notice>(null);
  const query = useQuery({ queryKey: autoUpdateKey, retry: false, queryFn: async ({ signal }) => {
    const result = await api.GET(autoUpdateContracts.get.path, { signal, cache: 'no-store' });
    if (!result.response.ok) throw new Error('The update setting request failed');
    return parseResponse(autoUpdateSettingsResponseSchema, result.data).data;
  } });
  async function save(current: AutoUpdateSettings, enabled: boolean) {
    setNotice('saving');
    try {
      const result = await api.PUT(autoUpdateContracts.update.path, { body: { enabled, revision: current.revision } });
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
            onChange={(event) => void save(query.data, event.target.checked)}/>
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {notice === 'saving' ? text('section.saving') : notice === 'saved' ? text('section.saved') : notice === 'changed' ? text('section.changed') : ''}
          </p>
          {notice === 'failed' && <Alert variant="error" focusOnReveal>{text('section.saveFailed')}</Alert>}
        </>}
  </div>;
}
