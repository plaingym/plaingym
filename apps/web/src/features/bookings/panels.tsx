// SPDX-License-Identifier: AGPL-3.0-only
import { instantLabel } from '../../lib/instant.js';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { localDate } from '@plaingym/shared/time';
import type { BookingRosterEntry, BookingSessionCounts, ClassBooking, ClassSession, Member } from '@plaingym/shared/contracts';
import type { ExtensionViewProps } from '../../lib/registries.js';
import { useBootstrap } from '../../app/context.js';
import { ApiError } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Pager } from '../../components/ui/pager.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import { EmptyState, LoadingState } from '../../components/ui/states.js';
import { usePublishSessionCounts, useSessionChanged } from '../../lib/session-summary.js';
import { bookingClient } from './client.js';

const REFETCH_MS = 45_000;
const text = (key: string, values?: Record<string, string | number>) => t('bookings/bookings:' + key, values);
const status = (booking: ClassBooking) => text(booking.status, { rank: booking.queueRank ?? 0 });
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
  async function cancel(id: string) {
    if (saving) return; setSaving(true); setActionError(''); setNotice('');
    try { await bookingClient.cancel(id); setNotice(text('cancelledSaved')); fullLoad.current = true; setReload(value => value + 1); }
    catch (error) { setActionError(errorText(error)); } finally { setSaving(false); }
  }
  const busy = loading || saving, stale = !!loadError && (rows.length > 0 || counts !== null);
  const publishedCounts = useMemo(() => sessionId && counts ? { ...counts, stale } : null, [sessionId, counts, stale]);
  usePublishSessionCounts(publishedCounts);
  return <section className="min-w-0 space-y-4" aria-label={text(sessionId ? 'roster' : 'title')}>
    <div className="flex flex-wrap items-center justify-between gap-2"><div className="min-w-0">
      <h3 className="text-lg font-semibold">{text(sessionId ? 'roster' : 'title')}</h3>
      {sessionId && counts && <p className="text-sm text-muted-foreground" data-testid="roster-counts">{text('counts', counts)}</p>}</div>
      <Button variant="outline" disabled={busy || refreshing} onClick={() => { fullLoad.current = rows.length === 0 && counts === null; setActionError(''); setRefreshing(true); setReload(value => value + 1); }}>{text('refresh')}</Button></div>
    {actionError && <Alert variant="error" focusOnReveal>{actionError}</Alert>}
    {(loadError || bootstrap.isError) && <Alert variant="error">{loadError || text('error')}</Alert>}
    {stale && <p role="status" className="text-sm text-muted-foreground">{text('stale')}</p>}
    {notice && <p role="status">{notice}</p>}
    {(loading || bootstrap.isPending) && <LoadingState label={text('loading')}/>}
    {!loading && !loadError && rows.length === 0 && <EmptyState title={text(sessionId ? 'emptyRoster' : 'empty')}/>}
    <ul className="divide-y divide-border rounded-xl border border-border">{rows.map(row => <li key={row.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1"><p className="font-medium">{row.name}</p>
        <p className="text-sm">{row.booking ? status(row.booking) : text('walkIn')}</p>
        {row.checked !== undefined && <p className="text-sm text-muted-foreground">{text(row.checked ? 'checkedIn' : 'notCheckedIn')}</p>}</div>
      {row.booking && row.booking.status !== 'cancelled' && <Button variant="outline" className="shrink-0" disabled={busy} aria-label={text('cancelNamed', { name: row.name })} onClick={() => void cancel(row.booking!.id)}>{text('cancel')}</Button>}
    </li>)}</ul>
    <Pager offset={shownOffset} total={total} limit={50} disabled={busy} onChange={value => { fullLoad.current = true; setOffset(value); setReload(value => value + 1); }} previousLabel={text('previous')} nextLabel={text('next')}/>
    {timezone && <BookingForm {...(memberId ? { memberId } : {})} {...(sessionId ? { sessionId } : {})} timezone={timezone} disabled={busy}
      onSaved={booking => { setNotice(booking.status === 'waitlisted' ? text('waitlistSaved', { rank: booking.queueRank! }) : text('bookingSaved')); fullLoad.current = true; setOffset(0); setReload(value => value + 1); }}/ >}
  </section>;
}

