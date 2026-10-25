// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { goLiveChecklistResponseSchema, type GoLiveSwitches } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Alert } from '../../components/ui/alert.js';
import { LoadingState } from '../../components/ui/states.js';
import { Badge } from '../../components/ui/table.js';

type Checklist = ReturnType<typeof goLiveChecklistResponseSchema.parse>['data'];
const label = (key: string, values?: Record<string, string>) => t('settings/go-live:' + key, values);
const statusTone = { ready: 'success', needs_attention: 'warning', not_applicable: 'muted' } as const;

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
    <p className="text-sm text-muted-foreground">{label('help')}</p>
    {message && <Alert>{label(message)}{message === 'error' && !checklist &&
      <Button variant="outline" className="mt-3 sm:ml-3 sm:mt-0" onClick={() => { setMessage(null); setReload((value) => value + 1); }}>{label('retry')}</Button>}</Alert>}
    {!checklist ? busy && <LoadingState label={label('loading')}/> : <>
      <ul className="space-y-3">{(['billingEnabled', 'memberEmailsEnabled'] as const).map((name) => {
        const on = checklist[name], action = label(on ? 'turnOff' : 'turnOn');
        return <li key={name} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0"><p className="font-medium">{label(name)}: <span>{label(on ? 'on' : 'off')}</span></p>
            <p className="text-sm text-muted-foreground">{label(name === 'billingEnabled' ? 'billingHelp' : 'memberEmailsHelp')}</p></div>
          <Button variant={on ? 'outline' : 'default'} disabled={busy} aria-pressed={on}
            aria-label={label('toggleNamed', { action, name: label(name) })} onClick={() => void toggle(name)}>{action}</Button>
        </li>;
      })}</ul>
      {busy && <p role="status" className="text-sm text-muted-foreground">{label('saving')}</p>}
      <h3 className="font-semibold">{label('checklist')}</h3>
      <ul className="divide-y divide-border rounded-lg border border-border">{checklist.items.map((item) => <li key={item.id} className="flex items-start justify-between gap-3 p-3">
        <span className="min-w-0"><span className="block font-medium">{label('item.' + item.id)}</span><span className="block break-words text-sm text-muted-foreground">{item.message}</span></span>
        <Badge tone={statusTone[item.status]} className="shrink-0">{label('status.' + item.status)}</Badge>
      </li>)}</ul>
    </>}
  </section>;
}
