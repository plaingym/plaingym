// SPDX-License-Identifier: AGPL-3.0-only
import { formatCount } from '../../lib/count.js';
import { useBootstrap } from '../../app/context.js';
import { timeLabel } from '../../lib/instant.js';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Attendance, AttendanceTotals, Member } from '@plaingym/shared/contracts';
import type { ExtensionViewProps } from '../../lib/registries.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Autocomplete } from '../../components/ui/autocomplete.js';
import { Button } from '../../components/ui/button.js';
import { Pager } from '../../components/ui/pager.js';
import { Dialog, useDialogOperation, useDialogSaved } from '../../components/ui/dialog.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import { Badge, TableContainer } from '../../components/ui/table.js';
import { EmptyState, LoadingState } from '../../components/ui/states.js';
import { useNotifySessionChanged, useSessionChanged, useSessionCounts } from '../../lib/session-summary.js';
import { attendanceClient } from './client.js';

const text = (key: string, values?: Record<string, string | number>) => t('attendance/attendance:' + key, values);
export function AttendanceRosterPanel({ sessionId }: ExtensionViewProps) {
  return sessionId ? <Roster key={sessionId} sessionId={sessionId}/> : null;
}
/** Suggestions for a walk-in check-in: eligible members not already listed on the current page, looked up after a short pause in typing. */
function WalkIn({ disabled, listedIds, onChoose }: { disabled: boolean; listedIds: ReadonlySet<string>; onChoose(member: { id: string; name: string }): Promise<'saved' | 'skipped' | 'failed'> }) {
  const [query, setQuery] = useState(''), [lookup, setLookup] = useState<{ query: string; members: Member[]; failed?: boolean } | null>(null);
  const [searching, setSearching] = useState(false), lookupSeq = useRef(0), listedIdsRef = useRef(listedIds);
  listedIdsRef.current = listedIds;
  // A failed walk-in searches again, so a member the server refused leaves the picker instead of staying listed.
  const [searchAgain, setSearchAgain] = useState(0);
  useEffect(() => {
    const trimmed = query.trim(), seq = ++lookupSeq.current;
    setLookup(null);
    if (trimmed.length < 2) { setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          let pageRows = await attendanceClient.members(trimmed);
          if (seq !== lookupSeq.current) return;
          const rows: Member[] = [], seen = new Set<string>();
          const append = (batch: Member[]) => {
            for (const member of batch) {
              if (!seen.has(member.id)) { seen.add(member.id); rows.push(member); }
            }
          };
          append(pageRows);
          for (let pages = 1, offset = 50;
            pageRows.length === 50 && rows.filter(member => !listedIdsRef.current.has(member.id)).length < 10 && pages < 4;
            pages++, offset += 50) {
            try {
              pageRows = await attendanceClient.members(trimmed, offset);
            } catch {
              break;
            }
            if (seq !== lookupSeq.current) return;
            append(pageRows);
          }
          if (seq !== lookupSeq.current) return;
          setLookup({ query: trimmed, members: rows });
        } catch {
          if (seq === lookupSeq.current) setLookup({ query: trimmed, members: [], failed: true });
        } finally {
          if (seq === lookupSeq.current) setSearching(false);
        }
      })();
    }, 250);
    return () => { clearTimeout(timer); if (lookupSeq.current === seq) lookupSeq.current++; };
  }, [query, searchAgain]);
  const trimmed = query.trim(), current = lookup?.query === trimmed ? lookup : null;
  const options = current
    ? current.members.filter(row => !listedIds.has(row.id)).map(row => ({ id: row.id, label: `${row.firstName} ${row.lastName}` }))
    : [];
  return <div className="space-y-2">
    <Autocomplete label={text('walkIn')} query={query} value="" options={options} disabled={disabled}
      loading={searching || (trimmed.length >= 2 && !current)} onQueryChange={setQuery} onChange={id => {
        const option = options.find(row => row.id === id);
        if (!option) return;
        void onChoose({ id: option.id, name: option.label }).then(outcome => {
          if (outcome === 'saved') setQuery('');
          else if (outcome === 'failed') { setLookup(null); setSearchAgain(value => value + 1); }
        });
      }}/>
    {current?.failed && <Alert variant="error">{text('walkInError')}</Alert>}
  </div>;
}
type RosterPage = Awaited<ReturnType<typeof attendanceClient.roster>>;
/** Who is on the page and in what state: each member with their booking's ID, status and place, and their check-in. */
const participants = (page: RosterPage) => JSON.stringify([page.pagination.total, page.counts, page.data.map(row => [
  row.booking?.memberId ?? row.attendance?.memberId, row.displayName, row.booking?.id, row.booking?.status, row.booking?.queueRank, row.attendance?.id])]);
