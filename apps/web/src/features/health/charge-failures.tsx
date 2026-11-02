// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chargeFailuresResponseSchema, dismissChargeFailuresResponseSchema, healthContracts } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';

const label = (key: string, values?: Record<string, string | number>) => t('health/status:failures.' + key, values);
/**
 * The invoices a stopped charge run couldn't settle, with the staff actions that clear them from the charge-run tile.
 * `reporting` is whether the tile is an error: only then is the list read (and polled), and **Dismiss all** names the
 * runs on screen when its dialog opened, so a report written since stays open.
 */
export function ChargeFailures({ gymId, reporting }: { gymId: string; reporting: boolean }) {
  const cache = useQueryClient(), [confirming, setConfirming] = useState<readonly string[] | null>(null);
  // Under the health query's key, so one invalidation refreshes the tiles and this list together.
  const query = useQuery({ queryKey: ['health', gymId, 'charge-failures'], queryFn: async ({ signal }) => {
    const result = await api.GET(healthContracts.listChargeFailures.path, { signal, cache: 'no-store' });
    if (!result.response.ok) throw new Error('Charge failures failed');
    return chargeFailuresResponseSchema.parse(result.data).data;
  }, refetchInterval: 60_000, enabled: reporting });
  const dismiss = useMutation({
    mutationFn: async (named: string | readonly string[]) => {
      const result = await api.POST(healthContracts.dismissChargeFailures.path, { body: typeof named === 'string' ? { runId: named } : { runIds: [...named] } });
      if (!result.response.ok) throw new Error('Dismiss failed');
      return dismissChargeFailuresResponseSchema.parse(result.data).data;
    },
    // A report that is already gone (dismissed elsewhere) is also settled by reading the list again.
    onSettled: () => cache.invalidateQueries({ queryKey: ['health', gymId] }),
    onSuccess: () => setConfirming(null),
  });
  const reports = query.data ?? [];
  // Close the confirmation and forget a failed attempt, so its error doesn't outlive the dialog it came from.
  const closeConfirm = () => { dismiss.reset(); setConfirming(null); };
  // A quiet tile hides the list, and with it any open dialog or failed attempt: neither comes back with a later report.
  const { reset } = dismiss;
  useEffect(() => { if (!reporting) { reset(); setConfirming(null); } }, [reporting, reset]);
  if (!reporting) return null;
  if (query.isError) return <p role="status" className="mt-4 text-sm">{label('loadFailed')}</p>;
  if (query.isPending) return <p role="status" className="mt-4 text-sm">{label('loading')}</p>;
  if (!reports.length) return null;
  return <section aria-label={label('title')} className="mt-4 space-y-3 border-t border-border pt-4">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <h3 className="font-medium">{label('title')}</h3>
      <Button variant="outline" className="w-full sm:w-auto" disabled={dismiss.isPending} onClick={() => { dismiss.reset(); setConfirming(reports.map((report) => report.runId)); }}>{label('dismissAll')}</Button>
    </div>
    {dismiss.isError && !confirming && <Alert>{label('dismissFailed')}</Alert>}
    <ul className="space-y-3">{reports.map((report) => <li key={report.runId} className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-medium">{label('run', { day: report.day })}</p>
        <Button variant="outline" size="sm" className="w-full sm:w-auto" aria-label={label('dismissReport', { day: report.day })}
          disabled={dismiss.isPending} onClick={() => dismiss.mutate(report.runId)}>{label('dismiss')}</Button>
      </div>
      <ul className="space-y-1 text-sm">{report.failures.map((failure) => <li key={failure.invoiceId} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
        <span>{failure.number === null ? label('invoiceUnnumbered') : label('invoice', { number: failure.number })}</span>
        <span className="text-muted-foreground">{label('cause.' + failure.cause)}</span>
      </li>)}</ul>
    </li>)}</ul>
    {confirming && <Dialog title={label('confirmTitle')} closeLabel={label('close')} onClose={closeConfirm} dismissible={!dismiss.isPending}>
      <div className="space-y-4"><p>{label('confirmHelp')}</p>
        {dismiss.isError && <Alert>{label('dismissFailed')}</Alert>}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button disabled={dismiss.isPending} onClick={() => dismiss.mutate(confirming)}>{label(dismiss.isPending ? 'working' : 'confirm')}</Button>
          <Button variant="outline" disabled={dismiss.isPending} onClick={closeConfirm}>{label('cancel')}</Button></div></div>
    </Dialog>}
  </section>;
}
