// SPDX-License-Identifier: AGPL-3.0-only
import { formatCount } from '../../lib/count.js';
import { instantLabel } from '../../lib/instant.js';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { localDate } from '@plaingym/shared/time';
import type { BookingRosterEntry, BookingSessionCounts, ClassBooking, ClassSession, Member } from '@plaingym/shared/contracts';
import type { ExtensionViewProps } from '../../lib/registries.js';
import { useBootstrap } from '../../app/context.js';
import { ApiError } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Autocomplete } from '../../components/ui/autocomplete.js';
import { Button } from '../../components/ui/button.js';
import { Pager } from '../../components/ui/pager.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { CheckboxField, Select, Textarea } from '../../components/ui/select.js';
import { useDialogOperation } from '../../components/ui/dialog.js';
import { EmptyState, LoadingState } from '../../components/ui/states.js';
import { usePublishSessionCounts, useSessionChanged } from '../../lib/session-summary.js';
import { bookingClient, type BookingCancelNotice } from './client.js';

const REFETCH_MS = 45_000;
const text = (key: string, values?: Record<string, string | number>) => t('bookings/bookings:' + key, values);
const status = (booking: ClassBooking) => text(booking.status, { rank: formatCount(booking.queueRank ?? 0) });
const errorText = (error: unknown) => text(error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
const sessionLabel = (session: ClassSession, timezone: string) => `${session.name} · ${instantLabel(session.startsAt, timezone)}`;

export function BookingRosterPanel({ sessionId }: ExtensionViewProps) { return sessionId ? <Bookings key={sessionId} sessionId={sessionId}/> : null; }
export function MemberBookingsPanel({ memberId }: ExtensionViewProps) { return memberId ? <Bookings key={memberId} memberId={memberId}/> : null; }
function Bookings({ memberId, sessionId }: ExtensionViewProps) {
  const bootstrap = useBootstrap(), timezone = bootstrap.data?.gym?.timezone;
  const [reload, setReload] = useState(0), [offset, setOffset] = useState(0);
  // A quiet step back may fail. Keep the pager with the rows until its replacement arrives.
  const [shownOffset, setShownOffset] = useState(0);
  const [rows, setRows] = useState<{ key: string; name: string; booking: ClassBooking | null; checked?: boolean }[]>([]);
  const [total, setTotal] = useState(0), [counts, setCounts] = useState<BookingSessionCounts | null>(null), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState(''), [loadError, setLoadError] = useState(''), [notice, setNotice] = useState('');
  const changed = useSessionChanged();
  const [tick, setTick] = useState(0), [refreshing, setRefreshing] = useState(false), seenScope = useRef(''), quietStep = useRef(false), fullLoad = useRef(false);
  // An open dialog follows changes made elsewhere while the tab is visible.
  useEffect(() => {
    if (!sessionId) return;
    let lastBump = -Infinity;
    const bump = () => { if (!document.hidden && performance.now() - lastBump >= 1000) { lastBump = performance.now(); setTick(value => value + 1); } };
    const timer = setInterval(bump, REFETCH_MS);
    window.addEventListener('focus', bump);
    document.addEventListener('visibilitychange', bump);
    return () => { clearInterval(timer); window.removeEventListener('focus', bump); document.removeEventListener('visibilitychange', bump); };
  }, [sessionId]);
  useEffect(() => {
    if (!timezone) return;
    // A same-page roster reload keeps the last result on screen. A page change, a booking change, a Refresh with
    // nothing to keep and every member tab load start over, so a cancelled booking never stays actionable.
    const scope = [sessionId, memberId, offset].join('|');
    const quiet = !fullLoad.current && ((!!sessionId && seenScope.current === scope) || quietStep.current);
    quietStep.current = false; fullLoad.current = false; seenScope.current = scope;
    let active = true;
    if (!quiet) { setLoading(true); setActionError(''); setLoadError(''); setRows([]); }
    async function load() {
      if (sessionId) {
        const page = await bookingClient.roster(sessionId, offset);
        const rows = page.data.map((row: BookingRosterEntry) => {
          const id = row.booking?.memberId ?? row.attendance!.memberId;
          return { key: id, name: row.displayName, booking: row.booking, checked: !!row.attendance };
        });
        return { rows, total: page.pagination.total, counts: page.counts };
      }
      const page = await bookingClient.list(memberId!, offset);
      const sessions = await Promise.all([...new Set(page.data.map(row => row.sessionId))].map(id => bookingClient.session(id)));
      return { rows: page.data.map(booking => ({ key: booking.id, name: sessionLabel(sessions.find(row => row.id === booking.sessionId)!, timezone!), booking })), total: page.pagination.total, counts: null };
    }
    void load().then(value => { if (active) {
      if (offset > 0 && value.rows.length === 0 && value.total <= offset) {
        quietStep.current = quiet;
        setOffset(Math.max(0, Math.floor((value.total - 1) / 50) * 50));
        return;
      }
      setLoadError(''); setRows(value.rows); setTotal(value.total); setCounts(value.counts); setShownOffset(offset);
    } })
      .catch(error => { if (active) { setLoadError(errorText(error)); if (!quiet) setCounts(null); } }).finally(() => { if (active) { setLoading(false); setRefreshing(false); } });
    return () => { active = false; };
  }, [sessionId, memberId, timezone, offset, reload, changed, tick]);
  // The session roster asks first, in place of the roster (a session dialog keeps one dialog), with the notice
  // choices; the member profile tab cancels straight away. A refused confirmation stays open with its choices and
  // shows the action error; after Keep booking the roster shows it, as for any refused action.
  const [confirming, setConfirming] = useState<{ id: string; name: string } | null>(null);
  // Where focus goes when the confirmation closes: a kept booking's row button, or '' for the roster heading.
  const section = useRef<HTMLElement>(null), heading = useRef<HTMLHeadingElement>(null), returnTo = useRef<string | null>(null);
  async function cancel(id: string, notice?: BookingCancelNotice, confirmed = false) {
    if (saving) return; setSaving(true); setActionError(''); setNotice('');
    try {
      await bookingClient.cancel(id, notice);
      // The cancelled row leaves with the reload, so focus goes to the heading.
      if (confirmed) returnTo.current = '';
      setConfirming(null); setNotice(text('cancelledSaved')); fullLoad.current = true; setReload(value => value + 1);
    } catch (error) { setActionError(errorText(error)); } finally { setSaving(false); }
  }
  useEffect(() => {
    if (confirming || returnTo.current === null) return;
    const id = returnTo.current;
    returnTo.current = null;
    const target = id ? [...section.current?.querySelectorAll<HTMLElement>('[data-cancel-booking]') ?? []].find(element => element.dataset.cancelBooking === id) : undefined;
    (target ?? heading.current)?.focus();
  }, [confirming]);
  const busy = loading || saving, stale = !!loadError && (rows.length > 0 || counts !== null);
  const publishedCounts = useMemo(() => sessionId && counts ? { ...counts, stale } : null, [sessionId, counts, stale]);
  usePublishSessionCounts(publishedCounts);
  const roster = <section hidden={!!confirming} ref={section} className="min-w-0 space-y-4" aria-label={text(sessionId ? 'roster' : 'title')}>
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0">
      <h3 ref={heading} tabIndex={-1} className="text-lg font-semibold focus:outline-none">{text(sessionId ? 'roster' : 'title')}</h3>
      {sessionId && counts && <p className="text-sm text-muted-foreground" data-testid="roster-counts">{text('counts', {
        booked: formatCount(counts.booked), waitlisted: formatCount(counts.waitlisted), checkedIn: formatCount(counts.checkedIn) })}</p>}</div>
      <Button variant="outline" disabled={busy || refreshing} onClick={() => { fullLoad.current = rows.length === 0 && counts === null; setActionError(''); setRefreshing(true); setReload(value => value + 1); }}>{text('refresh')}</Button></div>
    {!confirming && actionError && <Alert variant="error" focusOnReveal>{actionError}</Alert>}
    {(loadError || bootstrap.isError) && <Alert variant="error">{loadError || text('error')}</Alert>}
    {stale && <p role="status" className="text-sm text-muted-foreground">{text('stale')}</p>}
    {notice && <p role="status">{notice}</p>}
    {(loading || bootstrap.isPending) && <LoadingState label={text('loading')}/>}
    {!loading && !loadError && rows.length === 0 && <EmptyState title={text(sessionId ? 'emptyRoster' : 'empty')}/>}
    <ul className="divide-y divide-border rounded-xl border border-border">{rows.map(row => <li key={row.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1"><p className="font-medium">{row.name}</p>
        <p className="text-sm">{row.booking ? status(row.booking) : text('walkIn')}</p>
        {row.checked !== undefined && <p className="text-sm text-muted-foreground">{text(row.checked ? 'checkedIn' : 'notCheckedIn')}</p>}</div>
      {row.booking && row.booking.status !== 'cancelled' && <Button variant="outline" className="shrink-0" disabled={busy} aria-label={text('cancelNamed', { name: row.name })}
        data-cancel-booking={row.booking.id}
        onClick={() => { if (sessionId) { setActionError(''); setNotice(''); setConfirming({ id: row.booking!.id, name: row.name }); } else void cancel(row.booking!.id); }}>{text('cancel')}</Button>}
    </li>)}</ul>
    <Pager offset={shownOffset} total={total} limit={50} disabled={busy} onChange={value => { fullLoad.current = true; setOffset(value); setReload(value => value + 1); }} previousLabel={text('previous')} nextLabel={text('next')}/>
    {timezone && <BookingForm {...(memberId ? { memberId } : {})} {...(sessionId ? { sessionId } : {})} timezone={timezone} disabled={busy}
      onSaved={booking => { setNotice(booking.status === 'waitlisted' ? text('waitlistSaved', { rank: formatCount(booking.queueRank!) }) : text('bookingSaved')); fullLoad.current = true; setOffset(0); setReload(value => value + 1); }}/ >}
  </section>;
  return <>
    {confirming && <CancelBookingForm name={confirming.name} busy={saving} error={actionError}
      onKeep={() => { if (!saving) { returnTo.current = confirming.id; setConfirming(null); } }}
      onConfirm={notice => void cancel(confirming.id, notice, true)}/>}
    {roster}
  </>;
}

/** Both notice boxes start unticked; with neither ticked, the member is not told. The note goes in the email only. */
function CancelBookingForm({ name, busy, error, onKeep, onConfirm }:
  { name: string; busy: boolean; error: string; onKeep(): void; onConfirm(notice?: BookingCancelNotice): void }) {
  const [email, setEmail] = useState(false), [sms, setSms] = useState(false), [note, setNote] = useState('');
  const noteId = useId(), titleId = useId(), bodyId = useId(), title = useRef<HTMLHeadingElement>(null);
  // A containing dialog stays open while the request runs; its own dismissal guards a ticked box or a typed note.
  useDialogOperation(busy);
  useEffect(() => { title.current?.focus(); }, []);
  function submit(event: FormEvent) {
    event.preventDefault();
    const channels: BookingCancelNotice['channels'] = [...(email ? ['email' as const] : []), ...(sms ? ['sms' as const] : [])];
    onConfirm(channels.length ? { channels, ...(email && note.trim() ? { note } : {}) } : undefined);
  }
  return <form aria-labelledby={titleId} aria-describedby={bodyId} className="min-w-0 space-y-3 rounded-xl border border-border p-4 sm:p-6" onSubmit={submit}>
    <h3 id={titleId} ref={title} tabIndex={-1} className="text-lg font-semibold focus:outline-none">{text('cancelDialogTitle')}</h3>
    <p id={bodyId} className="text-sm text-muted-foreground">{text('cancelDialogBody', { name })}</p>
    {error && <Alert variant="error" focusOnReveal>{error}</Alert>}
    <CheckboxField name="notifyEmail" checked={email} disabled={busy} onChange={event => setEmail(event.target.checked)} label={text('cancelNotifyEmail')}/>
    <CheckboxField name="notifyText" checked={sms} disabled={busy} onChange={event => setSms(event.target.checked)} label={text('cancelNotifySms')}/>
    {email && <div className="space-y-1"><Label htmlFor={noteId}>{text('cancelNote')}</Label>
      <Textarea id={noteId} name="note" maxLength={1_000} value={note} disabled={busy} onChange={event => setNote(event.target.value)}/></div>}
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button type="button" variant="outline" disabled={busy} onClick={onKeep}>{text('cancelKeep')}</Button>
      <Button type="submit" variant="outline" className="border-destructive text-destructive" disabled={busy}>{text('cancelConfirm')}</Button>
    </div>
  </form>;
}

function BookingForm({ memberId, sessionId, timezone, disabled, onSaved }: ExtensionViewProps & { timezone: string; disabled: boolean; onSaved(booking: ClassBooking): void }) {
  const id = useId(), [member, setMember] = useState(memberId ?? ''), [session, setSession] = useState(sessionId ?? '');
  const [query, setQuery] = useState(''), [lookup, setLookup] = useState<{ query: string; members: Member[]; failed?: string } | null>(null), [searching, setSearching] = useState(false);
  const lookupSeq = useRef(0), chosenLabel = useRef('');
  const [date, setDate] = useState(() => localDate(new Date(), timezone)), [sessions, setSessions] = useState<ClassSession[]>([]);
  const [allowWaitlist, setAllowWaitlist] = useState(true), [saving, setSaving] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const selected = sessions.find(row => row.id === session);
  const [now, setNow] = useState(Date.now);
  const waitlistOpen = !!selected && now <= Date.parse(selected.cancelBefore);
  useEffect(() => {
    if (memberId) return;
    const trimmed = query.trim(), seq = ++lookupSeq.current;
    // Choosing a suggestion writes the member's own label into the box. That is not a new search:
    // keep the last result and stay quiet until the text changes again.
    if (member && chosenLabel.current && trimmed === chosenLabel.current) { setSearching(false); return; }
    setLookup(null);
    if (trimmed.length < 2) { setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      void bookingClient.members(trimmed).then(rows => {
        if (seq !== lookupSeq.current) return;
        setLookup({ query: trimmed, members: rows });
      }).catch(error => {
        if (seq !== lookupSeq.current) return;
        setLookup({ query: trimmed, members: [], failed: errorText(error) });
      }).finally(() => { if (seq === lookupSeq.current) setSearching(false); });
    }, 250);
    return () => { clearTimeout(timer); if (lookupSeq.current === seq) lookupSeq.current++; };
  }, [query, member, memberId]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const current = Date.now(); setNow(current);
      const delay = selected ? Date.parse(selected.cancelBefore) - current + 1 : 0;
      // Long-lived forms and sleeping tabs still close at the first instant past the cutoff.
      if (delay > 0) timer = setTimeout(update, Math.min(delay, 86_400_000));
    };
    update(); window.addEventListener('focus', update);
    return () => { clearTimeout(timer); window.removeEventListener('focus', update); };
  }, [selected]);
  useEffect(() => {
    if (!sessionId && !date) return;
    let active = true; setLoading(true); if (!sessionId) setSession(''); setError(''); setSessions([]);
    const load = sessionId ? bookingClient.session(sessionId).then(row => [row]) : bookingClient.sessions(date, timezone);
    // A roster form keeps its session if the lookup fails: only the waitlist option, which needs the cutoff, goes.
    void load.then(rows => { if (active) setSessions(rows); })
      .catch(error => { if (active) setError(errorText(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [date, timezone, sessionId]);
  const busy = disabled || saving || loading;
  const trimmedQuery = query.trim();
  const currentLookup = lookup?.query === trimmedQuery ? lookup : null;
  const memberOptions = currentLookup ? currentLookup.members.map(row => ({ id: row.id, label: `${row.firstName} ${row.lastName}` })) : [];
  const chosenMemberQuery = !!member && chosenLabel.current !== '' && trimmedQuery === chosenLabel.current;
  const lookupPending = !chosenMemberQuery && (searching || (trimmedQuery.length >= 2 && !currentLookup));
  const noMemberMatches = !!currentLookup && !currentLookup.failed && currentLookup.members.length === 0;
  return <form className="min-w-0 space-y-4 rounded-xl border border-border p-4 sm:p-6" onSubmit={event => {
    event.preventDefault(); if (busy || !member || !session) return;
    setSaving(true); setError('');
    void bookingClient.book({ memberId: member, sessionId: session,
      allowWaitlist: allowWaitlist && !!selected && Date.now() <= Date.parse(selected.cancelBefore) }).then(onSaved)
      .catch(error => setError(errorText(error))).finally(() => setSaving(false));
  }}>
    <h4 className="font-semibold">{text(memberId ? 'book' : 'addMember')}</h4>
    {error && <Alert variant="error" focusOnReveal>{error}</Alert>}
    {!memberId && <>
      <Autocomplete label={text('member')} query={query} value={member} emptyLabel={null}
        onQueryChange={setQuery} onChange={id => {
          setMember(id);
          chosenLabel.current = id ? memberOptions.find(row => row.id === id)?.label ?? '' : '';
        }}
        options={memberOptions} loading={lookupPending} disabled={busy}/>
      {currentLookup?.failed && <Alert variant="error">{currentLookup.failed}</Alert>}
      {noMemberMatches && <p role="status">{text('noMembers')}</p>}
    </>}
    {!sessionId && <><div className="space-y-2"><Label htmlFor={id + '-date'}>{text('date')}</Label><Input id={id + '-date'} type="date" value={date} disabled={busy} onChange={event => setDate(event.target.value)}/></div>
      <div className="space-y-2"><Label htmlFor={id + '-session'}>{text('session')}</Label><Select id={id + '-session'} value={session} disabled={busy} onChange={event => setSession(event.target.value)}>
        <option value="">{text('chooseSession')}</option>{sessions.map(row => <option key={row.id} value={row.id}>{sessionLabel(row, timezone)}</option>)}
      </Select></div>{!loading && sessions.length === 0 && <p>{text('noSessions')}</p>}</>}
    {waitlistOpen && <label className="flex min-h-11 cursor-pointer items-center gap-3" htmlFor={id + '-waitlist'}><input id={id + '-waitlist'} type="checkbox" checked={allowWaitlist} disabled={busy} onChange={event => setAllowWaitlist(event.target.checked)}/><span>{text('allowWaitlist')}</span></label>}
    <Button type="submit" className="w-full sm:w-auto" disabled={busy || !member || !session}>{text('book')}</Button>
  </form>;
}
