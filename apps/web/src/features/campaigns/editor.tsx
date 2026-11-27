// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import { campaignLimits, createLinkCampaignRequestSchema, type CreateLinkCampaignRequest, type Household } from '@plaingym/shared/contracts';
import { zonedInstant } from '@plaingym/shared/time';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select, CheckboxField } from '../../components/ui/select.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Alert } from '../../components/ui/alert.js';
import { t } from '../../lib/i18n.js';
import { campaignClient, type MemberNeedingWaiver } from './api.js';
import { ApiError } from '../../lib/api.js';

const limitValues = Object.fromEntries(Object.entries(campaignLimits).map(([key, value]) => [key, value.toLocaleString('en')]));
export const text = (key: string) => t('links/campaigns:' + key, limitValues);
type Purpose = 'onboarding' | 'update_card' | 'sign_waiver';
/** One row of the picker: a household, or for Sign waivers a member with their household. */
interface Row { id: string; householdId: string; title: string; email: string | null; search: string }
export function CampaignEditor({ households, timezone, save, close, loadNeedsCard = campaignClient.needsCard, loadNeedsWaiver = campaignClient.needsWaiver }: {
  households: Household[]; timezone: string; save(input: CreateLinkCampaignRequest): Promise<void>; close(): void;
  loadNeedsCard?(households: Household[]): Promise<string[]>;
  loadNeedsWaiver?(): Promise<MemberNeedingWaiver[]>;
}) {
  const [name, setName] = useState(''), [purpose, setPurpose] = useState<Purpose>('onboarding');
  const [expires, setExpires] = useState(''), [days, setDays] = useState('3, 7'), [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set()), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [needsCard, setNeedsCard] = useState(false), [cardIds, setCardIds] = useState<string[]>([]), [loadingCards, setLoadingCards] = useState(false);
  const [waiverMembers, setWaiverMembers] = useState<MemberNeedingWaiver[] | null>(null);
  const [loadingMembers, setLoadingMembers] = useState(false), [membersFailed, setMembersFailed] = useState(false);
  const cardRequest = useRef(0), memberRequest = useRef(0);
  const members = purpose === 'sign_waiver';
  const rows: Row[] = members
    ? (waiverMembers ?? []).map(m => ({ id: m.memberId, householdId: m.householdId, title: m.firstName + ' ' + m.lastName + ', ' + m.householdName,
      email: m.householdEmail, search: m.firstName + ' ' + m.lastName + ' ' + m.householdName + ' ' + (m.householdEmail ?? '') }))
    : households.filter(h => !needsCard || cardIds.includes(h.id))
      .map(h => ({ id: h.id, householdId: h.id, title: h.name, email: h.email ?? null, search: h.name + ' ' + (h.email ?? '') }));
  const visible = rows.filter(row => row.search.toLowerCase().includes(search.toLowerCase()));
  const loading = members ? loadingMembers : loadingCards;
  async function cardFilter(enabled: boolean) {
    const request = ++cardRequest.current;
    setNeedsCard(enabled); setError(''); setCardIds([]); setLoadingCards(enabled);
    if (!enabled) return;
    try { const ids = await loadNeedsCard(households); if (cardRequest.current === request) setCardIds(ids); }
    catch { if (cardRequest.current === request) setError(text('cardError')); }
    finally { if (cardRequest.current === request) setLoadingCards(false); }
  }
  async function loadMembers() {
    const request = ++memberRequest.current;
    setLoadingMembers(true); setMembersFailed(false);
    try { const loaded = await loadNeedsWaiver(); if (memberRequest.current === request) setWaiverMembers(loaded); }
    catch { if (memberRequest.current === request) setMembersFailed(true); }
    finally { if (memberRequest.current === request) setLoadingMembers(false); }
  }
  function choosePurpose(next: Purpose) {
    setPurpose(next); setSelected(new Set()); setSearch(''); setError('');
    if (next === 'sign_waiver' && waiverMembers === null && !loadingMembers) void loadMembers();
  }
  async function submit() {
    setError('');
    let input: CreateLinkCampaignRequest;
    try {
      const reminderSchedule = days.trim() ? days.split(',').map(d => Number(d.trim())) : [];
      const expiry = zonedInstant(expires, '23:59:59', timezone, { gap: 'shift' })!;
      const limit = name.trim().length > campaignLimits.name ? 'nameLimit' : selected.size > campaignLimits.recipients ? (members ? 'memberLimit' : 'recipientLimit')
        : reminderSchedule.length > campaignLimits.reminders ? 'scheduleLimit' : reminderSchedule.some(day => day > campaignLimits.reminderDay) ? 'dayLimit'
          : expiry.getTime() > Date.now() + campaignLimits.expiryDays * 86400000 ? 'expiryLimit' : undefined;
      if (limit) { setError(text(limit)); return; }
      const householdOf = new Map(rows.map(row => [row.id, row.householdId]));
      input = createLinkCampaignRequestSchema.parse({ name, purpose,
        expiresAt: expiry.toISOString(), reminderSchedule,
        recipients: members ? [...selected].map(memberId => ({ householdId: householdOf.get(memberId), memberId }))
          : [...selected].map(householdId => ({ householdId })),
      });
    } catch { setError(text('invalid')); return; }
    setBusy(true);
    try { await save(input); } catch (error) { setError(text(error instanceof ApiError && error.code === 'invalid_request' ? 'limits' : 'saveError')); }
    finally { setBusy(false); }
  }
  return <Dialog title={text('create')} closeLabel={text('close')} dismissible={!busy} onClose={close}>
    <form className="min-w-0 space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <div><Label htmlFor="campaign-name">{text('name')}</Label><Input id="campaign-name" maxLength={campaignLimits.name} value={name} onChange={e => setName(e.target.value)} required /></div>
        <div><Label htmlFor="campaign-purpose">{text('purpose')}</Label><Select id="campaign-purpose" value={purpose} onChange={e => choosePurpose(e.target.value as Purpose)}>
          <option value="onboarding">{text('onboarding')}</option><option value="update_card">{text('update_card')}</option>
          <option value="sign_waiver">{text('sign_waiver')}</option>
        </Select></div>
        <div><Label htmlFor="campaign-expiry">{text('expires')}</Label><Input id="campaign-expiry" type="date" value={expires} onChange={e => setExpires(e.target.value)} required /><p className="text-sm text-muted-foreground">{text('expiryHelp')} {timezone}</p></div>
        <div><Label htmlFor="campaign-days">{text('days')}</Label><Input id="campaign-days" value={days} onChange={e => setDays(e.target.value)} aria-describedby="campaign-days-help" /><p id="campaign-days-help" className="text-sm text-muted-foreground">{text('daysHelp')}</p></div>
        <fieldset className="min-w-0 space-y-2"><legend className="font-medium">{text(members ? 'members' : 'recipients')} ({selected.size})</legend>
          <Label htmlFor="campaign-search">{text(members ? 'searchMembers' : 'search')}</Label><Input id="campaign-search" value={search} onChange={e => setSearch(e.target.value)} />
          {!members && <CheckboxField label={text('needsCard')} checked={needsCard} onChange={e => void cardFilter(e.target.checked)} />}
          {loadingCards && !members && <p role="status">{text('loadingCards')}</p>}
          {loadingMembers && members && <p role="status">{text('loadingMembers')}</p>}
          {membersFailed && members && <Alert variant="error" role="alert">{text('membersError')}
            <Button type="button" variant="outline" className="mt-2 block" onClick={() => void loadMembers()}>{text('retry')}</Button></Alert>}
          {members && waiverMembers?.length === 0 && <p>{text('noMembersNeedWaiver')}</p>}
          <p className="text-sm text-muted-foreground">{text(members ? 'memberSelectionHelp' : 'selectionHelp')}</p>
          <Button type="button" variant="outline" disabled={loading} onClick={() => setSelected(previous => new Set([...previous, ...visible.filter(row => row.email).map(row => row.id)]))}>{text(members ? 'selectVisibleMembers' : 'selectVisible')}</Button>
          <Button type="button" variant="ghost" onClick={() => setSelected(new Set())}>{text('clear')}</Button>
          <div className="max-h-64 space-y-1 overflow-y-auto">{visible.map(row => <CheckboxField key={row.id} checked={selected.has(row.id)} disabled={!row.email}
            onChange={e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(row.id); else next.delete(row.id); return next; })}
            label={<span className="min-w-0 break-all">{row.title}<span className="block text-sm text-muted-foreground">{row.email ?? text('noEmail')}</span></span>} />)}</div>
        </fieldset>
        <p className="text-sm text-muted-foreground">{text('sendHelp')}</p>
        {error && <Alert variant="error" focusOnReveal role="alert">{error}</Alert>}
        <Button type="submit" className="w-full sm:w-auto" disabled={!selected.size || loading}>{text(busy ? 'saving' : 'send')}</Button>
      </fieldset>
    </form>
  </Dialog>;
}
