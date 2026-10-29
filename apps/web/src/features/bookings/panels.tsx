// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useState } from 'react';
import { localDate } from '@plaingym/shared/time';
import type { BookingRosterEntry, ClassBooking, ClassSession, Member } from '@plaingym/shared/contracts';
import type { ExtensionViewProps } from '../../lib/registries.js';
import { useBootstrap } from '../../app/context.js';
import { ApiError } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import { EmptyState, LoadingState } from '../../components/ui/states.js';
import { bookingClient } from './client.js';

const text = (key: string, values?: Record<string, string | number>) => t('bookings/bookings:' + key, values);
const status = (booking: ClassBooking) => text(booking.status, { rank: booking.queueRank ?? 0 });
const errorText = (error: unknown) => text(error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
const sessionLabel = (session: ClassSession, timezone: string) => `${session.name} · ${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(session.startsAt))}`;

export function BookingRosterPanel({ sessionId }: ExtensionViewProps) { return sessionId ? <Bookings key={sessionId} sessionId={sessionId}/> : null; }
export function MemberBookingsPanel({ memberId }: ExtensionViewProps) { return memberId ? <Bookings key={memberId} memberId={memberId}/> : null; }
function Bookings({ memberId, sessionId }: ExtensionViewProps) {
  const bootstrap = useBootstrap(), timezone = bootstrap.data?.gym?.timezone;
  const [reload, setReload] = useState(0), [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<{ key: string; name: string; booking: ClassBooking | null; checked?: boolean }[]>([]);
  const [total, setTotal] = useState(0), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    if (!timezone) return;
    let active = true; setLoading(true); setError(''); setRows([]);
    async function load() {
      if (sessionId) {
        const page = await bookingClient.roster(sessionId, offset);
        const rows = await Promise.all(page.data.map(async (row: BookingRosterEntry) => {
          const id = row.booking?.memberId ?? row.attendance!.memberId;
          const member = await bookingClient.member(id);
          return { key: id, name: `${member.firstName} ${member.lastName}`, booking: row.booking, checked: !!row.attendance };
        }));
        return { rows, total: page.pagination.total };
      }
      const page = await bookingClient.list(memberId!, offset);
      const sessions = await Promise.all([...new Set(page.data.map(row => row.sessionId))].map(id => bookingClient.session(id)));
      return { rows: page.data.map(booking => ({ key: booking.id, name: sessionLabel(sessions.find(row => row.id === booking.sessionId)!, timezone!), booking })), total: page.pagination.total };
    }
    void load().then(value => { if (active) { setRows(value.rows); setTotal(value.total); } })
      .catch(error => { if (active) setError(errorText(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId, memberId, timezone, offset, reload]);
  async function cancel(id: string) {
    if (saving) return; setSaving(true); setError(''); setNotice('');
    try { await bookingClient.cancel(id); setNotice(text('cancelledSaved')); setReload(value => value + 1); }
    catch (error) { setError(errorText(error)); } finally { setSaving(false); }
  }
  const busy = loading || saving;
  return <section className="min-w-0 space-y-4" aria-label={text(sessionId ? 'roster' : 'title')}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-lg font-semibold">{text(sessionId ? 'roster' : 'title')}</h3>
      <Button variant="outline" disabled={busy} onClick={() => setReload(value => value + 1)}>{text('refresh')}</Button></div>
    {(error || bootstrap.isError) && <Alert>{error || text('error')}</Alert>}
    {notice && <p role="status">{notice}</p>}
    {(loading || bootstrap.isPending) && <LoadingState label={text('loading')}/>}
    {!loading && !error && rows.length === 0 && <EmptyState title={text(sessionId ? 'emptyRoster' : 'empty')}/>}
    <ul className="divide-y divide-border rounded-xl border border-border">{rows.map(row => <li key={row.key} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1"><p className="break-words font-medium">{row.name}</p>
        <p className="text-sm">{row.booking ? status(row.booking) : text('walkIn')}</p>
        {row.checked !== undefined && <p className="text-sm text-muted-foreground">{text(row.checked ? 'checkedIn' : 'notCheckedIn')}</p>}</div>
      {row.booking && row.booking.status !== 'cancelled' && <Button variant="outline" className="shrink-0" disabled={busy} aria-label={text('cancelNamed', { name: row.name })} onClick={() => void cancel(row.booking!.id)}>{text('cancel')}</Button>}
    </li>)}</ul>
    {(offset > 0 || total > 50) && <div className="flex justify-between gap-2"><Button variant="outline" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{text('previous')}</Button>
      <Button variant="outline" disabled={busy || offset + 50 >= total} onClick={() => setOffset(offset + 50)}>{text('next')}</Button></div>}
    {timezone && <BookingForm {...(memberId ? { memberId } : {})} {...(sessionId ? { sessionId } : {})} timezone={timezone} disabled={busy}
      onSaved={booking => { setNotice(booking.status === 'waitlisted' ? text('waitlistSaved', { rank: booking.queueRank! }) : text('bookingSaved')); setOffset(0); setReload(value => value + 1); }}/ >}
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
    {error && <Alert>{error}</Alert>}
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
