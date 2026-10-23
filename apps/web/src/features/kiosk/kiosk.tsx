// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { KioskCheckinResult, KioskMemberIdentity, KioskSessionChoice } from '@plaingym/shared/contracts';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { forgetToken, kioskApi, KioskAuthError, readToken, saveToken } from './api.js';
import { playTone } from './feedback.js';

const text = (key: string, values?: Record<string, string | number>) => t('kiosk/kiosk:' + key, values);
/** Results stay on screen briefly; an unfinished selection resets after inactivity so the next member starts clean. */
const doneResetMs = 8_000, idleResetMs = 60_000;
type Row = { member: KioskMemberIdentity; result: KioskCheckinResult | undefined };
type Screen =
  | { kind: 'search'; message?: 'not_found' | 'error' }
  | { kind: 'select'; name: string; pin: string; members: KioskMemberIdentity[]; chosen: Set<string> }
  | { kind: 'results'; name: string; pin: string; members: KioskMemberIdentity[]; rows: Row[] };
const settled = (rows: readonly Row[]) => rows.every((row) => row.result && row.result.status !== 'select_session');
const big = 'min-h-16 text-xl';

export function KioskApp() {
  const [token, setToken] = useState<string | null>(() => readToken());
  if (!token) return <DeviceSetup onSaved={(value) => { saveToken(value); setToken(value); }}/>;
  return <CheckIn token={token} onUnauthorized={() => { forgetToken(); setToken(null); }}/>;
}

function DeviceSetup({ onSaved }: { onSaved: (token: string) => void }) {
  const [value, setValue] = useState('');
  return <main id="main-content" className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 p-6">
    <h1 className="text-3xl font-semibold">{text('setupTitle')}</h1><p className="text-lg">{text('setupHelp')}</p>
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSaved(value.trim()); }}>
      <Label className="grid gap-2 text-lg">{text('token')}<Input value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" required/></Label>
      <Button type="submit" className={big + ' w-full'}>{text('saveToken')}</Button>
    </form>
  </main>;
}

function CheckIn({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [screen, setScreen] = useState<Screen>({ kind: 'search' });
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState(0);
  const generation = useRef(0), pending = useRef(false);
  const reset = useCallback(() => { generation.current++; setScreen({ kind: 'search' }); }, []);
  useEffect(() => {
    const timer = setTimeout(reset, screen.kind === 'results' && settled(screen.rows) ? doneResetMs : idleResetMs);
    return () => clearTimeout(timer);
  }, [screen, activity, reset]);
  useEffect(() => () => { generation.current++; }, []);
  async function guard(work: (current: () => boolean) => Promise<void>) {
    // Lock synchronously: two quick taps must never submit two open-mat visits.
    if (pending.current) return;
    pending.current = true;
    const started = generation.current;
    const current = () => generation.current === started;
    setBusy(true);
    try { await work(current); }
    catch (error) {
      if (!current()) return;
      if (error instanceof KioskAuthError) onUnauthorized();
      else { playTone('attention'); setScreen({ kind: 'search', message: 'error' }); }
    } finally { pending.current = false; setBusy(false); }
  }
  function announce(results: readonly KioskCheckinResult[]) {
    if (results.some((result) => result.status === 'see_front_desk')) playTone('attention');
    else if (results.every((result) => result.status === 'checked_in' || result.status === 'already_checked_in')) playTone('success');
  }
  const search = (name: string, pin: string) => void guard(async (current) => {
    const found = await kioskApi.lookup(token, name, pin);
    if (!current()) return;
    if (found.status === 'see_front_desk') { playTone('attention'); setScreen({ kind: 'search', message: 'not_found' }); return; }
    setScreen({ kind: 'select', name, pin, members: found.members, chosen: new Set(found.members.map((member) => member.id)) });
  });
  const submit = (selection: Extract<Screen, { kind: 'select' }>) => void guard(async (current) => {
    const { name, pin, members: roster, chosen } = selection;
    const members = roster.filter((member) => chosen.has(member.id));
    const results = await kioskApi.checkin(token, { name, pin, checkins: members.map((member) => ({ memberId: member.id })) });
    if (!current()) return;
    announce(results);
    setScreen({ kind: 'results', name, pin, members: roster, rows: members.map((member, index) => ({ member, result: results[index] })) });
  });
  /** One member's choice from the session picker; `null` is open mat. */
  const choose = (screen: Extract<Screen, { kind: 'results' }>, memberId: string, sessionId: string | null) => void guard(async (current) => {
    const [result] = await kioskApi.checkin(token, { name: screen.name, pin: screen.pin, checkins: [{ memberId, sessionId }] });
    if (!current()) return;
    if (result) announce([result]);
    setScreen({ ...screen, rows: screen.rows.map((row) => row.member.id === memberId ? { ...row, result } : row) });
  });

  return <main id="main-content" className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6" aria-busy={busy}
    onPointerDown={() => setActivity((value) => value + 1)} onKeyDown={() => setActivity((value) => value + 1)}>
    <div className="flex items-center justify-between gap-4"><h1 className="text-3xl font-semibold">{text('title')}</h1>
      <Button variant="outline" onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}>{text('fullscreen')}</Button></div>
    {screen.kind === 'search' && <Search key={generation.current} busy={busy} message={screen.message} onSearch={search}/>}
    {screen.kind === 'select' && <Select screen={screen} busy={busy} onChange={setScreen} onSubmit={() => submit(screen)} onCancel={reset}/>}
    {screen.kind === 'results' && <Results screen={screen} busy={busy} onChoose={(memberId, sessionId) => choose(screen, memberId, sessionId)} onDone={reset}
      onMembers={() => setScreen({ kind: 'select', name: screen.name, pin: screen.pin, members: screen.members,
        chosen: new Set(screen.members.filter((member) => !screen.rows.some((row) => row.member.id === member.id &&
          (row.result?.status === 'checked_in' || row.result?.status === 'already_checked_in'))).map((member) => member.id)) })}/>}
  </main>;
}

