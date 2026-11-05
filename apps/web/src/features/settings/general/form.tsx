// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { bootstrapKey } from '../../../app/context.js';
import { api } from '../../../lib/api.js';
import { SaveTimeoutError, useGymSettings } from '../gym-settings.js';
import { t } from '../../../lib/i18n.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { CheckboxField } from '../../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../../components/ui/states.js';
const text = (key: string) => t('settings/settings:' + key);
/** The general form's inputs, by the name the server's `details` end with (`address.country` is `country`). */
const generalFields = ['name', 'timezone', 'line1', 'line2', 'city', 'region', 'postalCode', 'country', 'primaryColor', 'logoKey',
  'websiteEnabled', 'existingSiteUrl'] as const;
type GeneralField = typeof generalFields[number];
const fieldMessages: Partial<Record<GeneralField, string>> = { name: 'nameInvalid', timezone: 'timezoneInvalid', country: 'countryInvalid',
  primaryColor: 'primaryColorInvalid', existingSiteUrl: 'existingSiteInvalid' };
/**
 * The fields a refusal names. The server names each with a code (`details`), never with its message; `other` is set
 * when it also names something the form has no input for.
 */
function refusedFields(body: unknown): { fields: Partial<Record<GeneralField, true>>; other: boolean } {
  const details = (body as { error?: { details?: Record<string, unknown> } } | undefined)?.error?.details ?? {};
  const fields: Partial<Record<GeneralField, true>> = {};
  let other = false;
  for (const key of Object.keys(details)) {
    const name = key.split('.').pop() as GeneralField;
    if (generalFields.includes(name)) fields[name] = true; else other = true;
  }
  return { fields, other };
}
/** A labelled input with its help and, once the server refused it, its error; without a label the child labels itself. */
function Field({ label, className, help, error, errorId, children }: {
  label?: string; className?: string; help?: ReactNode; error?: string | false; errorId?: string; children: ReactNode;
}) {
  return <div className={'grid min-w-0 gap-2 ' + (className ?? '')}>
    {label === undefined ? children : <Label className="grid min-w-0 gap-2">{label}{children}</Label>}
    {help}
    {error && <p id={errorId} role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
export function GeneralSettingsForm() {
  const cache = useQueryClient(), gym = useGymSettings(), settings = gym.settings;
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false), fieldId = useId();
  // Each form starts over when the settings come from the server (epoch) or after its own save, never after another
  // section's save, so unsaved input in one form survives a save in another.
  const [saves, setSaves] = useState({ general: 0, booking: 0, currency: 0 });
  const generalKey = 'general-' + gym.epoch + '-' + saves.general;
  // Refused fields belong to the general form they were typed in: a reload starts a new form, without them.
  const [refused, setRefused] = useState<{ form: string; fields: Partial<Record<GeneralField, true>> } | null>(null);
  const fieldError = (name: GeneralField) => refused?.form === generalKey && !!refused.fields[name];
  const clearField = (name: GeneralField) => setRefused((current) => current?.fields[name] ? { ...current, fields: { ...current.fields, [name]: undefined } } : current);
  /** Marks a refused input and points it at its error (and at `help`, when it has one). */
  const invalid = (name: GeneralField, help?: string) => ({ 'aria-invalid': fieldError(name), onChange: () => clearField(name),
    'aria-describedby': [help, fieldError(name) ? fieldId + '-' + name + '-error' : undefined].filter(Boolean).join(' ') || undefined });
  const errorOf = (name: GeneralField) => ({ error: fieldError(name) && text(fieldMessages[name] ?? 'fieldInvalid'), errorId: fieldId + '-' + name + '-error' });
  async function save(event: FormEvent<HTMLFormElement>, kind: 'general' | 'booking' | 'currency') {
    event.preventDefault();
    if (!settings) return;
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const formKey = generalKey;
    setBusy(true); setMessage('');
    if (kind === 'general') setRefused(null);
    try {
      const send = (revision: number, signal: AbortSignal) => {
        // A new zone must follow the shared rule, so it is sent only when it changed: a stored zone the rule would
        // refuse (such as `CET`) saves with every other field unchanged and is never rewritten.
        if (kind === 'general') return api.PATCH('/api/settings', { signal, body: { revision, name: value('name'),
          ...(value('timezone') !== settings.timezone ? { timezone: value('timezone') } : {}),
          address: { line1: value('line1'), line2: value('line2'), city: value('city'), region: value('region'), postalCode: value('postalCode'),
            ...(value('country') ? { country: value('country').toUpperCase() } : {}) },
          branding: { primaryColor: value('primaryColor'), logoKey: value('logoKey') || null },
          websiteEnabled: form.has('websiteEnabled'), existingSiteUrl: value('existingSiteUrl') || null } });
        if (kind === 'booking') return api.PATCH('/api/settings/booking', { signal, body: {
          revision, bookingWindowDays: Number(value('bookingWindowDays')), cancellationCutoffMinutes: Number(value('cancellationCutoffMinutes')),
          openMatCountsAsClass: form.has('openMatCountsAsClass') } });
        return api.PATCH('/api/settings/currency', { signal, body: { revision, currency: value('currency').toUpperCase() } });
      };
      const result = await gym.save(send);
      if (result.status === 400 && kind === 'general') {
        // Every field the server refused is shown at its input; anything else it names gets the page's message too.
        const { fields, other } = refusedFields(result.error);
        if (Object.keys(fields).length) setRefused({ form: formKey, fields });
        if (other || !Object.keys(fields).length) setMessage(text('error'));
        return;
      }
      if (result.status >= 300) { setMessage(text(result.status === 409 ? (result.moved ? 'conflict' : 'conflictKept') : 'error')); return; }
      setSaves((current) => ({ ...current, [kind]: current[kind] + 1 })); setMessage(text('saved'));
      // Screens read the gym's currency and timezone from the cached shell summary; refetch it now, not after its stale time.
      void cache.invalidateQueries({ queryKey: bootstrapKey });
    } catch (error) { setMessage(text(error instanceof SaveTimeoutError ? 'timeout' : 'error')); }
    finally { setBusy(false); }
  }
  if (!settings) return gym.failed ? <ErrorState message={text('error')} onRetry={gym.reload} retryLabel={text('reload')}/> : <LoadingState label={text('loading')}/>;
  return <div className="space-y-8">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h2 className="text-lg font-semibold">{text('general')}</h2>
      <Button variant="outline" onClick={() => { setMessage(''); gym.reload(); }} disabled={busy}>{text('reload')}</Button>
    </div>
    {message && <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">{message}</p>}
    {gym.failed && <ErrorState message={text('error')} onRetry={gym.reload}/>}
    <form key={generalKey} onSubmit={(event) => void save(event, 'general')} aria-label={text('general')}>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <Field label={text('name')} className="sm:col-span-2" {...errorOf('name')}><Input name="name" required defaultValue={settings.name} {...invalid('name')}/></Field>
        <Field label={text('timezone')} className="sm:col-span-2" {...errorOf('timezone')}
          help={<p id={fieldId + '-timezone-help'} className="text-sm text-muted-foreground">{text('timezoneHelp')}</p>}>
          <Input name="timezone" required defaultValue={settings.timezone} {...invalid('timezone', fieldId + '-timezone-help')}/></Field>
        {(['line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const).map((key) =>
          <Field key={key} label={text(key === 'line1' ? 'address' : key === 'line2' ? 'addressLine2' : key)} className={key === 'line1' || key === 'line2' ? 'sm:col-span-2' : ''} {...errorOf(key)}>
            <Input name={key} defaultValue={settings.address[key] ?? ''} {...(key === 'country' ? { maxLength: 2, autoCapitalize: 'characters' } : {})} {...invalid(key)}/></Field>)}
        <Field label={text('primaryColor')} {...errorOf('primaryColor')}><Input type="color" name="primaryColor" defaultValue={settings.branding.primaryColor ?? '#2563eb'} className="w-24 p-1" {...invalid('primaryColor')}/></Field>
        <Field label={text('logoKey')} {...errorOf('logoKey')}><Input name="logoKey" defaultValue={settings.branding.logoKey ?? ''} {...invalid('logoKey')}/></Field>
        <Field className="sm:col-span-2" {...errorOf('websiteEnabled')}>
          <CheckboxField name="websiteEnabled" defaultChecked={settings.websiteEnabled} label={text('website')} {...invalid('websiteEnabled')}/></Field>
        <Field label={text('existingSite')} className="sm:col-span-2" {...errorOf('existingSiteUrl')}><Input type="url" name="existingSiteUrl" defaultValue={settings.existingSiteUrl ?? ''} {...invalid('existingSiteUrl')}/></Field>
        <div className="sm:col-span-2"><Button type="submit" className="w-full sm:w-auto">{text('save')}</Button></div>
      </fieldset>
    </form>
    <form key={'booking-' + gym.epoch + '-' + saves.booking} onSubmit={(event) => void save(event, 'booking')} className="space-y-4 border-t border-border pt-6" aria-label={text('booking')}>
      <h3 className="text-base font-semibold">{text('booking')}</h3>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <Field label={text('bookingWindow')}><Input type="number" min="0" step="1" required name="bookingWindowDays" defaultValue={settings.bookingWindowDays}/></Field>
        <Field label={text('cancellationCutoff')}><Input type="number" min="0" step="1" required name="cancellationCutoffMinutes" defaultValue={settings.cancellationCutoffMinutes}/></Field>
        <div className="sm:col-span-2"><CheckboxField name="openMatCountsAsClass" defaultChecked={settings.openMatCountsAsClass} label={text('openMatCountsAsClass')}/>
          <p className="text-sm text-muted-foreground">{text('openMatHelp')}</p></div>
        <div className="sm:col-span-2"><Button type="submit" className="w-full sm:w-auto">{text('save')}</Button></div>
      </fieldset>
    </form>
    <form key={'currency-' + gym.epoch + '-' + saves.currency} onSubmit={(event) => void save(event, 'currency')} className="space-y-4 border-t border-border pt-6" aria-label={text('currency')}>
      <fieldset disabled={busy} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label={text('currency')} className="sm:w-48"><Input name="currency" required pattern="[A-Za-z]{3}" maxLength={3} defaultValue={settings.currency}/></Field>
        <Button type="submit">{text('save')}</Button>
      </fieldset>
      <p className="text-sm text-muted-foreground">{text('currencyHelp')}</p>
    </form>
  </div>;
}
