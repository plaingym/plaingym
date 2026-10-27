// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import { createLinkCampaignRequestSchema, type CreateLinkCampaignRequest, type Household } from '@plaingym/shared/contracts';
import { zonedInstant } from '@plaingym/shared/time';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select, CheckboxField } from '../../components/ui/select.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Alert } from '../../components/ui/alert.js';
import { t } from '../../lib/i18n.js';
import { campaignClient } from './api.js';
import { ApiError } from '../../lib/api.js';

export const text = (key: string) => t('links/campaigns:' + key);
export function CampaignEditor({ households, timezone, save, close, loadNeedsCard = campaignClient.needsCard }: {
  households: Household[]; timezone: string; save(input: CreateLinkCampaignRequest): Promise<void>; close(): void;
  loadNeedsCard?(households: Household[]): Promise<string[]>;
}) {
  const [name, setName] = useState(''), [purpose, setPurpose] = useState<'onboarding' | 'update_card'>('onboarding');
  const [expires, setExpires] = useState(''), [days, setDays] = useState('3, 7'), [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set()), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [needsCard, setNeedsCard] = useState(false), [cardIds, setCardIds] = useState<string[]>([]), [loadingCards, setLoadingCards] = useState(false);
  const cardRequest = useRef(0);
  const visible = households.filter(h => (!needsCard || cardIds.includes(h.id))
    && (h.name + ' ' + (h.email ?? '')).toLowerCase().includes(search.toLowerCase()));
  async function cardFilter(enabled: boolean) {
    const request = ++cardRequest.current;
    setNeedsCard(enabled); setError(''); setCardIds([]); setLoadingCards(enabled);
    if (!enabled) return;
    try { const ids = await loadNeedsCard(households); if (cardRequest.current === request) setCardIds(ids); }
    catch { if (cardRequest.current === request) setError(text('cardError')); }
    finally { if (cardRequest.current === request) setLoadingCards(false); }
  }
  async function submit() {
    setError('');
    let input: CreateLinkCampaignRequest;
    try {
      const reminderSchedule = days.trim() ? days.split(',').map(d => Number(d.trim())) : [];
      const expiry = zonedInstant(expires, '23:59:59', timezone, { gap: 'shift' })!;
      const limit = name.trim().length > 120 ? 'nameLimit' : selected.size > 2000 ? 'recipientLimit'
        : reminderSchedule.length > 10 ? 'scheduleLimit' : reminderSchedule.some(day => day > 365) ? 'dayLimit'
          : expiry.getTime() > Date.now() + 90 * 86400000 ? 'expiryLimit' : undefined;
      if (limit) { setError(text(limit)); return; }
      input = createLinkCampaignRequestSchema.parse({ name, purpose,
        expiresAt: expiry.toISOString(), reminderSchedule,
        recipients: [...selected].map(householdId => ({ householdId })),
      });
    } catch { setError(text('invalid')); return; }
    setBusy(true);
    try { await save(input); } catch (error) { setError(text(error instanceof ApiError && error.code === 'invalid_request' ? 'limits' : 'saveError')); }
    finally { setBusy(false); }
  }
  return <Dialog title={text('create')} closeLabel={text('close')} onClose={() => { if (!busy) close(); }}>
    <form className="min-w-0 space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <div><Label htmlFor="campaign-name">{text('name')}</Label><Input id="campaign-name" maxLength={120} value={name} onChange={e => setName(e.target.value)} required /></div>
        <div><Label htmlFor="campaign-purpose">{text('purpose')}</Label><Select id="campaign-purpose" value={purpose} onChange={e => setPurpose(e.target.value as typeof purpose)}>
          <option value="onboarding">{text('onboarding')}</option><option value="update_card">{text('update_card')}</option>
        </Select></div>
        <div><Label htmlFor="campaign-expiry">{text('expires')}</Label><Input id="campaign-expiry" type="date" value={expires} onChange={e => setExpires(e.target.value)} required /><p className="text-sm text-muted-foreground">{text('expiryHelp')} {timezone}</p></div>
        <div><Label htmlFor="campaign-days">{text('days')}</Label><Input id="campaign-days" value={days} onChange={e => setDays(e.target.value)} aria-describedby="campaign-days-help" /><p id="campaign-days-help" className="text-sm text-muted-foreground">{text('daysHelp')}</p></div>
        <fieldset className="min-w-0 space-y-2"><legend className="font-medium">{text('recipients')} ({selected.size})</legend>
          <Label htmlFor="campaign-search">{text('search')}</Label><Input id="campaign-search" value={search} onChange={e => setSearch(e.target.value)} />
          <CheckboxField label={text('needsCard')} checked={needsCard} onChange={e => void cardFilter(e.target.checked)} />
          {loadingCards && <p role="status">{text('loadingCards')}</p>}
          <p className="text-sm text-muted-foreground">{text('selectionHelp')}</p>
          <Button type="button" variant="outline" disabled={loadingCards} onClick={() => setSelected(previous => new Set([...previous, ...visible.filter(h => h.email).map(h => h.id)]))}>{text('selectVisible')}</Button>
          <Button type="button" variant="ghost" onClick={() => setSelected(new Set())}>{text('clear')}</Button>
          <div className="max-h-64 space-y-1 overflow-y-auto">{visible.map(h => <CheckboxField key={h.id} checked={selected.has(h.id)} disabled={!h.email}
            onChange={e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(h.id); else next.delete(h.id); return next; })}
            label={<span className="min-w-0 break-all">{h.name}<span className="block text-sm text-muted-foreground">{h.email ?? text('noEmail')}</span></span>} />)}</div>
        </fieldset>
        <p className="text-sm text-muted-foreground">{text('sendHelp')}</p>
        {error && <Alert role="alert">{error}</Alert>}
        <Button type="submit" className="w-full sm:w-auto" disabled={!selected.size || loadingCards}>{text(busy ? 'saving' : 'send')}</Button>
      </fieldset>
    </form>
  </Dialog>;
}
