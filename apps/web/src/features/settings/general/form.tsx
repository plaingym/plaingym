// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent } from 'react';
import { gymSettingsResponseSchema, type GymSettings } from '@plaingym/shared/contracts';
import { createApiClient } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
const client = createApiClient();
export function GeneralSettingsForm() {
  const [settings, setSettings] = useState<GymSettings | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      const result = await client.GET('/api/settings');
      if (!result.response.ok) throw new Error();
      setSettings(gymSettingsResponseSchema.parse(result.data).data); setMessage('');
    } catch { setMessage(t('settings/settings:error')); }
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
        revision, bookingWindowDays: Number(value('bookingWindowDays')), cancellationCutoffMinutes: Number(value('cancellationCutoffMinutes')) } });
      else result = await client.PATCH('/api/settings/currency', { body: { revision, currency: value('currency').toUpperCase() } });
      if (!result.response.ok) { setMessage(t(result.response.status === 409 ? 'settings/settings:conflict' : 'settings/settings:error')); return; }
      setSettings(gymSettingsResponseSchema.parse(result.data).data); setMessage(t('settings/settings:saved'));
    } catch { setMessage(t('settings/settings:error')); }
    finally { setBusy(false); }
  }
  const fieldClass = 'block w-full rounded border px-3 py-2';
  if (!settings) return <div><p role="status">{message || t('settings/settings:loading')}</p>{message && <button onClick={() => void load()} disabled={busy}>{t('settings/settings:reload')}</button>}</div>;
  return <div className="space-y-8">
    {message && <p role="status">{message}</p>}
    <button type="button" onClick={() => void load()} disabled={busy}>{t('settings/settings:reload')}</button>
    <form key={'general-' + settings.revision} onSubmit={(event) => void save(event, 'general')} className="space-y-4">
      <h2>{t('settings/settings:general')}</h2>
      <fieldset disabled={busy} className="space-y-4">
        <label className="block">{t('settings/settings:name')}<input name="name" required defaultValue={settings.name} className={fieldClass}/></label>
        <label className="block">{t('settings/settings:timezone')}<input name="timezone" required defaultValue={settings.timezone} className={fieldClass}/></label>
        {(['line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const).map((key) => <label key={key} className="block">{t('settings/settings:' + (key === 'line1' ? 'address' : key === 'line2' ? 'addressLine2' : key))}<input name={key} defaultValue={settings.address[key] ?? ''} className={fieldClass}/></label>)}
        <label className="block">{t('settings/settings:primaryColor')}<input type="color" name="primaryColor" defaultValue={settings.branding.primaryColor ?? '#2563eb'} className={fieldClass}/></label>
        <label className="block">{t('settings/settings:logoKey')}<input name="logoKey" defaultValue={settings.branding.logoKey ?? ''} className={fieldClass}/></label>
        <label className="block"><input type="checkbox" name="websiteEnabled" defaultChecked={settings.websiteEnabled}/> {t('settings/settings:website')}</label>
        <label className="block">{t('settings/settings:existingSite')}<input type="url" name="existingSiteUrl" defaultValue={settings.existingSiteUrl ?? ''} className={fieldClass}/></label>
        <button type="submit" className="rounded border px-4 py-2">{t('settings/settings:save')}</button>
      </fieldset>
    </form>
    <form key={'booking-' + settings.revision} onSubmit={(event) => void save(event, 'booking')} className="space-y-4">
      <h2>{t('settings/settings:booking')}</h2><fieldset disabled={busy} className="space-y-4">
        <label className="block">{t('settings/settings:bookingWindow')}<input type="number" min="0" step="1" required name="bookingWindowDays" defaultValue={settings.bookingWindowDays} className={fieldClass}/></label>
        <label className="block">{t('settings/settings:cancellationCutoff')}<input type="number" min="0" step="1" required name="cancellationCutoffMinutes" defaultValue={settings.cancellationCutoffMinutes} className={fieldClass}/></label>
        <button type="submit" className="rounded border px-4 py-2">{t('settings/settings:save')}</button>
      </fieldset>
    </form>
    <form key={'currency-' + settings.revision} onSubmit={(event) => void save(event, 'currency')} className="space-y-4">
      <label className="block">{t('settings/settings:currency')}<input name="currency" required pattern="[A-Za-z]{3}" maxLength={3} defaultValue={settings.currency} disabled={busy} className={fieldClass}/></label>
      <p>{t('settings/settings:currencyHelp')}</p><button type="submit" disabled={busy} className="rounded border px-4 py-2">{t('settings/settings:save')}</button>
    </form>
  </div>;
}