function Search({ busy, message, onSearch }: { busy: boolean; message?: 'not_found' | 'error' | undefined; onSearch: (name: string, pin: string) => void }) {
  const [name, setName] = useState(''), [pin, setPin] = useState('');
  const press = (digit: string) => setPin((value) => value.length < 8 ? value + digit : value);
  function submit(event: FormEvent) { event.preventDefault(); if (name.trim() && pin.length >= 4 && !busy) { onSearch(name.trim(), pin); setPin(''); } }
  return <form className="space-y-6" onSubmit={submit}>
    {message && <Alert role="status">{text(message === 'error' ? 'error' : 'notFound')}</Alert>}
    <Label className="grid gap-2 text-xl">{text('name')}<Input className="h-16 text-2xl" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" autoCapitalize="words" required/></Label>
    <div className="space-y-3"><Label className="grid gap-2 text-xl">{text('pin')}
      <Input type="password" inputMode="numeric" autoComplete="off" maxLength={8} pattern="[0-9]{4,8}" required
        className="h-14 text-center text-3xl tracking-[0.5em]" value={pin} onChange={(event) => setPin(event.target.value.replace(/[^0-9]/g, '').slice(0, 8))}/></Label>
      <div className="grid grid-cols-3 gap-3">{['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => <Button key={digit} type="button" variant="outline" className={big} onClick={() => press(digit)}>{digit}</Button>)}
        <Button type="button" variant="outline" className={big} onClick={() => setPin('')}>{text('clear')}</Button>
        <Button type="button" variant="outline" className={big} onClick={() => press('0')}>0</Button>
        <Button type="button" variant="outline" className={big} aria-label={text('backspace')} onClick={() => setPin((value) => value.slice(0, -1))}>⌫</Button></div></div>
    <Button type="submit" className={big + ' w-full'} disabled={busy || !name.trim() || pin.length < 4}>{text('find')}</Button>
  </form>;
}

function Person({ member }: { member: KioskMemberIdentity }) {
  return <span className="flex items-center gap-4">{member.photoUrl
    ? <img src={member.photoUrl} alt="" className="h-16 w-16 rounded-full object-cover"/>
    : <span aria-hidden className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-2xl">{member.firstName.slice(0, 1)}</span>}
    <span className="text-2xl">{text('person', { first: member.firstName, initial: member.lastInitial })}</span></span>;
}

function Select({ screen, busy, onChange, onSubmit, onCancel }: { screen: Extract<Screen, { kind: 'select' }>; busy: boolean;
  onChange: (screen: Screen) => void; onSubmit: () => void; onCancel: () => void }) {
  const toggle = (id: string) => {
    const chosen = new Set(screen.chosen); if (!chosen.delete(id)) chosen.add(id);
    onChange({ ...screen, chosen });
  };
  return <section className="space-y-4" aria-labelledby="kiosk-select"><h2 id="kiosk-select" className="text-2xl">{text('whoIsHere')}</h2>
    <ul className="space-y-3">{screen.members.map((member) => <li key={member.id}>
      <button type="button" role="checkbox" aria-checked={screen.chosen.has(member.id)} disabled={busy} onClick={() => toggle(member.id)}
        className={'flex w-full items-center justify-between rounded-xl border-2 p-4 text-left ' + (screen.chosen.has(member.id) ? 'border-primary bg-primary/10' : 'border-border')}>
        <Person member={member}/><span className="text-xl">{screen.chosen.has(member.id) ? '✓' : ''}</span></button></li>)}</ul>
    <div className="grid grid-cols-2 gap-3"><Button variant="outline" className={big} onClick={onCancel}>{text('cancel')}</Button>
      <Button className={big} disabled={busy || !screen.chosen.size} onClick={onSubmit}>{text('checkIn')}</Button></div>
  </section>;
}

function Results({ screen, busy, onChoose, onDone, onMembers }: { screen: Extract<Screen, { kind: 'results' }>; busy: boolean;
  onChoose: (memberId: string, sessionId: string | null) => void; onDone: () => void; onMembers: () => void }) {
  const time = (session: KioskSessionChoice) => new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(session.startsAt));
  return <section className="space-y-4" aria-live="polite">
    <ul className="space-y-3">{screen.rows.map(({ member, result }) => <li key={member.id} className={'space-y-3 rounded-xl border-2 p-4 '
      + (result?.status === 'checked_in' || result?.status === 'already_checked_in' ? 'border-green-600 bg-green-600/10' : 'border-border')}>
      <div className="flex items-center justify-between gap-4"><Person member={member}/>
        <span className="text-xl font-medium">{text(!result ? 'error' : result.status === 'select_session' ? 'chooseClass' : result.status)}</span></div>
      {result?.status === 'select_session' && <div className="grid gap-3 sm:grid-cols-2">
        {result.sessions.map((session) => <Button key={session.id} className={big} disabled={busy} onClick={() => onChoose(member.id, session.id)}>{text('session', { name: session.name, time: time(session) })}</Button>)}
        <Button variant="outline" className={big} disabled={busy} onClick={() => onChoose(member.id, null)}>{text('openMat')}</Button></div>}
    </li>)}</ul>
    <div className="grid gap-3 sm:grid-cols-2"><Button variant="outline" className={big} disabled={busy} onClick={onMembers}>{text('changeMembers')}</Button>
      <Button variant="outline" className={big} onClick={onDone}>{text('done')}</Button></div>
  </section>;
}
