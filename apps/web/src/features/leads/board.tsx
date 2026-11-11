// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
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
  const query = { stage, ...(filters.source ? { source: filters.source } : {}), ...(filters.due ? { due: true } : {}) };
  const key = JSON.stringify(query);
  // Bumped by every first-page load, so a "Show more" page from an earlier filter or reload is dropped.
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    const controller = new AbortController();
    setLoading(true); setFailed(false);
    client.list({ ...JSON.parse(key), limit: pageSize, offset: 0 }, controller.signal)
      .then(page => { if (controller.signal.aborted) return; setRows(page.data); setTotal(page.pagination.total); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, key, version]);
  async function loadMore() {
    const started = generation.current;
    setMore(true); setFailed(false);
    try {
      const page = await client.list({ ...query, limit: pageSize, offset: rows.length });
      if (started !== generation.current) return;
      setRows(current => [...current, ...page.data.filter(row => !current.some(have => have.memberId === row.memberId))]); setTotal(page.pagination.total);
    } catch { if (started === generation.current) setFailed(true); } finally { setMore(false); }
  }
  return <section aria-label={text('stage.' + stage)} className="min-w-0 space-y-3 rounded-xl border border-border bg-muted/30 p-3">
    <h2 className="text-base font-semibold">{loading ? text('stage.' + stage) : text('count', { stage: text('stage.' + stage), count: total })}</h2>
    {failed && <Alert role="alert">{text('loadError')}</Alert>}
    {loading ? <LoadingState /> : rows.length === 0 && !failed ? <p className="text-sm text-muted-foreground">{text('empty')}</p>
      : <ul className="space-y-3">{rows.map(lead => <li key={lead.memberId} className="min-w-0">
        <LeadCard lead={lead} client={client} timezone={timezone} onDone={onDone} /></li>)}</ul>}
    {!loading && rows.length < total && <Button variant="outline" className="w-full" disabled={more} onClick={() => void loadMore()}>{text('more')}</Button>}
  </section>;
}

function LeadCard({ lead, client, timezone, onDone }: { lead: Lead; client: LeadClient; timezone: string; onDone(outcome: Outcome): void }) {
  const [busy, setBusy] = useState(false), [dialog, setDialog] = useState<'book' | 'lost' | null>(null);
  const name = leadName(lead), lost = lead.stage === 'lost';
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    try { await action(); onDone({ message, reload: true }); }
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
  return <article className="min-w-0 space-y-3 rounded-lg border border-border bg-background p-3">
    <div className="min-w-0">
      <h3 className={'font-medium ' + userNames}>{name}</h3>
      <p className="text-sm text-muted-foreground">{text('source.' + (lead.source ?? 'unknown'))} · {text('status.' + lead.status)}</p>
      <p className="text-sm text-muted-foreground">{lead.nextFollowUpOn ? text('followUpOn', { date: lead.nextFollowUpOn }) : text('noFollowUp')}</p>
    </div>
    {!lost && <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-1">
      <Select aria-label={text('stageFor', { name })} value={lead.stage} disabled={busy}
        onChange={event => void run(() => client.edit(lead, { stage: event.target.value as (typeof openStages)[number] }), text('saved'))}>
        {openStages.map(stage => <option key={stage} value={stage}>{text('stage.' + stage)}</option>)}
        {!(openStages as readonly string[]).includes(lead.stage) && <option value={lead.stage} disabled>{text('stage.' + lead.stage)}</option>}
      </Select>
      <Input type="date" aria-label={text('followUpFor', { name })} value={followUp} disabled={busy}
        onChange={event => setFollowUp(event.target.value)} onBlur={event => saveFollowUp(event.currentTarget)} />
    </div>}
    <div className="flex flex-wrap gap-2">
      {lost ? <Button variant="outline" disabled={busy} aria-label={text('reopenFor', { name })} onClick={() => void run(() => client.reopen(lead), text('reopened'))}>{text('reopen')}</Button> : <>
        <Button variant="outline" disabled={busy} aria-label={text('bookFor', { name })} onClick={() => setDialog('book')}>{text('book')}</Button>
        <Button asChild variant="outline"><a aria-label={text('convertFor', { name })} href={'/admin/members/' + encodeURIComponent(lead.memberId) + '#memberTabs.membership'}>{text('convert')}</a></Button>
        <Button variant="outline" disabled={busy} aria-label={text('lostFor', { name })} onClick={() => setDialog('lost')}>{text('lost')}</Button>
      </>}
    </div>
    {dialog === 'book' && <BookDialog lead={lead} client={client} timezone={timezone} onClose={() => setDialog(null)} onDone={finished} />}
    {dialog === 'lost' && <LostDialog lead={lead} client={client} onClose={() => setDialog(null)} onDone={finished} />}
  </article>;
}
