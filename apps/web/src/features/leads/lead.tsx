// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type ReactNode } from 'react';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { useBootstrap } from '../../app/context.js';
import { ApiError } from '../../lib/api.js';
import { Alert } from '../../components/ui/alert.js';
import { Card } from '../../components/ui/card.js';
import { Page, PageHeader, PageSection } from '../../components/ui/page.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';
import { leadClient, type Lead, type LeadClient } from './api.js';
import { LeadActions } from './board.js';
import { ContactForm, ContactLog } from './contacts.js';
import { leadName, type Outcome } from './dialogs.js';
import { text } from './text.js';

type Detail = Lead & { lostReason?: string | null };
interface WorkspaceProps { memberId: string; timezone: string; roles: readonly StaffRole[]; client?: LeadClient }
export function LeadWorkspace({ memberId, timezone, roles, client = leadClient }: WorkspaceProps) {
  if (!canStaff(roles, 'leads.manage')) return <Page><Alert variant="error">{text('noAccess')}</Alert></Page>;
  return <LeadView memberId={memberId} timezone={timezone} client={client} />;
}

function LeadView({ memberId, timezone, client }: { memberId: string; timezone: string; client: LeadClient }) {
  const [lead, setLead] = useState<Detail | null>(null), [state, setState] = useState<'loading' | 'ready' | 'missing' | 'failed'>('loading');
  const [version, setVersion] = useState(0), [contactsVersion, setContactsVersion] = useState(0), [outcome, setOutcome] = useState<Outcome | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    client.read(memberId, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setLead(value); setState('ready'); } })
      // A malformed ID in the address is refused as 400 and can never load, so it reads as not found too.
      .catch(error => { if (!controller.signal.aborted) setState(error instanceof ApiError && (error.status === 404 || error.status === 400) ? 'missing' : 'failed'); });
    return () => controller.abort();
  }, [client, memberId, version]);
  function done(result: Outcome) {
    setOutcome(result);
    if (result.lead) setLead(result.lead);
    if (result.reload) { setState('loading'); setVersion(value => value + 1); setContactsVersion(value => value + 1); }
  }
  const back = <a className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4" href="/admin/leads">{text('lead.back')}</a>;
  if (state === 'missing') return <Page>{back}<Alert variant="error">{text('lead.missing')}</Alert></Page>;
  const retry = () => { setState('loading'); setVersion(value => value + 1); };
  if (state === 'failed' && !lead) return <Page>{back}<ErrorState message={text('lead.loadError')} onRetry={retry} /></Page>;
  if (!lead) return <Page><LoadingState /></Page>;
  const name = leadName(lead);
  return <Page>
    {back}
    <PageHeader title={name} description={text('stage.' + lead.stage)} />
    {outcome && (outcome.error ? <Alert variant="error" focusOnReveal role="alert">{outcome.message}</Alert> : <p role="status" className="text-sm">{outcome.message}</p>)}
    {state === 'failed' && <ErrorState message={text('lead.loadError')} onRetry={retry} />}
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
      <div className="min-w-0 space-y-6">
        <Card aria-labelledby="lead-details" className="min-w-0 space-y-4 p-4 sm:p-6">
          <h2 id="lead-details" className="text-lg font-semibold">{text('lead.details')}</h2>
          <dl className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <Field label={text('lead.email')}>{lead.email ? <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={'mailto:' + lead.email}>{lead.email}</a> : text('lead.none')}</Field>
            <Field label={text('lead.phone')}>{lead.phone ? <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={'tel:' + lead.phone}>{lead.phone}</a> : text('lead.none')}</Field>
            <Field label={text('lead.status')}>{text('status.' + lead.status)}</Field>
            <Field label={text('source')}>{text('source.' + (lead.source ?? 'unknown'))}</Field>
            <Field label={text('lead.followUp')}>{lead.nextFollowUpOn ?? text('noFollowUp')}</Field>
            <Field label={text('lead.lastContacted')}>{lead.lastContactedAt ? <Instant value={lead.lastContactedAt} timezone={timezone} /> : text('lead.never')}</Field>
            <Field label={text('lead.created')}><Instant value={lead.createdAt} timezone={timezone} /></Field>
            {lead.stage === 'lost' && lead.lostReason && <Field label={text('reason')}>{lead.lostReason}</Field>}
          </dl>
          <a className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4" href={'/admin/members/' + encodeURIComponent(lead.memberId)}>{text('lead.profile')}</a>
        </Card>
        <Card aria-labelledby="lead-actions" className="min-w-0 space-y-4 p-4 sm:p-6">
          <h2 id="lead-actions" className="text-lg font-semibold">{text('lead.actions')}</h2>
          <fieldset disabled={state !== 'ready'} className="min-w-0"><LeadActions lead={lead} client={client} timezone={timezone} onDone={done} logContact={false} /></fieldset>
        </Card>
      </div>
      <PageSection title={text('contacts.heading')} description={text('contacts.help', { timezone })}>
        <Card className="min-w-0 p-4 sm:p-6">
          <fieldset disabled={state !== 'ready'} className="min-w-0"><ContactForm lead={lead} client={client} onDone={done} onSaved={result => {
            setLead(result.lead); setContactsVersion(value => value + 1);
            setOutcome({ message: text('contacts.saved'), reload: false });
          }} /></fieldset>
        </Card>
        <ContactLog memberId={lead.memberId} client={client} timezone={timezone} version={contactsVersion} />
      </PageSection>
    </div>
  </Page>;
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="font-medium">{children}</dd></div>;
}
function Instant({ value, timezone }: { value: string; timezone: string }) {
  return <time dateTime={value}>{new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(value))}</time>;
}

export function LeadPage({ memberId }: { memberId: string }) {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <LoadingState />;
  if (bootstrap.isError) return <ErrorState onRetry={() => void bootstrap.refetch()} />;
  const { gym, session } = bootstrap.data;
  if (!session) return <Alert variant="error">{text('noAccess')}</Alert>;
  return <LeadWorkspace key={gym.id + session.userId + memberId} memberId={memberId} timezone={gym.timezone} roles={session.roles} />;
}
