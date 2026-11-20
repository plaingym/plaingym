// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { calendarDateLabel, useGymTime } from '../../../lib/instant.js';
import { t } from '../../../lib/i18n.js';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import type { BillingClient } from '../catalog/api.js';

const text = (key: string, values?: Record<string, string | number>) => t('billing/memberships:' + key, values);
export function FreezeHistory({ gymId, membershipId, revision, client }: {
  gymId: string; membershipId: string; revision: number; client: BillingClient;
}) {
  const [open, setOpen] = useState(false), [page, setPage] = useState({ revision, offset: 0 });
  const offset = page.revision === revision ? page.offset : 0;
  const setOffset = (offset: number) => setPage({ revision, offset });
  const { instantLabel } = useGymTime();
  const history = useQuery({ queryKey: ['billing', gymId, 'memberships', membershipId, 'freeze-history', revision, offset],
    queryFn: () => client.freezeHistory(membershipId, offset), enabled: open, placeholderData: keepPreviousData });
  const displayedOffset = history.data?.pagination.offset ?? offset;
  return <div className="min-w-0 space-y-2">
    <Button variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>{text('freezeHistory')}</Button>
    {open && <section aria-label={text('freezeHistory')} className="space-y-3">
      {history.isPending && <p role="status">{text('loading')}</p>}
      {history.isError && <Alert variant="error" role="alert">{text('error')} <Button variant="outline" onClick={() => void history.refetch()}>{text('retry')}</Button></Alert>}
      {history.data && <>
        {!history.data.data.length && <p>{text(history.data.pagination.total === 0 ? 'noFreezes' : 'someFreezesHidden')}</p>}
        <ol className="space-y-3">{history.data.data.map(event => <li key={event.id} className="space-y-1 rounded-md bg-muted p-3 text-sm">
          <p>{text('frozenOn', { date: instantLabel(event.occurredAt) })}</p>
          <p>{text('freezeSkipped', { date: calendarDateLabel(event.skippedDueOn) })}</p>
          <p>{text('freezeNextDue', { date: calendarDateLabel(event.nextDueOn) })}</p>
        </li>)}</ol>
        <div className="flex flex-col gap-2 sm:flex-row">
          {displayedOffset > 0 && <Button variant="outline" disabled={history.isPlaceholderData} onClick={() => setOffset(Math.max(0, displayedOffset - history.data.pagination.limit))}>{text('newerFreezes')}</Button>}
          {displayedOffset + history.data.pagination.limit < history.data.pagination.total && <Button variant="outline" disabled={history.isPlaceholderData} onClick={() => setOffset(displayedOffset + history.data.pagination.limit)}>{text('olderFreezes')}</Button>}
        </div>
      </>}
    </section>}
  </div>;
}
