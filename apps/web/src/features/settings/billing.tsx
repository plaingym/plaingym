// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useState, type FormEvent } from 'react';
import { billingRulesSchema, gymSettingsResponseSchema } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';
import { useGymSettings } from './gym-settings.js';

const text = (key: string) => t('settings/billing:' + key);
export function BillingSettings() {
  const id = useId(), gym = useGymSettings(), settings = gym.settings;
  const [days, setDays] = useState(''), [fieldError, setFieldError] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const rules = billingRulesSchema.safeParse({ retryDays: days.trim() === '' ? [] : days.split(',').map((day) => day.trim() === '' ? NaN : Number(day)) });
  // Show the saved schedule whenever the settings come from the server; a save in another section keeps this input.
  useEffect(() => { if (settings) { setDays(settings.retryDays.join(', ')); setFieldError(false); } }, [gym.epoch]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    if (!settings) return;
    if (!rules.success) { setFieldError(true); return; }
    setBusy(true); setFieldError(false);
    try {
      const result = await gym.save((revision) => api.PATCH('/api/settings/billing', { body: { revision, ...rules.data } }));
      if (result.status === 400) setFieldError(true);
      else if (result.status >= 300) setMessage(text(result.status === 409 ? 'conflict' : 'error'));
      else { setDays(gymSettingsResponseSchema.parse(result.data).data.retryDays.join(', ')); setMessage(text('saved')); }
    } catch { setMessage(text('error')); }
    finally { setBusy(false); }
  }
  if (!settings) return gym.failed
    ? <ErrorState message={text('error')} onRetry={gym.reload} retryLabel={text('reload')}/>
    : <LoadingState label={text('loading')}/>;
  return <div className="min-w-0 space-y-4">
    <h2 className="text-lg font-semibold">{text('title')}</h2>
    {message && <p role={message === text('saved') ? 'status' : 'alert'} className="rounded-md border border-border p-3 text-sm">{message}</p>}
    {gym.failed && <ErrorState message={text('error')} onRetry={gym.reload}/>}
    <form onSubmit={(event) => void save(event)} aria-label={text('title')}>
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        <div className="grid min-w-0 gap-2">
          <Label htmlFor={id}>{text('retryDays')}</Label>
          <Input id={id} name="retryDays" value={days} onChange={(event) => { setDays(event.target.value); setFieldError(false); }}
            aria-invalid={fieldError} aria-describedby={id + '-help' + (fieldError ? ' ' + id + '-error' : '')}/>
          <p id={id + '-help'} className="text-sm text-muted-foreground">{text('formatHelp')}</p>
          {fieldError && <p id={id + '-error'} role="alert" className="text-sm text-destructive">{text('invalidRetryDays')}</p>}
        </div>
        <p className="text-sm text-muted-foreground">{text('scheduleHelp')}</p>
        <p className="text-sm text-muted-foreground">{text('emailsHelp')}</p>
        {rules.success && <p className="text-sm text-muted-foreground">{t('settings/billing:emailCount', { count: rules.data.retryDays.length + 1 })}</p>}
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button type="submit">{text('save')}</Button>
          <Button type="button" variant="outline" onClick={() => { setMessage(''); gym.reload(); }}>{text('reload')}</Button>
        </div>
      </fieldset>
    </form>
  </div>;
}
