// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { effectActionResponseSchema, exhaustedEffectsResponseSchema, healthContracts, type ExhaustedEffect } from '@plaingym/shared/contracts';
import { formatMinorUnits } from '@plaingym/shared/money';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { instantLabel } from '../../lib/instant.js';
import { parseResponse } from '../../lib/response.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';

const label = (key: string, values?: Record<string, string | number>) => t('health/effect-failures:' + key, values);
function elapsed(at: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(at).getTime()) / 60_000));
  if (!minutes) return label('justNow');
  const [value, unit] = minutes >= 1440 ? [Math.floor(minutes / 1440), 'day'] as const
    : minutes >= 60 ? [Math.floor(minutes / 60), 'hour'] as const : [minutes, 'minute'] as const;
  return new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(-value, unit);
}
export function EffectFailures({ gymId, reporting, timezone }: { gymId: string; reporting: boolean; timezone: string }) {
  const cache = useQueryClient();
  const [confirming, setConfirming] = useState<{ action: 'retry' | 'dismiss'; effect: ExhaustedEffect } | null>(null);
  const query = useQuery({ queryKey: ['health', gymId, 'effect-failures'], enabled: reporting, refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const result = await api.GET(healthContracts.listEffectFailures.path, { signal, cache: 'no-store' });
      if (!result.response.ok) throw new Error('Invoice effects failed');
      return parseResponse(exhaustedEffectsResponseSchema, result.data).data;
    } });
  const mutation = useMutation({ mutationFn: async ({ action, effect }: NonNullable<typeof confirming>) => {
    const contract = action === 'retry' ? healthContracts.retryEffect : healthContracts.dismissEffect;
    const result = await api.POST(contract.path, { body: { effectId: effect.effectId } });
    if (!result.response.ok) throw new Error('Invoice effect action failed');
    return parseResponse(effectActionResponseSchema, result.data).data;
  }, onSuccess: () => setConfirming(null), onSettled: () => cache.invalidateQueries({ queryKey: ['health', gymId] }) });
  const { reset } = mutation;
  useEffect(() => { if (!reporting && !mutation.isPending) { reset(); setConfirming(null); } }, [reporting, mutation.isPending, reset]);
  const close = () => { reset(); setConfirming(null); };
  if (!reporting && !mutation.isPending) return null;
  if (query.isError && !confirming) return <p role="status" className="mt-4 text-sm">{label('loadFailed')}</p>;
  if (query.isPending) return <p role="status" data-loading className="mt-4 text-sm">{label('loading')}</p>;
  // The tile and the list refresh separately: a stale error tile shows nothing rather than an empty heading.
  if (!query.data?.length && !confirming) return null;
  const time = (effect: ExhaustedEffect) => label('exhaustedAgo', { age: elapsed(effect.exhaustedAt), at: instantLabel(effect.exhaustedAt, timezone) });
  return <section aria-label={label('title')} className="mt-4 space-y-3 border-t border-border pt-4">
    <h3 className="font-medium">{label('title')}</h3>
    <ul className="space-y-3">{(query.data ?? []).map(effect => <li key={effect.effectId} className="min-w-0 space-y-2 rounded-md border border-border p-3">
      <a className="inline-flex min-h-11 items-center break-all underline" href={'/admin/billing/invoices/' + effect.invoiceId}>
        {effect.number === null ? label('invoiceUnnumbered') : label('invoice', { number: effect.number })}</a>
      <p className="text-sm font-medium">{label('kind.' + effect.kind)}</p>
      {effect.refund && <p className="text-sm">{label('amount', { amount: formatMinorUnits(effect.refund.amountCents, effect.refund.currency) })}</p>}
      <p className="text-sm text-muted-foreground"><time dateTime={effect.exhaustedAt}>{time(effect)}</time></p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button variant="outline" disabled={mutation.isPending} onClick={() => { reset(); setConfirming({ action: 'retry', effect }); }}>{label('retry')}</Button>
        <Button variant="outline" disabled={mutation.isPending} onClick={() => { reset(); setConfirming({ action: 'dismiss', effect }); }}>{label('dismiss')}</Button>
      </div>
    </li>)}</ul>
    {confirming && <Dialog title={label(confirming.action + 'Title')} closeLabel={label('close')} onClose={close} dismissible={!mutation.isPending}>
      <div className="space-y-4 break-words">
        <p className="font-medium">{label('kind.' + confirming.effect.kind)}</p>
        <p>{time(confirming.effect)}</p>
        <p>{confirming.action === 'dismiss' ? label('dismissHelp') : label('consequence.' + confirming.effect.kind,
          { amount: confirming.effect.refund ? formatMinorUnits(confirming.effect.refund.amountCents, confirming.effect.refund.currency) : '' })}</p>
        {confirming.action === 'retry' && <p>{label('recoveryBudget')}</p>}
        {mutation.isError && <Alert variant="error" focusOnReveal>{label('actionFailed')}</Alert>}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button disabled={mutation.isPending} onClick={() => mutation.mutate(confirming)}>{label(mutation.isPending ? 'working' : confirming.action)}</Button>
          <Button variant="outline" disabled={mutation.isPending} onClick={close}>{label('cancel')}</Button>
        </div>
      </div>
    </Dialog>}
  </section>;
}
