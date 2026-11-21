// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { acknowledgeFailedJobsResponseSchema, healthContracts, type HealthTile } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { parseResponse } from '../../lib/response.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';

const label = (key: string) => t('health/status:' + key);

/** Acknowledge failed jobs on the Background jobs tile: clears the failures the tile counted when it was read. */
export function FailedJobsActions({ gymId, tile }: { gymId: string; tile: HealthTile | undefined }) {
  if (tile?.id !== 'failed_jobs' || !tile.details || tile.details.failed <= 0 || !tile.checkedAt) return null;
  return <AcknowledgeFailedJobs key={gymId} gymId={gymId} checkedAt={tile.checkedAt}/>;
}

function AcknowledgeFailedJobs({ gymId, checkedAt }: { gymId: string; checkedAt: string }) {
  const cache = useQueryClient();
  const [confirmThrough, setConfirmThrough] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: async (through: string) => {
    const result = await api.POST(healthContracts.acknowledgeFailedJobs.path, { body: { through } });
    if (!result.response.ok) throw new Error('Acknowledging failed jobs failed');
    return parseResponse(acknowledgeFailedJobsResponseSchema, result.data).data;
  }, onSuccess: async () => { setConfirmThrough(null); await cache.invalidateQueries({ queryKey: ['health', gymId] }); } });
  const close = () => { mutation.reset(); setConfirmThrough(null); };
  return <div className="mt-4 border-t border-border pt-4">
    <Button variant="outline" className="w-full sm:w-auto" onClick={() => { mutation.reset(); setConfirmThrough(checkedAt); }}>{label('acknowledge')}</Button>
    {confirmThrough && <Dialog title={label('acknowledgeTitle')} closeLabel={label('acknowledgeClose')} onClose={close} dismissible={!mutation.isPending}>
      <div className="space-y-4 break-words">
        <p>{label('acknowledgeHelp')}</p>
        {mutation.isError && <Alert variant="error" focusOnReveal>{label('acknowledgeFailed')}</Alert>}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button disabled={mutation.isPending} onClick={() => mutation.mutate(confirmThrough)}>{label(mutation.isPending ? 'acknowledging' : 'acknowledgeConfirm')}</Button>
          <Button variant="outline" disabled={mutation.isPending} onClick={close}>{label('acknowledgeCancel')}</Button>
        </div>
      </div>
    </Dialog>}
  </div>;
}