const sameParticipants = (a: RosterPage, b: RosterPage) => participants(a) === participants(b);
/**
 * Feedback for the check-in this roster last recorded, tied to that attendance rather than to the member. `since` is the
 * number of roster reads started before it was recorded: only later reads say anything about it. `checkedIn` takes its
 * baseline from the first later read (`null` until then); `seen` is `pending` until that read arrives, `listed` while the
 * page shows the attendance, and `offPage` otherwise (triggering `verify` once the session checked-in count drops).
 */
type Recorded = { attendanceId: string; memberId: string; name: string; at: string; walkIn: boolean; needsCredits: boolean;
  since: number; checkedIn: number | null; seen: 'pending' | 'listed' | 'offPage'; verify: boolean };
/** What a successful read says about the recorded check-in; `null` once a read shows it was undone. */
function observe(recorded: Recorded | null, page: RosterPage, read: number, offset: number): Recorded | null {
  if (!recorded || read <= recorded.since) return recorded;
  const row = page.data.find(entry => (entry.booking?.memberId ?? entry.attendance?.memberId) === recorded.memberId);
  if (row) {
    if (row.attendance?.id === recorded.attendanceId)
      return recorded.seen === 'listed' && recorded.checkedIn === page.counts.checkedIn && !recorded.verify
        ? recorded
        : { ...recorded, seen: 'listed', checkedIn: page.counts.checkedIn, verify: false };
    return null;
  }
  if (offset === 0 && page.pagination.total <= 50) return null;
  if (recorded.checkedIn === null)
    return { ...recorded, seen: 'offPage', checkedIn: page.counts.checkedIn };
  if (page.counts.checkedIn < recorded.checkedIn)
    return { ...recorded, seen: 'offPage', checkedIn: page.counts.checkedIn, verify: true };
  return recorded.seen === 'offPage' && recorded.checkedIn === page.counts.checkedIn
    ? recorded
    : { ...recorded, seen: 'offPage', checkedIn: page.counts.checkedIn };
}
function Roster({ sessionId }: { sessionId: string }) {
  const notifyChanged = useNotifySessionChanged(), timezone = useBootstrap().data?.gym?.timezone;
  const markSaved = useDialogSaved(), walkInForm = useRef<HTMLFormElement>(null);
  const [offset, setOffset] = useState(0), [reload, setReload] = useState(0), [follow, setFollow] = useState(0);
  // Keep the page's offset alongside its rows so a page change hides the old rows until the new page arrives.
  const [shown, setShown] = useState<{ page: RosterPage; offset: number } | null>(null);
  // Booked members whose visit was optimistically undone stay non-checkable until a successful read confirms eligibility.
  const [unconfirmed, setUnconfirmed] = useState<Set<string>>(new Set());
  // The attendance IDs whose check-in was recorded here without spending a credit.
  const [needsCredits, setNeedsCredits] = useState<Set<string>>(new Set());
  const [undoing, setUndoing] = useState<{ attendance: Attendance; name: string } | null>(null);
  const [recorded, setRecorded] = useState<Recorded | null>(null), readsStarted = useRef(0);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false), [stale, setStale] = useState(false), [saveFailed, setSaveFailed] = useState(false);
  const savingRef = useRef(false);
  useDialogOperation(saving);
  // The page and reload a read last started for: same offset and reload is a quiet follow-up; changed offset is a page change.
  const started = useRef<{ offset: number; reload: number } | null>(null);
  // The page the rows on screen came from: a failed read of another page has no rows for that offset to keep.
  const shownOffset = useRef<number | null>(null);
  const loudPending = useRef(false);
  useEffect(() => {
    let active = true;
    const previous = started.current;
    const pageChange = previous !== null && previous.offset !== offset;
    let quiet = previous !== null && previous.offset === offset && previous.reload === reload;
    quiet = quiet && !loudPending.current;
    loudPending.current = !quiet;
    started.current = { offset, reload };
    // A refresh keeps the current rows on screen until the new page arrives; a quiet read leaves the actions enabled.
    if (!quiet) setLoading(true);
    const read = ++readsStarted.current;
    void attendanceClient.roster(sessionId, offset).then(page => {
      if (!active) return;
      loudPending.current = false;
      // A page emptied by an undo falls back to the last page that still has rows.
      if (page.data.length === 0 && offset > 0) setOffset(Math.max(0, Math.floor((page.pagination.total - 1) / 50) * 50));
      else {
        shownOffset.current = offset;
        setShown(current => current && current.offset === offset && sameParticipants(current.page, page) ? current : { page, offset });
        setUnconfirmed(previousUnconfirmed => previousUnconfirmed.size ? new Set() : previousUnconfirmed);
        setLoadFailed(false); setStale(false);
        setRecorded(current => observe(current, page, read, offset));
      }
    }).catch(() => {
      if (!active) return;
      loudPending.current = false;
      if (quiet && shownOffset.current === offset) { setStale(true); return; }
      // A failed page change keeps the previous pager and checked-in count while hiding rows via shownOffset/currentPage.
      if (pageChange || shownOffset.current !== offset) {
        shownOffset.current = null;
        // The rows kept for the pager belong to no offset now, so stepping back to their page doesn't show them again while it loads.
        setShown(current => current && current.offset !== -1 ? { ...current, offset: -1 } : current);
      }
      setStale(false); setLoadFailed(true);
    })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId, offset, reload, follow]);
  const verifyId = recorded?.verify ? recorded.attendanceId : null;
  const verifyMemberId = recorded?.verify ? recorded.memberId : null;
  useEffect(() => {
    if (!verifyId || !verifyMemberId) return;
    let active = true;
    void attendanceClient.visitExists(verifyId, verifyMemberId, sessionId).then(
      exists => {
        if (!active) return;
        setRecorded(current => current?.attendanceId !== verifyId ? current : exists ? { ...current, verify: false } : null);
      },
      () => {
        if (!active) return;
        setRecorded(current => current?.attendanceId !== verifyId ? current : { ...current, verify: false });
      },
    );
    return () => { active = false; };
  }, [verifyId, verifyMemberId, sessionId]);
  const refresh = () => setReload(value => value + 1);
  // Each successful read by the dialog's bookings panel publishes a new counts object: after a booking, a cancellation or a
  // promotion, on its 45-second, focus and visibility reloads, and after a check-in reported to the dialog. The roster
  // follows each other read with one quiet read of its own page and shows it when the page's participants changed, while
  // skipping the follow-up triggered by its own check-in or undo notification (for up to 10 seconds). Any failed or
  // cleared publish resets that skip so a failed bookings read never swallows the next real follow-up.
  const changed = useSessionChanged(), published = useSessionCounts();
  const seenChanged = useRef(changed), seenRead = useRef(published && !published.stale ? published : null);
  const ownNotify = useRef(false), skipFollowUntil = useRef(0);
  useEffect(() => {
    if (changed !== seenChanged.current) {
      seenChanged.current = changed;
      if (ownNotify.current) { ownNotify.current = false; skipFollowUntil.current = Date.now() + 10_000; }
    } else if (ownNotify.current) {
      ownNotify.current = false;
    }
  }, [changed, reload]);
  useEffect(() => {
    const bookingsRead = published && !published.stale ? published : null;
    if (bookingsRead === null || bookingsRead === seenRead.current) { skipFollowUntil.current = 0; return; }
    seenRead.current = bookingsRead;
    const skip = Date.now() < skipFollowUntil.current;
    skipFollowUntil.current = 0;
    if (skip) return;
    setFollow(value => value + 1);
  }, [published]);
  const roster = shown?.page ?? null, currentPage = shown?.offset === offset ? shown.page : null;
  const listedIds = useMemo(
    () => new Set(currentPage?.data.map(entry => entry.booking?.memberId ?? entry.attendance!.memberId) ?? []),
    [currentPage],
  );
  async function checkIn(member: { id: string; name: string }, walkIn = false): Promise<'saved' | 'skipped' | 'failed'> {
    if (saving || savingRef.current) return 'skipped';
    savingRef.current = true;
    setSaving(true); setSaveFailed(false); setRecorded(null);
    try {
      const attendance = await attendanceClient.record({ memberId: member.id, sessionId, programId: null });
      const credits = attendance.needsCredits === true;
      if (credits) setNeedsCredits(previous => new Set(previous).add(attendance.id));
      if (walkIn || credits) setRecorded({ attendanceId: attendance.id, memberId: member.id, name: member.name, at: attendance.occurredAt, walkIn,
        needsCredits: credits, since: readsStarted.current, checkedIn: null, seen: 'pending', verify: false });
      if (walkIn && walkInForm.current) markSaved(walkInForm.current);
      ownNotify.current = true;
      notifyChanged(); refresh();
      return 'saved';
    } catch { setSaveFailed(true); refresh(); return 'failed'; }
    finally { savingRef.current = false; setSaving(false); }
  }
  // A dismissed undo leaves no error behind on the roster.
  function closeUndo() { setUndoing(null); setSaveFailed(false); }
  async function undo() {
    if (saving || savingRef.current || !undoing) return;
    const attendance = undoing.attendance;
    savingRef.current = true;
    setSaving(true); setSaveFailed(false); setRecorded(null);
    try {
      await attendanceClient.undo(attendance.id);
      // Show the undone visit at once: a failed reload below keeps these rows, so the stale check-in and its action must go.
      if (shown?.page.data.some(entry => entry.attendance?.id === attendance.id && entry.booking !== null))
        setUnconfirmed(previous => new Set(previous).add(attendance.memberId));
      setShown(current => current && {
        ...current,
        page: {
          ...current.page,
          counts: { ...current.page.counts, checkedIn: Math.max(0, current.page.counts.checkedIn - 1) },
          pagination: { ...current.page.pagination, total: Math.max(0, current.page.pagination.total
            - (current.page.data.some(entry => entry.attendance?.id === attendance.id && entry.booking === null) ? 1 : 0)) },
          data: current.page.data.flatMap(entry => entry.attendance?.id !== attendance.id ? [entry]
            : entry.booking ? [{ ...entry, attendance: null }] : []),
        },
      });
      setNeedsCredits(previous => { const next = new Set(previous); next.delete(attendance.id); return next; });
      setUndoing(null); ownNotify.current = true; notifyChanged(); refresh();
    } catch { setSaveFailed(true); }
    finally { savingRef.current = false; setSaving(false); }
  }
  const busy = loading || saving;
  // A listed check-in from a roster row speaks for itself; a walk-in keeps its banner while the page lists it.
  const showConfirmation = recorded && (recorded.walkIn || recorded.seen !== 'listed') ? recorded : null;
  return <section className="space-y-4" aria-label={text('roster')}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-lg font-semibold">{text('roster')}</h3>
      {roster && <p className="text-sm text-muted-foreground" aria-live="polite">{text('checkedCount', { count: formatCount(roster.counts.checkedIn) })}</p>}
    </div>
    <div className="grid items-end gap-2 sm:grid-cols-[1fr_auto]">
      <form ref={walkInForm} onSubmit={event => event.preventDefault()}>
        <WalkIn disabled={busy} listedIds={listedIds} onChoose={member => checkIn(member, true)}/>
      </form>
      <Button type="button" variant="outline" disabled={busy} onClick={() => { setLoadFailed(false); setStale(false); setRecorded(null); refresh(); }}>{text('refresh')}</Button>
    </div>
    {showConfirmation && <div role="status" className="text-sm">
      <p>{showConfirmation.seen === 'offPage' ? text('checkInRecordedAt', { name: showConfirmation.name, time: timeLabel(showConfirmation.at, timezone) })
        : text('walkInRecorded', { name: showConfirmation.name })}</p>
      {showConfirmation.needsCredits && <p className="text-warning">{text('needsCredits')}</p>}
    </div>}
    {loadFailed && <Alert variant="error" focusOnReveal>{text('rosterLoadError')}</Alert>}
    {stale && !loadFailed && currentPage && <p role="status" className="text-sm text-muted-foreground">{text('stale')}</p>}
    {saveFailed && !undoing && <Alert variant="error" focusOnReveal>{text('error')}</Alert>}
    {loading && <LoadingState label={text('loading')}/>}
    {currentPage && currentPage.data.length > 0 && <ul className="divide-y divide-border rounded-xl border border-border">{currentPage.data.map((entry) => {
      const memberId = entry.booking?.memberId ?? entry.attendance!.memberId, name = entry.displayName, attendance = entry.attendance, done = !!attendance;
      const rank = entry.booking?.status === 'waitlisted' ? entry.booking.queueRank : null;
      return <li key={memberId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
        <div className="min-w-0 wrap-anywhere"><span className="font-medium">{name}</span>
          {rank !== null && <Badge className="ml-2">{text('waitlisted', { rank: formatCount(rank) })}</Badge>}
          {attendance && showConfirmation?.attendanceId !== attendance.id && needsCredits.has(attendance.id) &&<p role="status" className="text-sm text-warning">{text('needsCredits')}</p>}</div>
        <div className="flex flex-wrap items-center gap-2">
        <Button variant={done ? 'secondary' : 'default'} className={done ? 'shrink-0 bg-success/10 text-success disabled:opacity-100' : 'shrink-0'} disabled={busy || done || unconfirmed.has(memberId)}
          onClick={() => void checkIn({ id: memberId, name })} aria-label={text(done ? 'checkedNamed' : 'checkInNamed', { name })}>
          {done && <span aria-hidden="true">✓</span>}{text(done ? 'checked' : 'checkIn')}</Button>
        {attendance && attendance.source !== 'import' && <Button variant="outline" disabled={busy} onClick={() => { setSaveFailed(false); setUndoing({ attendance, name }); }}
          aria-label={text('undoNamed', { name })}>{text('undo')}</Button>}
        </div>
      </li>;
    })}</ul>}
    {currentPage?.data.length === 0 && <EmptyState title={text('noRoster')} description={text('noRosterHelp')}/>}
    {roster && <Pager offset={offset} total={roster.pagination.total} limit={50} onChange={setOffset} disabled={busy} previousLabel={text('previous')} nextLabel={text('next')}/>}
    {undoing && <Dialog title={text('undoTitle')} description={text('undoHelp', { name: undoing.name })}
      closeLabel={text('closeUndo')} onClose={closeUndo} dismissible={!saving}>
      {saveFailed && <Alert variant="error" focusOnReveal>{text('error')}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={saving} onClick={closeUndo}>{text('cancelUndo')}</Button>
        <Button disabled={saving} onClick={() => void undo()}>{text('confirmUndo')}</Button>
      </div>
    </Dialog>}
  </section>;
}

export function MemberAttendancePanel({ memberId }: ExtensionViewProps) {
  return memberId ? <MemberAttendance key={memberId} memberId={memberId}/> : null;
}
function Breakdown({ caption, heading, rows }: { caption: string; heading: string; rows: { id: string; name: string; count: number }[] }) {
  return <TableContainer label={caption} className="px-3"><table className="w-full text-left text-sm"><caption className="pb-2 text-left font-semibold">{caption}</caption>
    <thead className="sr-only sm:not-sr-only"><tr className="text-muted-foreground"><th scope="col" className="py-2 font-medium">{heading}</th><th scope="col" className="py-2 text-right font-medium">{text('count')}</th></tr></thead>
    <tbody className="divide-y divide-border border-y border-border">{rows.length ? rows.map((row) => <tr key={row.id}>
      <th scope="row" className="py-2 font-normal">{row.name}</th><td className="py-2 text-right tabular-nums">{formatCount(row.count)}</td>
    </tr>) : <tr><td colSpan={2} className="py-2 text-muted-foreground">{text('none')}</td></tr>}</tbody></table></TableContainer>;
}
function MemberAttendance({ memberId }: { memberId: string }) {
  const selectId = useId();
  const [totals, setTotals] = useState<AttendanceTotals | null>(null);
  const [labels, setLabels] = useState<Awaited<ReturnType<typeof attendanceClient.labels>> | null>(null);
  const [programId, setProgramId] = useState(''), [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(false), [recorded, setRecorded] = useState(false);
  const [needsCredits, setNeedsCredits] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false);
    void Promise.all([attendanceClient.totals(memberId), attendanceClient.labels()]).then(([counts, names]) => {
      if (active) { setTotals(counts); setLabels(names); }
    }).catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [memberId, reload]);
  async function openMat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError(false); setRecorded(false);
    try {
      const visit = await attendanceClient.record({ memberId, sessionId: null, programId: programId || null });
      setNeedsCredits(visit.needsCredits === true);
      setRecorded(true); setReload((value) => value + 1);
    } catch { setError(true); }
    finally { setSaving(false); }
  }
  return <section className="space-y-4" aria-label={text('title')}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-lg font-semibold">{text('title')}</h3>
      <Button variant="outline" disabled={loading || saving} onClick={() => setReload((value) => value + 1)}>{text('refresh')}</Button>
    </div>
    {error && <Alert variant="error" focusOnReveal>{text('error')}</Alert>}
    {loading && <LoadingState label={text('loading')}/>}
    <div className="grid items-start gap-6 lg:grid-cols-2">
      {totals && <div className="min-w-0 space-y-4">
        <ul className="grid grid-cols-3 gap-2 text-center">{([['total', totals.total], ['classes', totals.classes], ['openMatTotal', totals.openMat]] as const).map(([key, count]) =>
          <li key={key} className="rounded-xl border border-border p-3"><span className="sr-only">{text(key, { count: formatCount(count) })}</span>
            <span aria-hidden="true" className="block text-2xl font-semibold tabular-nums">{formatCount(count)}</span>
            <span aria-hidden="true" className="block text-xs text-muted-foreground">{text(key + 'Label')}</span></li>)}</ul>
        <Breakdown caption={text('byProgram')} heading={text('program')} rows={totals.byProgram.map((row) => ({ id: row.programId, count: row.count,
          name: labels?.programs.find((program) => program.id === row.programId)?.name ?? text('unknownProgram') }))}/>
        <Breakdown caption={text('byTag')} heading={text('tag')} rows={totals.byTag.map((row) => ({ id: row.tagId, count: row.count,
          name: labels?.tags.find((tag) => tag.id === row.tagId)?.name ?? text('unknownTag') }))}/>
      </div>}
      <form className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-6" onSubmit={(event) => void openMat(event)}>
        <h4 className="font-semibold">{text('openMat')}</h4>
        <p className="text-sm text-muted-foreground">{text('openMatHelp')}</p>
        <div className="grid gap-2"><Label htmlFor={selectId}>{text('program')}</Label>
          <Select id={selectId} value={programId} disabled={loading || saving} onChange={(event) => setProgramId(event.target.value)}>
            <option value="">{text('noProgram')}</option>
            {labels?.programs.filter((program) => program.active).map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
          </Select></div>
        <Button type="submit" className="w-full sm:w-auto" disabled={loading || saving || !labels}>{text('recordOpenMat')}</Button>
        {recorded && <p role="status" className="text-sm">{text('recorded')}</p>}
        {recorded && needsCredits && <p role="status" className="text-sm text-warning">{text('needsCredits')}</p>}
      </form>
    </div>
  </section>;
}