function BookingForm({ memberId, sessionId, timezone, disabled, onSaved }: ExtensionViewProps & { timezone: string; disabled: boolean; onSaved(booking: ClassBooking): void }) {
  const id = useId(), [member, setMember] = useState(memberId ?? ''), [session, setSession] = useState(sessionId ?? '');
  const [search, setSearch] = useState(''), [matches, setMatches] = useState<Member[]>([]), [searched, setSearched] = useState(false);
  const [date, setDate] = useState(() => localDate(new Date(), timezone)), [sessions, setSessions] = useState<ClassSession[]>([]);
  const [allowWaitlist, setAllowWaitlist] = useState(true), [saving, setSaving] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (sessionId || !date) return;
    let active = true; setLoading(true); setSession(''); setError(''); setSessions([]);
    void bookingClient.sessions(date, timezone).then(rows => { if (active) setSessions(rows); })
      .catch(error => { if (active) setError(errorText(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [date, timezone, sessionId]);
  const busy = disabled || saving || loading;
  async function searchMembers() {
    setLoading(true); setError(''); setMember('');
    try { setMatches(await bookingClient.members(search.trim())); setSearched(true); }
    catch (error) { setError(errorText(error)); } finally { setLoading(false); }
  }
  return <form className="min-w-0 space-y-4 rounded-xl border border-border p-4 sm:p-6" onSubmit={event => {
    event.preventDefault(); if (busy || !member || !session) return;
    setSaving(true); setError('');
    void bookingClient.book({ memberId: member, sessionId: session, allowWaitlist }).then(onSaved)
      .catch(error => setError(errorText(error))).finally(() => setSaving(false));
  }}>
    <h4 className="font-semibold">{text(memberId ? 'book' : 'addMember')}</h4>
    {error && <Alert variant="error" focusOnReveal>{error}</Alert>}
    {!memberId && <>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end"><div className="min-w-0 space-y-2"><Label htmlFor={id + '-search'}>{text('search')}</Label>
        <Input id={id + '-search'} type="search" value={search} disabled={busy} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void searchMembers(); } }}/></div>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void searchMembers()}>{text('searchButton')}</Button></div>
      {searched && matches.length === 0 && <p role="status">{text('noMembers')}</p>}
      <div className="space-y-2"><Label htmlFor={id + '-member'}>{text('member')}</Label><Select id={id + '-member'} value={member} disabled={busy} onChange={event => setMember(event.target.value)}>
        <option value="">{text('chooseMember')}</option>{matches.map(row => <option key={row.id} value={row.id}>{row.firstName} {row.lastName}</option>)}
      </Select></div>
    </>}
    {!sessionId && <><div className="space-y-2"><Label htmlFor={id + '-date'}>{text('date')}</Label><Input id={id + '-date'} type="date" value={date} disabled={busy} onChange={event => setDate(event.target.value)}/></div>
      <div className="space-y-2"><Label htmlFor={id + '-session'}>{text('session')}</Label><Select id={id + '-session'} value={session} disabled={busy} onChange={event => setSession(event.target.value)}>
        <option value="">{text('chooseSession')}</option>{sessions.map(row => <option key={row.id} value={row.id}>{sessionLabel(row, timezone)}</option>)}
      </Select></div>{!loading && sessions.length === 0 && <p>{text('noSessions')}</p>}</>}
    <label className="flex min-h-11 cursor-pointer items-center gap-3" htmlFor={id + '-waitlist'}><input id={id + '-waitlist'} type="checkbox" checked={allowWaitlist} disabled={busy} onChange={event => setAllowWaitlist(event.target.checked)}/><span>{text('allowWaitlist')}</span></label>
    <Button type="submit" className="w-full sm:w-auto" disabled={busy || !member || !session}>{text('book')}</Button>
  </form>;
}
