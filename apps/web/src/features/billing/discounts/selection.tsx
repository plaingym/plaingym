// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MembershipDiscountSelection } from '@plaingym/shared/contracts';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { Select } from '../../../components/ui/select.js';
import { discountClient, type DiscountClient } from './api.js';
import { benefit, text } from './messages.js';

export function DiscountSelection({ gymId, planId, currency, value, onChange, client = discountClient, live = false }: {
  gymId: string; planId: string; currency: string; value: MembershipDiscountSelection | undefined;
  onChange(value: MembershipDiscountSelection | undefined): void; client?: DiscountClient | undefined; live?: boolean;
}) {
  const [mode, setMode] = useState('none');
  const rows = useQuery({ queryKey: ['billing', gymId, 'discounts'], queryFn: () => client.list(), enabled: mode === 'named' });
  const eligible = rows.data?.filter(row => row.active && row.currency === currency && (!row.planIds.length || row.planIds.includes(planId)) && (!live || row.duration !== null));
  return <div className="min-w-0 space-y-3 sm:col-span-2">
    <Label className="block min-w-0">{text('choose')}<Select value={mode} onChange={event => { setMode(event.target.value); onChange(undefined); }}>
      <option value="none">{text('none')}</option><option value="named">{text('named')}</option><option value="code">{text('byCode')}</option>
    </Select></Label>
    {mode === 'named' && <>
      {rows.isPending && <p role="status">{text('loading')}</p>}
      {rows.isError && <Alert variant="error" role="alert">{text('loadFailed')} <Button variant="outline" onClick={() => void rows.refetch()}>{text('retry')}</Button></Alert>}
      <Label className="block min-w-0">{text('named')}<Select required value={value && 'discountId' in value ? value.discountId : ''} onChange={event => onChange(event.target.value ? { discountId: event.target.value } : undefined)}>
        <option value="">{text('select')}</option>{eligible?.map(row => <option key={row.id} value={row.id}>{row.name} · {benefit(row)}</option>)}
      </Select></Label>
      {rows.data && !eligible?.length && <p>{text('noEligible')}</p>}
    </>}
    {mode === 'code' && <Label className="block min-w-0">{text('code')}<Input required pattern="[A-Za-z0-9\-]{3,40}" maxLength={40} autoComplete="off" value={value && 'code' in value ? value.code : ''} onChange={event => onChange({ code: event.target.value })}/></Label>}
    {mode !== 'none' && <p className="text-sm text-muted-foreground">{text('eligibilityHelp')}</p>}
  </div>;
}
