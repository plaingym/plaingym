// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { AttendanceTotals, Member } from '@plaingym/shared/contracts';
import type { ExtensionViewProps } from '../../lib/registries.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { attendanceClient } from './client.js';

export function AttendanceRosterPanel({ sessionId }: ExtensionViewProps) {
  return sessionId ? <Roster key={sessionId} sessionId={sessionId}/> : null;
}
function Roster({ sessionId }: { sessionId: string }) {
  const inputId = useId();
  const [search, setSearch] = useState(''), [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0), [reload, setReload] = useState(0);
  const [roster, setRoster] = useState<{ data: Member[]; total: number } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(false); setRoster(null);
    void Promise.all([attendanceClient.members(query, offset), attendanceClient.checkedIn(sessionId)])
      .then(([members, attendance]) => {
        if (active) { setRoster(members); setChecked(new Set(attendance.map((row) => row.memberId))); }
      }).catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId, query, offset, reload]);
  async function checkIn(memberId: string) {
    if (saving || checked.has(memberId)) return;
    setSaving(true); setError(false);
    try {
      await attendanceClient.record({ memberId, sessionId, programId: null });
      setChecked((previous) => new Set([...previous, memberId]));
    } catch { setError(true); }
    finally { setSaving(false); }
  }
  const busy = loading || saving;
  return <section className="space-y-4" aria-label={t('attendance/attendance:roster')}>
    <h3 className="text-lg font-semibold">{t('attendance/attendance:roster')}</h3>
    <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
      event.preventDefault(); setQuery(search.trim()); setOffset(0); setReload((value) => value + 1);
    }}>
      <div className="space-y-2"><Label htmlFor={inputId}>{t('attendance/attendance:search')}</Label>
        <Input id={inputId} value={search} onChange={(event) => setSearch(event.target.value)} disabled={busy}/></div>
      <Button type="submit" disabled={busy}>{t('attendance/attendance:searchButton')}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => setReload((value) => value + 1)}>{t('attendance/attendance:refresh')}</Button>
    </form>
    {error && <Alert>{t('attendance/attendance:error')}</Alert>}
    {loading && <p role="status">{t('attendance/attendance:loading')}</p>}
    {roster && <ul className="divide-y">{roster.data.map((member) => <li key={member.id} className="flex items-center justify-between gap-3 py-3">
      <span>{member.firstName} {member.lastName}</span>
      <Button disabled={busy || checked.has(member.id)} onClick={() => void checkIn(member.id)}
        aria-label={t(checked.has(member.id) ? 'attendance/attendance:checkedNamed' : 'attendance/attendance:checkInNamed', { name: `${member.firstName} ${member.lastName}` })}>
        {t(checked.has(member.id) ? 'attendance/attendance:checked' : 'attendance/attendance:checkIn')}</Button>
    </li>)}</ul>}
    {roster?.data.length === 0 && <p>{t('attendance/attendance:noMembers')}</p>}
    <div className="flex gap-2">
      <Button variant="outline" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{t('attendance/attendance:previous')}</Button>
      <Button variant="outline" disabled={busy || !roster || offset + 50 >= roster.total} onClick={() => setOffset(offset + 50)}>{t('attendance/attendance:next')}</Button>
    </div>
  </section>;
}

export function MemberAttendancePanel({ memberId }: ExtensionViewProps) {
  return memberId ? <MemberAttendance key={memberId} memberId={memberId}/> : null;
}
function MemberAttendance({ memberId }: { memberId: string }) {
  const selectId = useId();
  const [totals, setTotals] = useState<AttendanceTotals | null>(null);
  const [labels, setLabels] = useState<Awaited<ReturnType<typeof attendanceClient.labels>> | null>(null);
  const [programId, setProgramId] = useState(''), [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(false), [recorded, setRecorded] = useState(false);
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
      await attendanceClient.record({ memberId, sessionId: null, programId: programId || null });
      setRecorded(true); setReload((value) => value + 1);
    } catch { setError(true); }
    finally { setSaving(false); }
  }
  return <section className="space-y-4" aria-label={t('attendance/attendance:title')}>
    <h3 className="text-lg font-semibold">{t('attendance/attendance:title')}</h3>
    {error && <Alert>{t('attendance/attendance:error')}</Alert>}
    {loading && <p role="status">{t('attendance/attendance:loading')}</p>}
    <Button variant="outline" disabled={loading || saving} onClick={() => setReload((value) => value + 1)}>{t('attendance/attendance:refresh')}</Button>
    {totals && <>
      <p>{t('attendance/attendance:total', { count: totals.total })}</p>
      <table className="w-full text-left"><caption className="text-left font-semibold">{t('attendance/attendance:byProgram')}</caption>
        <thead><tr><th scope="col">{t('attendance/attendance:program')}</th><th scope="col">{t('attendance/attendance:count')}</th></tr></thead>
        <tbody>{totals.byProgram.map((row) => <tr key={row.programId}>
          <th scope="row">{labels?.programs.find((program) => program.id === row.programId)?.name ?? t('attendance/attendance:unknownProgram')}</th><td>{row.count}</td>
        </tr>)}</tbody></table>
      <table className="w-full text-left"><caption className="text-left font-semibold">{t('attendance/attendance:byTag')}</caption>
        <thead><tr><th scope="col">{t('attendance/attendance:tag')}</th><th scope="col">{t('attendance/attendance:count')}</th></tr></thead>
        <tbody>{totals.byTag.map((row) => <tr key={row.tagId}>
          <th scope="row">{labels?.tags.find((tag) => tag.id === row.tagId)?.name ?? t('attendance/attendance:unknownTag')}</th><td>{row.count}</td>
        </tr>)}</tbody></table>
    </>}
    <form className="space-y-3" onSubmit={(event) => void openMat(event)}>
      <h4 className="font-semibold">{t('attendance/attendance:openMat')}</h4>
      <p>{t('attendance/attendance:openMatHelp')}</p>
      <Label htmlFor={selectId}>{t('attendance/attendance:program')}</Label>
      <select id={selectId} className="block rounded-md border p-2" value={programId} disabled={loading || saving}
        onChange={(event) => setProgramId(event.target.value)}>
        <option value="">{t('attendance/attendance:noProgram')}</option>
        {labels?.programs.filter((program) => program.active).map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
      </select>
      <Button type="submit" disabled={loading || saving || !labels}>{t('attendance/attendance:recordOpenMat')}</Button>
      {recorded && <p role="status">{t('attendance/attendance:recorded')}</p>}
    </form>
  </section>;
}
