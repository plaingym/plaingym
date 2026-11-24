// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import type { CreateSignedLinkRequest, Household, Member } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import type { ExtensionViewProps } from '../../lib/registries.js';
import { t } from '../../lib/i18n.js';
import { useSendGeneration } from '../../lib/send-generation.js';
import { useMemberTabActive } from '../members/tab-activity.js';
import { invoiceClient, InvoiceRequestError } from '../billing/invoices/api.js';
import { PageSection } from '../../components/ui/page.js';
import { LoadingState, ErrorState } from '../../components/ui/states.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';

const text = (key: string, values?: Record<string, string>) => t('links/member-links:' + key, values);
const purposes = ['onboarding', 'update_card', 'sign_waiver'] as const;
type Purpose = typeof purposes[number];
const expiryMs = 7 * 86400_000;

/** The member record's Links tab: send the household a registration, card update or signing link, or show it. */
export function MemberLinksTab({ memberId }: ExtensionViewProps) {
  const bootstrap = useBootstrap(), gymId = bootstrap.data?.gym.id;
  const allowed = canStaff(bootstrap.data?.session?.roles ?? [], 'links.send');
  // The member page keeps every tab mounted: load only while this tab is open, and fresh each time it opens,
  // so consent, email or household changes made on another tab apply here.
  const active = useMemberTabActive();
  const member = useQuery({ queryKey: ['billing', gymId, 'invoice-member', memberId], queryFn: () => invoiceClient.member(memberId!), enabled: !!gymId && !!memberId && allowed && active, staleTime: 0 });
  const homeId = member.data?.anonymizedAt ? undefined : member.data?.householdId;
  const household = useQuery({ queryKey: ['billing', gymId, 'household', homeId], queryFn: () => invoiceClient.household(homeId!), enabled: !!homeId && active, staleTime: 0 });
  const people = useQuery({ queryKey: ['billing', gymId, 'householdMembers', homeId], queryFn: () => invoiceClient.householdMembers(homeId!), enabled: !!homeId && active, staleTime: 0 });
  if (bootstrap.isPending) return <LoadingState/>;
  // A disabled query stays pending, so a closed tab must not show its loading state.
  if (!gymId || !memberId || !allowed || !active) return null;
  if (member.isPending) return <LoadingState/>;
  if (member.isError) return <ErrorState onRetry={() => void member.refetch()}/>;
  if (member.data.anonymizedAt) return <PageSection title={text('title')}><Alert>{text('erased')}</Alert></PageSection>;
  if (household.isError || people.isError) return <ErrorState onRetry={() => {
    if (household.isError) void household.refetch();
    if (people.isError) void people.refetch();
  }}/>;
  if (household.isPending || people.isPending) return <LoadingState/>;
  return <PageSection title={text('title')} description={text('description')}>
    <LinkForm gymId={gymId} member={member.data} household={household.data} people={people.data}/>
  </PageSection>;
}

