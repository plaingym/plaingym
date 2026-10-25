// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { gymSettingsResponseSchema, type GymSettings } from '@plaingym/shared/contracts';
import { createApiClient } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { CheckboxField } from '../../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../../components/ui/states.js';
const client = createApiClient();
const text = (key: string) => t('settings/settings:' + key);
function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <Label className={'grid min-w-0 gap-2 ' + (className ?? '')}>{label}{children}</Label>;
}
export function GeneralSettingsForm() {
  const [settings, setSettings] = useState<GymSettings | null>(null);
  const [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true); setFailed(false);
    try {
      const result = await client.GET('/api/settings');
      if (!result.response.ok) throw new Error();
      setSettings(gymSettingsResponseSchema.parse(result.data).data); setMessage('');
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function save(event: FormEvent<HTMLFormElement>, kind: 'general' | 'booking' | 'currency') {
    event.preventDefault();
    if (!settings) return;
    const form = new FormData(event.currentTarget), revision = settings.revision;
    const value = (key: string) => String(form.get(key) ?? '').trim();
    setBusy(true); setMessage('');
    try {
      let result;
      if (kind === 'general') {
        const body = { revision, name: value('name'), timezone: value('timezone'),
          address: { line1: value('line1'), line2: value('line2'), city: value('city'), region: value('region'), postalCode: value('postalCode'),
            ...(value('country') ? { country: value('country').toUpperCase() } : {}) },
          branding: { primaryColor: value('primaryColor'), logoKey: value('logoKey') || null },
          websiteEnabled: form.has('websiteEnabled'), existingSiteUrl: value('existingSiteUrl') || null };
        result = await client.PATCH('/api/settings', { body });
      } else if (kind === 'booking') result = await client.PATCH('/api/settings/booking', { body: {
        revision, bookingWindowDays: Number(value('bookingWindowDays')), cancellationCutoffMinutes: Number(value('cancellationCutoffMinutes')),
        openMatCountsAsClass: form.has('openMatCountsAsClass') } });
      else result = await client.PATCH('/api/settings/currency', { body: { revision, currency: value('currency').toUpperCase() } });
      if (!result.response.ok) { setMessage(text(result.response.status === 409 ? 'conflict' : 'error')); return; }
      setSettings(gymSettingsResponseSchema.parse(result.data).data); setMessage(text('saved'));
    } catch { setMessage(text('error')); }
    finally { setBusy(false); }
  }
  if (!settings) return failed ? <ErrorState message={text('error')} onRetry={() => void load()} retryLabel={text('reload')}/> : <LoadingState label={text('loading')}/>;
  return <div className="space-y-8">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h2 className="text-lg font-semibold">{text('general')}</h2>
      <Button variant="outline" onClick={() => void load()} disabled={busy}>{text('reload')}</Button>
    </div>
    {message && <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">{message}</p>}
    {failed && <ErrorState message={text('error')} onRetry={() => void load()}/>}
    <form key={'general-' + settings.revision} onSubmit={(event) => void save(event, 'general')} aria-label={text('general')}>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <Field label={text('name')} className="sm:col-span-2"><Input name="name" required defaultValue={settings.name}/></Field>
        <Field label={text('timezone')} className="sm:col-span-2"><Input name="timezone" required defaultValue={settings.timezone}/></Field>
        {(['line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const).map((key) =>
          <Field key={key} label={text(key === 'line1' ? 'address' : key === 'line2' ? 'addressLine2' : key)} className={key === 'line1' || key === 'line2' ? 'sm:col-span-2' : ''}>
            <Input name={key} defaultValue={settings.address[key] ?? ''} {...(key === 'country' ? { maxLength: 2, autoCapitalize: 'characters' } : {})}/></Field>)}
        <Field label={text('primaryColor')}><Input type="color" name="primaryColor" defaultValue={settings.branding.primaryColor ?? '#2563eb'} className="w-24 p-1"/></Field>
        <Field label={text('logoKey')}><Input name="logoKey" defaultValue={settings.branding.logoKey ?? ''}/></Field>
        <CheckboxField className="sm:col-span-2" name="websiteEnabled" defaultChecked={settings.websiteEnabled} label={text('website')}/>
        <Field label={text('existingSite')} className="sm:col-span-2"><Input type="url" name="existingSiteUrl" defaultValue={settings.existingSiteUrl ?? ''}/></Field>
        <div className="sm:col-span-2"><Button type="submit" className="w-full sm:w-auto">{text('save')}</Button></div>
      </fieldset>
    </form>
    <form key={'booking-' + settings.revision} onSubmit={(event) => void save(event, 'booking')} className="space-y-4 border-t border-border pt-6" aria-label={text('booking')}>
      <h3 className="text-base font-semibold">{text('booking')}</h3>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <Field label={text('bookingWindow')}><Input type="number" min="0" step="1" required name="bookingWindowDays" defaultValue={settings.bookingWindowDays}/></Field>
        <Field label={text('cancellationCutoff')}><Input type="number" min="0" step="1" required name="cancellationCutoffMinutes" defaultValue={settings.cancellationCutoffMinutes}/></Field>
        <div className="sm:col-span-2"><CheckboxField name="openMatCountsAsClass" defaultChecked={settings.openMatCountsAsClass} label={text('openMatCountsAsClass')}/>
          <p className="text-sm text-muted-foreground">{text('openMatHelp')}</p></div>
        <div className="sm:col-span-2"><Button type="submit" className="w-full sm:w-auto">{text('save')}</Button></div>
      </fieldset>
    </form>
    <form key={'currency-' + settings.revision} onSubmit={(event) => void save(event, 'currency')} className="space-y-4 border-t border-border pt-6" aria-label={text('currency')}>
      <fieldset disabled={busy} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label={text('currency')} className="sm:w-48"><Input name="currency" required pattern="[A-Za-z]{3}" maxLength={3} defaultValue={settings.currency}/></Field>
        <Button type="submit">{text('save')}</Button>
      </fieldset>
      <p className="text-sm text-muted-foreground">{text('currencyHelp')}</p>
    </form>
  </div>;
}
