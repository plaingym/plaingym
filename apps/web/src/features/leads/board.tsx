// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LeadSource, LeadStage } from '@plaingym/shared/contracts';
import { ApiError } from '../../lib/api.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { userNames } from '../../components/ui/page.js';
import { LoadingState } from '../../components/ui/states.js';
import type { Lead, LeadClient } from './api.js';
import { BookDialog, LostDialog, changedOutcome, leadName, type Outcome } from './dialogs.js';
import { ContactDialog } from './contacts.js';
import { text } from './text.js';

/** The stages staff can set by hand; won and lost have their own paths. */
export const openStages = ['new', 'contacted', 'trial_booked', 'trial_attended'] as const satisfies readonly LeadStage[];
export interface Filters { source: LeadSource | 'unknown' | ''; due: boolean }
const pageSize = 25;

interface ColumnProps { stage: LeadStage; filters: Filters; version: number; client: LeadClient; timezone: string; onDone(outcome: Outcome): void }
/** One stage: its own total and its own pages, so a long list in one stage never hides another. */
export function StageColumn({ stage, filters, version, client, timezone, onDone }: ColumnProps) {
  const [rows, setRows] = useState<Lead[]>([]), [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true), [more, setMore] = useState(false), [failed, setFailed] = useState(false);
  const query = useMemo(() => ({ stage, ...(filters.source ? { source: filters.source } : {}), ...(filters.due ? { due: true } : {}) }), [stage, filters.source, filters.due]);
  const loaded = useRef(pageSize), previousQuery = useRef(query);
  // Bumped by every first-page load, so a "Show more" page from an earlier filter or reload is dropped.
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    const controller = new AbortController();
    if (previousQuery.current !== query) { loaded.current = pageSize; previousQuery.current = query; }
    const target = loaded.current;
    setLoading(true); setFailed(false);
    async function reload() {
      const rows: Lead[] = [];
      let total = 0;
      for (let offset = 0; offset < target; offset += pageSize) {
        const page = await client.list({ ...query, limit: pageSize, offset }, controller.signal);
        if (controller.signal.aborted) return;
        // Rows can move between pages while they load; keep each lead once.
        for (const row of page.data) if (!rows.some(have => have.memberId === row.memberId)) rows.push(row);
        total = page.pagination.total;
        if (offset + pageSize >= total) break;
      }
      setRows(rows); setTotal(total);
    }
    void reload()
      .catch(() => { if (!controller.signal.aborted) { setRows([]); setTotal(0); setFailed(true); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, query, version]);
  async function loadMore() {
    const started = generation.current;
    setMore(true); setFailed(false);
    try {
      const page = await client.list({ ...query, limit: pageSize, offset: rows.length });
      if (started !== generation.current) return;
      loaded.current += pageSize;
      setRows(current => [...current, ...page.data.filter(row => !current.some(have => have.memberId === row.memberId))]); setTotal(page.pagination.total);
    } catch { if (started === generation.current) setFailed(true); } finally { setMore(false); }
  }
  return <section aria-label={text('stage.' + stage)} className="min-w-0 space-y-3 rounded-xl border border-border bg-muted/30 p-3">
    <h2 className="text-base font-semibold">{loading ? text('stage.' + stage) : text('count', { stage: text('stage.' + stage), count: total })}</h2>
    {failed && <Alert variant="error" role="alert">{text('loadError')}</Alert>}
    {loading && <LoadingState />}
    {!loading && rows.length === 0 && !failed && <p className="text-sm text-muted-foreground">{text('empty')}</p>}
    <fieldset disabled={loading} className="min-w-0"><ul className="space-y-3">{rows.map(lead => <li key={lead.memberId} className="min-w-0">
      <LeadCard lead={lead} client={client} timezone={timezone} onDone={result => onDone({ ...result,
        stages: result.lead ? [lead.stage, result.lead.stage] : result.error ? undefined : [lead.stage] })} /></li>)}</ul></fieldset>
    {!loading && rows.length < total && <Button variant="outline" className="w-full" disabled={more} onClick={() => void loadMore()}>{text('more')}</Button>}
  </section>;
}

interface ActionProps { lead: Lead; client: LeadClient; timezone: string; onDone(outcome: Outcome): void }
function LeadCard(props: ActionProps) {
  const { lead } = props, name = leadName(lead);
  return <article className="min-w-0 space-y-3 rounded-lg border border-border bg-background p-3">
    <div className="min-w-0">
      <h3 className={'font-medium ' + userNames}>
        <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={leadHref(lead.memberId)}>{name}</a>
      </h3>
      <p className="text-sm text-muted-foreground">{text('source.' + (lead.source ?? 'unknown'))} · {text('status.' + lead.status)}</p>
      <p className="text-sm text-muted-foreground">{lead.nextFollowUpOn ? text('followUpOn', { date: lead.nextFollowUpOn }) : text('noFollowUp')}</p>
    </div>
    <LeadActions {...props} />
  </article>;
}
export const leadHref = (memberId: string) => '/admin/leads/' + encodeURIComponent(memberId);

/** The lead's quick actions, on the board and on the lead page; `logContact` adds the log-a-contact dialog. */
export function LeadActions({ lead, client, timezone, onDone, logContact = true }: ActionProps & { logContact?: boolean }) {
  const [busy, setBusy] = useState(false), [dialog, setDialog] = useState<'book' | 'lost' | 'contact' | null>(null);
  const name = leadName(lead), lost = lead.stage === 'lost';
  async function run(action: () => Promise<Lead>, message: string) {
    setBusy(true);
    try { const lead = await action(); onDone({ message, reload: true, lead }); }
    catch (error) { onDone(error instanceof ApiError && error.status === 409 ? changedOutcome() : { message: text('error'), error: true, reload: false }); }
    finally { setBusy(false); }
  }
  function finished(outcome: Outcome) { setDialog(null); onDone(outcome); }
  // Saved when the field loses focus: typing a date fires a change per digit, and each would be a write.
  const saved = lead.nextFollowUpOn ?? '', [followUp, setFollowUp] = useState(saved);
  useEffect(() => setFollowUp(saved), [saved, lead.revision]);
  function saveFollowUp(input: HTMLInputElement) {
    // A partly typed date reads as empty; keep the saved date rather than clearing it.
    if (input.validity.badInput) { setFollowUp(saved); return; }
    const value = input.value;
    if (value !== saved) void run(() => client.edit(lead, { nextFollowUpOn: value || null }), text('saved'));
  }
  // A won lead keeps its stage; only its follow-up date and the contact log stay open to staff.
  const won = lead.stage === 'won';
  return <div className="min-w-0 space-y-3">
    {!lost && <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-1">
      {!won && <Select aria-label={text('stageFor', { name })} value={lead.stage} disabled={busy}
        onChange={event => void run(() => client.edit(lead, { stage: event.target.value as (typeof openStages)[number] }), text('saved'))}>
        {openStages.map(stage => <option key={stage} value={stage}>{text('stage.' + stage)}</option>)}
        {!(openStages as readonly string[]).includes(lead.stage) && <option value={lead.stage} disabled>{text('stage.' + lead.stage)}</option>}
      </Select>}
      <Input type="date" aria-label={text('followUpFor', { name })} value={followUp} disabled={busy}
        onChange={event => setFollowUp(event.target.value)} onBlur={event => saveFollowUp(event.currentTarget)} />
    </div>}
    <div className="flex flex-wrap gap-2">
      {logContact && <Button variant="outline" disabled={busy} aria-label={text('logContactFor', { name })} onClick={() => setDialog('contact')}>{text('logContact')}</Button>}
      {lost ? <Button variant="outline" disabled={busy} aria-label={text('reopenFor', { name })} onClick={() => void run(() => client.reopen(lead), text('reopened'))}>{text('reopen')}</Button> : !won && <>
        <Button variant="outline" disabled={busy} aria-label={text('bookFor', { name })} onClick={() => setDialog('book')}>{text('book')}</Button>
        <Button asChild variant="outline"><a aria-label={text('convertFor', { name })} href={'/admin/members/' + encodeURIComponent(lead.memberId) + '#memberTabs.membership'}>{text('convert')}</a></Button>
        <Button variant="outline" disabled={busy} aria-label={text('lostFor', { name })} onClick={() => setDialog('lost')}>{text('lost')}</Button>
      </>}
    </div>
    {dialog === 'book' && <BookDialog lead={lead} client={client} timezone={timezone} onClose={() => setDialog(null)} onDone={finished} />}
    {dialog === 'lost' && <LostDialog lead={lead} client={client} onClose={() => setDialog(null)} onDone={finished} />}
    {dialog === 'contact' && <ContactDialog lead={lead} client={client} onClose={() => setDialog(null)} onDone={finished} />}
  </div>;
}
