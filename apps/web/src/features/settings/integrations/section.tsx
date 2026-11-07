// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../../lib/response.js';
import { useQuery } from '@tanstack/react-query';
import { healthResponseSchema, type BackupsIntegration } from '@plaingym/shared/contracts';
import { api } from '../../../lib/api.js';
import { Button } from '../../../components/ui/button.js';
import { ErrorState, LoadingState } from '../../../components/ui/states.js';
import { useIntegrations, text } from './state.js';
import { EmailIntegrationSection } from './email.js';
import { PaymentsIntegrationSection } from './payments.js';
import { BackupsIntegrationSection, type LastSnapshot } from './backups.js';

/** The last Stripe event and the last restorable snapshot come from the health checks, which read them. */
function useHealthDetails(enabled: boolean, backups: BackupsIntegration | null | undefined) {
  return useQuery({ queryKey: ['settings', 'integrations', 'health', backups?.publicKey, backups?.destination], enabled, staleTime: 60_000, refetchOnWindowFocus: false, retry: false,
    queryFn: async ({ signal }) => {
      const result = await api.GET('/api/health', { signal, cache: 'no-store' });
      if (!result.response.ok) throw new Error('The health request failed');
      const tiles = parseResponse(healthResponseSchema, result.data).data.tiles;
      const stripe = tiles.find((tile) => tile.id === 'stripe_webhooks'), backup = tiles.find((tile) => tile.id === 'last_backup');
      return {
        lastEventAt: stripe?.id === 'stripe_webhooks' && stripe.details ? stripe.details.lastReceivedAt : null,
        lastSnapshot: (backup?.id === 'last_backup' && backup.details && !backup.details.pruningStopped
          ? { at: backup.details.latestRestorableAt, noneUnderCurrentKey: backup.details.noneUnderCurrentKey } : 'unknown') as LastSnapshot,
      };
    } });
}
/**
 * Settings → Email, Payments and Backups (owners only). One registered section holds all three, since the backups part
 * exists only on single-gym installs and the page frames every registered section.
 */
export function IntegrationsSettings() {
  const state = useIntegrations(), integrations = state.integrations;
  const health = useHealthDetails(Boolean(integrations && !integrations.sandbox && (integrations.payments.configured || integrations.backups?.configured)), integrations?.backups);
  if (!state.ready) return state.failed
    ? <ErrorState message={text('error')} onRetry={state.reload} retryLabel={text('reload')}/>
    : <LoadingState label={text('loading')}/>;
  const { email, payments, backups, sandbox, integrationsEditable } = integrations!;
  return <div className="min-w-0 space-y-4">
    <h2 className="text-lg font-semibold">{text('title')}</h2>
    <p className="text-sm text-muted-foreground">{text(sandbox ? 'sandbox' : integrationsEditable ? 'intro' : 'operatorManaged')}</p>
    {!sandbox && <div className="divide-y divide-border">
      <div className="pb-6"><EmailIntegrationSection email={email} editable={integrationsEditable} state={state}/></div>
      <div className="py-6"><PaymentsIntegrationSection payments={payments} editable={integrationsEditable} lastEventAt={health.isError ? undefined : health.data?.lastEventAt} state={state}/></div>
      {backups && <div className="pt-6"><BackupsIntegrationSection backups={backups} lastSnapshot={health.isError ? 'unknown' : health.data?.lastSnapshot} state={state}/></div>}
    </div>}
    <div><Button type="button" variant="outline" onClick={state.reload}>{text('reload')}</Button></div>
  </div>;
}
