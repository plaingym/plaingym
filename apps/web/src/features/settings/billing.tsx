// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useState, type FormEvent } from 'react';
import { billingRulesSchema, gymSettingsResponseSchema, type GymSettings } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';

const text = (key: string) => t('settings/billing:' + key);
export function BillingSettings() {
  const id = useId();
  const [settings, setSettings] = useState<GymSettings | null>(null);
  const [days, setDays] = useState(''), [fieldError, setFieldError] = useState(false);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const [message, setMessage] = useState('');
  const rules = billingRulesSchema.safeParse({ retryDays: days.trim() === '' ? [] : days.split(',').map((day) => day.trim() === '' ? NaN : Number(day)) });
  async function load() {
    setBusy(true); setFailed(false); setMessage('');
    try {
      const result = await api.GET('/api/settings');
      if (!result.response.ok) throw new Error();
      const next = gymSettingsResponseSchema.parse(result.data).data;
      setSettings(next); setDays(next.retryDays.join(', ')); setFieldError(false);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage('');
    if (!settings) return;
    if (!rules.success) { setFieldError(true); return; }
    setBusy(true); setFieldError(false);
    try {
      const result = await api.PATCH('/api/settings/billing', { body: { revision: settings.revision, ...rules.data } });
      if (!result.response.ok) {
        if (result.response.status === 400) setFieldError(true);
        else setMessage(text(result.response.status === 409 ? 'conflict' : 'error'));
        return;
      }
      const next = gymSettingsResponseSchema.parse(result.data).data;
      setSettings(next); setDays(next.retryDays.join(', ')); setMessage(text('saved'));
    } catch { setMessage(text('error')); }
    finally { setBusy(false); }
  }
  if (!settings) return failed
    ? <ErrorState message={text('error')} onRetry={() => void load()} retryLabel={text('reload')}/>
    : <LoadingState label={text('loading')}/>;
  return <div className="min-w-0 space-y-4">
    <h2 className="text-lg font-semibold">{text('title')}</h2>
    {message && <p role={message === text('saved') ? 'status' : 'alert'} className="rounded-md border border-border p-3 text-sm">{message}</p>}
    {failed && <ErrorState message={text('error')} onRetry={() => void load()}/>}
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
          <Button type="button" variant="outline" onClick={() => void load()}>{text('reload')}</Button>
        </div>
      </fieldset>
    </form>
  </div>;
}
