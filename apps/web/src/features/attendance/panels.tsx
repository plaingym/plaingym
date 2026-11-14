// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { Attendance, AttendanceTotals, Member } from '@plaingym/shared/contracts';
import type { ExtensionViewProps } from '../../lib/registries.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, useDialogOperation } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select } from '../../components/ui/select.js';
import { TableContainer } from '../../components/ui/table.js';
import { EmptyState, LoadingState } from '../../components/ui/states.js';
import { useNotifySessionChanged } from '../../lib/session-summary.js';
import { attendanceClient } from './client.js';

const text = (key: string, values?: Record<string, string | number>) => t('attendance/attendance:' + key, values);
export function AttendanceRosterPanel({ sessionId }: ExtensionViewProps) {
  return sessionId ? <Roster key={sessionId} sessionId={sessionId}/> : null;
}
function Roster({ sessionId }: { sessionId: string }) {
  const inputId = useId(), notifyChanged = useNotifySessionChanged();
  const [search, setSearch] = useState(''), [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0), [reload, setReload] = useState(0);
  const [roster, setRoster] = useState<{ data: Member[]; total: number } | null>(null);
  const [checked, setChecked] = useState<Map<string, Attendance>>(new Map());
  const [needsCredits, setNeedsCredits] = useState<Set<string>>(new Set());
  const [undoing, setUndoing] = useState<{ attendance: Attendance; name: string } | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(false);
  useDialogOperation(saving);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false); setRoster(null);
    void Promise.all([attendanceClient.members(query, offset), attendanceClient.checkedIn(sessionId)])
      .then(([members, attendance]) => {
        if (active) { setRoster(members); setChecked(new Map(attendance.map((row) => [row.memberId, row]))); }
      }).catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId, query, offset, reload]);
  async function checkIn(memberId: string) {
    if (saving || checked.has(memberId)) return;
    setSaving(true); setError(false);
    try {
      const attendance = await attendanceClient.record({ memberId, sessionId, programId: null });
      setChecked((previous) => new Map(previous).set(memberId, attendance));
      setNeedsCredits(previous => { const next = new Set(previous); if (attendance.needsCredits) next.add(memberId); else next.delete(memberId); return next; });
      notifyChanged();
    } catch { setError(true); }
    finally { setSaving(false); }
  }
  // A dismissed undo leaves no error behind on the roster.
  function closeUndo() { setUndoing(null); setError(false); }
  async function undo() {
    if (saving || !undoing) return;
    setSaving(true); setError(false);
    try {
      await attendanceClient.undo(undoing.attendance.id);
      setChecked(previous => { const next = new Map(previous); next.delete(undoing.attendance.memberId); return next; });
      setNeedsCredits(previous => { const next = new Set(previous); next.delete(undoing.attendance.memberId); return next; });
      setUndoing(null); notifyChanged();
    } catch { setError(true); }
    finally { setSaving(false); }
  }
  const busy = loading || saving;
  return <section className="space-y-4" aria-label={text('roster')}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="text-lg font-semibold">{text('roster')}</h3>
      {roster && <p className="text-sm text-muted-foreground" aria-live="polite">{text('checkedCount', { count: checked.size })}</p>}
    </div>
    <form role="search" className="grid grid-cols-[1fr_auto] items-end gap-2 sm:flex" onSubmit={(event) => {
      event.preventDefault(); setQuery(search.trim()); setOffset(0); setReload((value) => value + 1);
    }}>
      <div className="col-span-2 grid gap-2 sm:flex-1"><Label htmlFor={inputId}>{text('search')}</Label>
        <Input id={inputId} type="search" value={search} onChange={(event) => setSearch(event.target.value)} disabled={busy}/></div>
      <Button type="submit" disabled={busy}>{text('searchButton')}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => setReload((value) => value + 1)}>{text('refresh')}</Button>
    </form>
    {error && !undoing && <Alert variant="error" focusOnReveal>{text('error')}</Alert>}
    {loading && <LoadingState label={text('loading')}/>}
    {roster && roster.data.length > 0 && <ul className="divide-y divide-border rounded-xl border border-border">{roster.data.map((member) => {
      const name = `${member.firstName} ${member.lastName}`, attendance = checked.get(member.id), done = !!attendance;
      return <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2">
        <div className="min-w-0 break-words"><span className="font-medium">{name}</span>
          {done && needsCredits.has(member.id) && <p role="status" className="text-sm text-warning">{text('needsCredits')}</p>}</div>
        <div className="flex flex-wrap items-center gap-2">
        <Button variant={done ? 'secondary' : 'default'} className={done ? 'shrink-0 bg-success/10 text-success disabled:opacity-100' : 'shrink-0'} disabled={busy || done} onClick={() => void checkIn(member.id)}
          aria-label={text(done ? 'checkedNamed' : 'checkInNamed', { name })}>
          {done && <span aria-hidden="true">✓</span>}{text(done ? 'checked' : 'checkIn')}</Button>
        {attendance && attendance.source !== 'import' && <Button variant="outline" disabled={busy} onClick={() => { setError(false); setUndoing({ attendance, name }); }}
          aria-label={text('undoNamed', { name })}>{text('undo')}</Button>}
        </div>
      </li>;
    })}</ul>}
    {roster?.data.length === 0 && <EmptyState title={text('noMembers')} description={query ? text('noMembersHelp') : undefined}/>}
    {roster && (offset > 0 || roster.total > 50) && <div className="flex justify-between gap-2">
      <Button variant="outline" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{text('previous')}</Button>
      <Button variant="outline" disabled={busy || offset + 50 >= roster.total} onClick={() => setOffset(offset + 50)}>{text('next')}</Button>
    </div>}
    {undoing && <Dialog title={text('undoTitle')} description={text('undoHelp', { name: undoing.name })}
      closeLabel={text('closeUndo')} onClose={closeUndo} dismissible={!saving}>
      {error && <Alert variant="error" focusOnReveal>{text('error')}</Alert>}
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
      <th scope="row" className="py-2 font-normal">{row.name}</th><td className="py-2 text-right tabular-nums">{row.count}</td>
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
          <li key={key} className="rounded-xl border border-border p-3"><span className="sr-only">{text(key, { count })}</span>
            <span aria-hidden="true" className="block text-2xl font-semibold tabular-nums">{count}</span>
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
