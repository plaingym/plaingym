// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { goLiveChecklistResponseSchema, type GoLiveSwitches } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Alert } from '../../components/ui/alert.js';

type Checklist = ReturnType<typeof goLiveChecklistResponseSchema.parse>['data'];
const label = (key: string, values?: Record<string, string>) => t('settings/go-live:' + key, values);
const statusStyle = { ready: 'text-green-700', needs_attention: 'text-amber-700', not_applicable: 'text-muted-foreground' } as const;

/** Shows the billing and member-email switches with the readiness checklist from the go-live contract. */
export function GoLiveSettings() {
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<'error' | 'changed' | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setBusy(true);
    void api.GET('/api/settings/go-live').then((result) => {
      if (!result.response.ok) throw new Error();
      const next = goLiveChecklistResponseSchema.parse(result.data).data;
      if (active) setChecklist(next);
    }).catch(() => { if (active) setMessage('error'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [reload]);
  async function toggle(name: keyof GoLiveSwitches) {
    if (!checklist || busy) return;
    setBusy(true); setMessage(null);
    try {
      const result = await api.PATCH('/api/settings/go-live', { body: { revision: checklist.revision, [name]: !checklist[name] } });
      if (result.response.status === 409) { setMessage('changed'); setReload((value) => value + 1); return; }
      if (!result.response.ok) throw new Error();
      setChecklist(goLiveChecklistResponseSchema.parse(result.data).data);
    } catch { setMessage('error'); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4" aria-label={label('title')}>
    <h2 className="text-lg font-semibold">{label('title')}</h2>
    <p>{label('help')}</p>
    {message && <Alert>{label(message)}{message === 'error' && !checklist &&
      <Button variant="outline" className="ml-3" onClick={() => { setMessage(null); setReload((value) => value + 1); }}>{label('retry')}</Button>}</Alert>}
    {!checklist ? busy && <p role="status">{label('loading')}</p> : <>
      <ul className="space-y-3">{(['billingEnabled', 'memberEmailsEnabled'] as const).map((name) => {
        const on = checklist[name], action = label(on ? 'turnOff' : 'turnOn');
        return <li key={name} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
          <div><p className="font-medium">{label(name)}: <span>{label(on ? 'on' : 'off')}</span></p>
            <p className="text-sm text-muted-foreground">{label(name === 'billingEnabled' ? 'billingHelp' : 'memberEmailsHelp')}</p></div>
          <Button variant={on ? 'outline' : 'default'} disabled={busy} aria-pressed={on}
            aria-label={label('toggleNamed', { action, name: label(name) })} onClick={() => void toggle(name)}>{action}</Button>
        </li>;
      })}</ul>
      {busy && <p role="status">{label('saving')}</p>}
      <h3 className="font-semibold">{label('checklist')}</h3>
      <ul className="space-y-2">{checklist.items.map((item) => <li key={item.id} className="flex flex-wrap justify-between gap-2">
        <span><span className="font-medium">{label('item.' + item.id)}</span> · <span className="text-sm">{item.message}</span></span>
        <span className={'text-sm font-medium ' + statusStyle[item.status]}>{label('status.' + item.status)}</span>
      </li>)}</ul>
    </>}
  </section>;
}