function LinkForm({ gymId, member, household, people }: { gymId: string; member: Member; household: Household; people: readonly Member[] }) {
  const [purpose, setPurpose] = useState<Purpose>('onboarding'), [chosen, setChosen] = useState('email');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [url, setUrl] = useState('');
  const linkSend = useSendGeneration('member-link'), { uncertain } = linkSend;
  const householdRefusal = smsRefusal(household.sms);
  const optionsFor = (forPurpose: Purpose) => [
    { value: 'email', label: text('email'), refusal: '' },
    { value: 'copy', label: text('copy'), refusal: '' },
    { value: 'sms:household', label: text('smsHousehold'), refusal: householdRefusal },
    ...people.map(person => ({ value: 'sms:' + person.id, label: text('smsMember', { name: `${person.firstName} ${person.lastName}` }),
      refusal: memberSmsRefusal(person, household, forPurpose) })),
  ];
  const offered = (value: string, forPurpose: Purpose) => optionsFor(forPurpose).some(option => option.value === value && !option.refusal);
  const options = optionsFor(purpose);
  // A purpose change (or fresher household data) can disable the chosen text recipient; fall back to email rather
  // than submit a disabled option, and forget the recipient so a later change never brings a text back unasked.
  const delivery = offered(chosen, purpose) ? chosen : 'email';
  function change(next: () => void) { next(); linkSend.reset(); setError(''); setMessage(''); setUrl(''); }
  function changePurpose(next: Purpose) {
    change(() => { setPurpose(next); setChosen(offered(delivery, next) ? delivery : 'email'); });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(''); setMessage(''); setUrl('');
    try {
      const sms = delivery.startsWith('sms:'), recipientMemberId = sms && delivery !== 'sms:household' ? delivery.slice(4) : undefined;
      const request: CreateSignedLinkRequest = { householdId: member.householdId, expiresAt: new Date(Date.now() + expiryMs).toISOString(),
        ...(purpose === 'sign_waiver' ? { purpose, memberId: member.id } : { purpose }) };
      if (delivery === 'copy') {
        const result = await invoiceClient.link(request);
        linkSend.reset();
        if ('token' in result.data) setUrl(new URL('/l/' + result.data.token, location.origin).href);
        return;
      }
      if (uncertain) linkSend.resend();
      const sendGeneration = linkSend.generation({ gymId, memberId: member.id, purpose, delivery });
      const result = await invoiceClient.link(request, sendGeneration,
        sms ? { channel: 'sms', ...(recipientMemberId ? { recipientMemberId } : {}) } : undefined);
      setMessage(text(linkSend.settle(result.data) ? 'uncertain' : 'sent'));
    } catch (failure) {
      setError(refusalMessage(failure, delivery, household));
    } finally { setBusy(false); }
  }
  return <form onSubmit={event => void submit(event)} className="max-w-xl space-y-4">
    {error && <Alert variant="error" focusOnReveal>{error}</Alert>}
    {message && <Alert>{message}</Alert>}
    <fieldset disabled={busy} className="space-y-4">
      <Label className="block">{text('purpose')}<Select name="purpose" value={purpose}
        onChange={event => changePurpose(event.target.value as Purpose)}>
        {purposes.map(value => <option key={value} value={value}>{text(value)}</option>)}
      </Select></Label>
      <div className="space-y-1">
        <Label className="block">{text('delivery')}<Select name="delivery" value={delivery} onChange={event => change(() => setChosen(event.target.value))}>
          {options.map(option => <option key={option.value} value={option.value} disabled={!!option.refusal}>
            {option.label}{option.refusal && ' — ' + option.refusal}
          </option>)}
        </Select></Label>
        <p className="text-sm text-muted-foreground">{text('smsHelp')}</p>
      </div>
      {url ? <Label className="block">{text('linkReady')}<Input readOnly value={url} onFocus={event => event.target.select()}/></Label>
        : <Button type="submit" className="w-full sm:w-auto">{text(busy ? 'sending' : uncertain ? 'sendAgain' : delivery === 'copy' ? 'create' : 'send')}</Button>}
    </fieldset>
  </form>;
}

// The same recipient rules as the invoice pay link, except that only a card update is limited to the payer.
function smsRefusal(sms?: { notices: unknown; phoneValid: boolean }) {
  return !sms?.notices ? text('smsNoConsent') : !sms.phoneValid ? text('smsInvalidPhone') : '';
}
function memberSmsRefusal(person: Member, household: Household, purpose: Purpose) {
  if (person.anonymizedAt) return text('smsAnonymized');
  const refusal = smsRefusal(person.sms);
  if (refusal || purpose !== 'update_card') return refusal;
  return !household.email?.trim() || household.sms.notices && household.sms.phoneE164
    || person.email?.trim().toLowerCase() !== household.email.trim().toLowerCase() ? text('smsPayerOnly') : '';
}
function refusalMessage(failure: unknown, delivery: string, household: Household) {
  const reason = failure instanceof InvoiceRequestError ? failure.reason : '';
  const sms = delivery.startsWith('sms:');
  if (['household_email_missing', 'email_disabled', 'recipient_suppressed', 'recipient_suppressed_sms', 'delivery_unavailable', 'delivery_failed'].includes(reason)) {
    return text('errors.' + reason);
  }
  if (['sms_no_consent', 'sms_invalid_phone', 'sms_payer_only', 'forbidden'].includes(reason)) return text('errors.' + reason);
  // Fallback for a reasonless 503: check the household email before assuming delivery is unavailable.
  if (delivery === 'email' && failure instanceof InvoiceRequestError && !validEmail(household.email)) return text('errors.household_email');
  // The client reads a 503 without a reason as `payments_unavailable`; the server names each send refusal, so this is a fallback.
  if (reason === 'payments_unavailable') return text(sms ? 'errors.text_unavailable' : 'errors.email_unavailable');
  return text('errors.failed');
}
function validEmail(email: string | null | undefined) {
  return !!email?.trim() && !/[\r\n\0]/.test(email);
}
