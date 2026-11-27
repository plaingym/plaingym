// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { KioskCheckinResult, KioskMemberIdentity } from '@plaingym/shared/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useGymTime } from '../../lib/instant.js';
import { useBootstrap, useShellServices } from '../../app/context.js';
import { isStaleVersion, subscribeToStaleVersion } from '../../app/version.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button, nameWrapClass, nameWrapMarker } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { forgetToken, kioskApi, KioskAuthError, readToken, saveToken, tokenKey } from './api.js';
import { QrCheckin } from './qr.js';
import { playTone } from './feedback.js';
import { DemoKioskHint, useDemoDiscoveryStatus, useDemoMode } from '../demo/notice.js';

const text = (key: string, values?: Record<string, string | number>) => t('kiosk/kiosk:' + key, values);
/** Results stay on screen briefly; an unfinished selection resets after inactivity so the next member starts clean. */
const doneResetMs = 8_000, idleResetMs = 60_000;
type Row = { member: KioskMemberIdentity; result: KioskCheckinResult | undefined };
type Screen =
  | { kind: 'search'; message?: 'not_found' | 'error' }
  | { kind: 'select'; name: string; pin: string; members: KioskMemberIdentity[]; chosen: Set<string> }
  | { kind: 'results'; name: string; pin: string; members: KioskMemberIdentity[]; rows: Row[] };
const settled = (rows: readonly Row[]) => rows.every((row) => row.result && row.result.status !== 'select_session');
const big = 'min-h-12 h-auto whitespace-normal px-3 py-3 text-lg sm:min-h-16 sm:text-xl';

function readDevice() {
  let saveFailed = false;
  const token = readToken(() => { saveFailed = true; });
  return { token, saveFailed };
}

export function KioskApp() {
  const [device, setDevice] = useState(readDevice);
  const { token, saveFailed } = device;
  useEffect(() => {
    const updateToken = () => {
      if (new URLSearchParams(window.location.hash.slice(1)).has('token')) {
        setDevice(readDevice());
      }
    };
    const syncToken = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === tokenKey || event.key === null)) {
        setDevice((previous) => {
          const next = readDevice();
          return next.token === previous.token ? previous : next;
        });
      }
    };
    window.addEventListener('hashchange', updateToken);
    window.addEventListener('storage', syncToken);
    return () => {
      window.removeEventListener('hashchange', updateToken);
      window.removeEventListener('storage', syncToken);
    };
  }, []);
  // A staff or member sign-in left in this browser would open the admin or portal to anyone at the kiosk. A demo visitor
  // is signed in by design, and until a demo answer is read the kiosk stays as it is.
  const session = useBootstrap().data?.session;
  const demo = useDemoMode(), demoStatus = useDemoDiscoveryStatus();
  // The demo answer is read again from time to time, and a failed read has none: the last one read still applies.
  const [notDemo, setNotDemo] = useState(false);
  const answersNotDemo = demo === undefined || demo === 'disabled';
  if (demoStatus === 'ready' && notDemo !== answersNotDemo) setNotDemo(answersNotDemo);
  if (session && notDemo) return <SignedInNotice/>;
  if (!token) return <DeviceSetup saveFailed={saveFailed} onSaved={(value) => {
    const saved = saveToken(value);
    setDevice({ token: saved ? value : null, saveFailed: !saved });
  }}/>;
  return <CheckIn key={token} token={token} onUnauthorized={() => { forgetToken(token); setDevice(readDevice()); }}/>;
}

function DeviceSetup({ saveFailed, onSaved }: { saveFailed: boolean; onSaved: (token: string) => void }) {
  const [value, setValue] = useState('');
  return <main id="main-content" className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-4 p-4 sm:gap-6 sm:p-6">
    <h1 className="text-2xl font-semibold sm:text-3xl">{text('setupTitle')}</h1><p className="text-base sm:text-lg">{text('setupHelp')}</p>
    {saveFailed && <Alert variant="error" focusOnReveal role="alert">{text('setupSaveError')}</Alert>}
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (value.trim()) onSaved(value.trim()); }}>
      <Label className="grid gap-2 text-lg">{text('token')}<Input type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="new-password" required/></Label>
      <Button type="submit" className={big + ' w-full'}>{text('saveToken')}</Button>
    </form>
  </main>;
}

function SignedInNotice() {
  const services = useShellServices(), cache = useQueryClient();
  const [state, setState] = useState<'idle' | 'sending' | 'failed'>('idle');
  async function signOut() {
    setState('sending');
    try {
      await services.signOut();
      await cache.cancelQueries();
      cache.clear();
      window.location.assign('/kiosk');
    } catch { setState('failed'); }
  }
  return <main id="main-content" className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-4 p-4 sm:gap-6 sm:p-6">
    <h1 className="text-2xl font-semibold sm:text-3xl">{text('signedInTitle')}</h1><p className="text-base sm:text-lg">{text('signedInHelp')}</p>
    {state === 'failed' && <Alert variant="error" focusOnReveal>{text('signOutFailed')}</Alert>}
    <Button className={big + ' w-full'} disabled={state === 'sending'} onClick={() => void signOut()}>{text('signOut')}</Button>
  </main>;
}

function CheckIn({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const stale = useSyncExternalStore(subscribeToStaleVersion, isStaleVersion);
  // Load the gym's timezone before the first class list, so its times never show in the fallback zone.
  useBootstrap();
  const root = useRef<HTMLElement>(null);
  const [screen, setScreen] = useState<Screen>({ kind: 'search' });
  const [flow, setFlow] = useState<'choose' | 'qr' | 'pin'>('choose');
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState(0);
  const [qrDone, setQrDone] = useState(false);
  const [focusCheck, setFocusCheck] = useState(0);
  // Replacing a step or a session choice can remove the focused control.
  // Keep focus in the current step, but preserve focus on controls still present.
  // Choosing members removes no control, so only a new member list counts as a change there. Safari leaves focus on
  // the body after a tap, and focusing the heading again would scroll a long list back to the top.
  const focusKey = screen.kind === 'select' ? screen.members : screen;
  useEffect(() => {
    if (document.activeElement === document.body) root.current?.querySelector<HTMLElement>('[data-kiosk-focus]')?.focus();
  }, [flow, focusKey, focusCheck]);
  const qrProgress = useCallback((result?: KioskCheckinResult) => {
    setQrDone(!!result && result.status !== 'select_session');
    setActivity((value) => value + 1);
    setFocusCheck((value) => value + 1);
  }, []);
  const openNamePin = useCallback(() => setFlow('pin'), []);
  const generation = useRef(0), pending = useRef(false);
  const reset = useCallback(() => { generation.current++; setFlow('choose'); setQrDone(false); setScreen({ kind: 'search' }); }, []);
  useEffect(() => {
    const done = flow === 'qr' ? qrDone : screen.kind === 'results' && settled(screen.rows);
    const timer = setTimeout(reset, done ? doneResetMs : idleResetMs);
    return () => clearTimeout(timer);
  }, [screen, flow, qrDone, activity, reset]);
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

  return <main ref={root} id="main-content" className="mx-auto flex w-full max-w-3xl min-w-0 flex-1 flex-col gap-4 p-4 sm:gap-6 sm:p-6" aria-busy={busy}
    onPointerDown={() => setActivity((value) => value + 1)} onKeyDown={() => setActivity((value) => value + 1)}>
    <div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold sm:text-3xl [@media(max-height:500px)]:text-xl">{text('title')}</h1>
      <Button variant="outline" onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}>{text('fullscreen')}</Button></div>
    {stale && <Alert variant="info" role="status">{text('staleVersion')}</Alert>}
    {screen.kind === 'search' && flow === 'choose' && <Choose onQr={() => setFlow('qr')} onPin={openNamePin}/>}
    {screen.kind === 'search' && flow === 'qr' && <QrCheckin token={token} onUnauthorized={onUnauthorized} onClose={reset} onNamePin={openNamePin} onProgress={qrProgress}/>}
    {screen.kind === 'search' && flow === 'pin' && <><DemoKioskHint /><Search key={generation.current} busy={busy} message={screen.message} onSearch={search}/>
      <Button variant="outline" className={big + ' w-full'} onClick={reset}>{text('cancel')}</Button></>}
    {screen.kind === 'select' && <Select screen={screen} busy={busy} onChange={setScreen} onSubmit={() => submit(screen)} onCancel={reset}/>}
    {screen.kind === 'results' && <Results screen={screen} busy={busy} onChoose={(memberId, sessionId) => choose(screen, memberId, sessionId)} onDone={reset}
      onMembers={() => setScreen({ kind: 'select', name: screen.name, pin: screen.pin, members: screen.members,
        chosen: new Set(screen.members.filter((member) => !screen.rows.some((row) => row.member.id === member.id &&
          (row.result?.status === 'checked_in' || row.result?.status === 'already_checked_in'))).map((member) => member.id)) })}/>}
  </main>;
}

function Choose({ onQr, onPin }: { onQr: () => void; onPin: () => void }) {
  return <section className="grid gap-4 sm:grid-cols-2 sm:gap-6" aria-labelledby="kiosk-choose"><h2 id="kiosk-choose" tabIndex={-1} data-kiosk-focus className="text-2xl sm:col-span-2">{text('howCheckIn')}</h2>
    <Button className={big + ' min-h-24 sm:min-h-32'} onClick={onQr}>{text('scanQr')}</Button>
    <Button className={big + ' min-h-24 sm:min-h-32'} onClick={onPin}>{text('namePin')}</Button>
  </section>;
}

function Search({ busy, message, onSearch }: { busy: boolean; message?: 'not_found' | 'error' | undefined; onSearch: (name: string, pin: string) => void }) {
  const [name, setName] = useState(''), [pin, setPin] = useState('');
  const press = (digit: string) => setPin((value) => value.length < 8 ? value + digit : value);
  const nameRef = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const scale = useRef(window.visualViewport?.scale);
  const height = useRef(window.visualViewport?.height);
  // A landscape phone's keyboard covers most of the screen, so bring the focused name field, and any note above it,
  // into view when the screen is short and they aren't already fully visible. When the note and field don't both fit,
  // the field wins.
  const scrollName = useCallback(() => {
    const viewport = window.visualViewport, field = nameRef.current;
    // Zoom shrinks the visual viewport, so a screen is short by its height times its zoom.
    if (!viewport || !field || viewport.height * viewport.scale > 500) return;
    const box = field.getBoundingClientRect(), noteTop = message && form.current ? form.current.getBoundingClientRect().top : box.top;
    const fits = box.bottom - noteTop <= viewport.height, top = fits ? noteTop : box.top;
    if (top >= viewport.offsetTop && box.bottom <= viewport.offsetTop + viewport.height) return;
    if (message && form.current && fits) form.current.scrollIntoView?.({ block: 'start' });
    else field.scrollIntoView?.({ block: 'center' });
  }, [message]);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resized = () => {
      // Only a drop larger than a toolbar's means a keyboard opened; a toolbar's resize doesn't scroll.
      // The drop is measured in screen pixels, since zoom shrinks the visual viewport's change.
      const dropped = ((height.current ?? viewport.height) - viewport.height) * viewport.scale > 120;
      height.current = viewport.height;
      // A pinch zoom resizes the visual viewport too; scrolling then would fight the gesture.
      if (viewport.scale !== scale.current) { scale.current = viewport.scale; return; }
      if (dropped && document.activeElement === nameRef.current) scrollName();
    };
    viewport.addEventListener('resize', resized);
    return () => viewport.removeEventListener('resize', resized);
  }, [scrollName]);
  // A search sent with Enter keeps the focus and the keyboard, so no focus or resize event shows the note.
  useEffect(() => { if (message && document.activeElement === nameRef.current) scrollName(); }, [message, scrollName]);
  function submit(event: FormEvent) { event.preventDefault(); if (name.trim() && pin.length >= 4 && !busy) { onSearch(name.trim(), pin); setPin(''); } }
  return <form ref={form} className="space-y-4 sm:space-y-6" onSubmit={submit}>
    {message && <Alert variant={message === 'error' ? 'error' : 'info'} focusOnReveal>{text(message === 'error' ? 'error' : 'notFound')}</Alert>}
    <Label className="grid gap-2 text-lg sm:text-xl [@media(max-height:500px)]:text-base">{text('name')}<Input ref={nameRef} data-kiosk-focus onFocus={scrollName}
      className="h-12 text-lg sm:h-16 sm:text-2xl [@media(max-height:500px)]:h-12 [@media(max-height:500px)]:text-lg" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" autoCapitalize="words" required/></Label>
    <div className="space-y-3"><Label className="grid gap-2 text-lg sm:text-xl">{text('pin')}
      <Input type="password" inputMode="none" autoComplete="off" maxLength={8} pattern="[0-9]{4,8}" required
        className="h-14 text-center text-3xl tracking-[0.5em]" value={pin} onChange={(event) => setPin(event.target.value.replace(/[^0-9]/g, '').slice(0, 8))}/></Label>
      <div className="grid grid-cols-3 gap-2 sm:gap-3">{['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => <Button key={digit} type="button" variant="outline" className={big} onClick={() => press(digit)}>{digit}</Button>)}
        <Button type="button" variant="outline" className={big} onClick={() => setPin('')}>{text('clear')}</Button>
        <Button type="button" variant="outline" className={big} onClick={() => press('0')}>0</Button>
        <Button type="button" variant="outline" className={big} aria-label={text('backspace')} onClick={() => setPin((value) => value.slice(0, -1))}>⌫</Button></div></div>
    <Button type="submit" className={big + ' w-full'} disabled={busy || !name.trim() || pin.length < 4}>{text('find')}</Button>
  </form>;
}

function Person({ member }: { member: KioskMemberIdentity }) {
  return <span className="flex min-w-0 items-center gap-3 sm:gap-4">{member.photoUrl
    ? <img src={member.photoUrl} alt="" className="size-12 shrink-0 rounded-full object-cover sm:size-16"/>
    : <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-xl sm:size-16 sm:text-2xl">{member.firstName.slice(0, 1)}</span>}
    <span className="min-w-0 wrap-anywhere text-xl sm:text-2xl">{text('person', { first: member.firstName, initial: member.lastInitial })}</span></span>;
}

function Select({ screen, busy, onChange, onSubmit, onCancel }: { screen: Extract<Screen, { kind: 'select' }>; busy: boolean;
  onChange: (screen: Screen) => void; onSubmit: () => void; onCancel: () => void }) {
  const toggle = (id: string) => {
    const chosen = new Set(screen.chosen); if (!chosen.delete(id)) chosen.add(id);
    onChange({ ...screen, chosen });
  };
  return <section className="space-y-4" aria-labelledby="kiosk-select"><h2 id="kiosk-select" tabIndex={-1} data-kiosk-focus className="text-2xl">{text('whoIsHere')}</h2>
    <ul className="space-y-3">{screen.members.map((member) => <li key={member.id}>
      <button type="button" role="checkbox" {...nameWrapMarker} aria-checked={screen.chosen.has(member.id)} disabled={busy} onClick={() => toggle(member.id)}
        className={'flex w-full items-center justify-between rounded-xl border-2 p-4 text-left ' + nameWrapClass + ' ' + (screen.chosen.has(member.id) ? 'border-primary bg-primary/10' : 'border-border')}>
        <Person member={member}/><span className="text-xl">{screen.chosen.has(member.id) ? '✓' : ''}</span></button></li>)}</ul>
    <div className="grid grid-cols-2 gap-3"><Button variant="outline" className={big} onClick={onCancel}>{text('cancel')}</Button>
      <Button className={big} disabled={busy || !screen.chosen.size} onClick={onSubmit}>{text('checkIn')}</Button></div>
  </section>;
}

function Results({ screen, busy, onChoose, onDone, onMembers }: { screen: Extract<Screen, { kind: 'results' }>; busy: boolean;
  onChoose: (memberId: string, sessionId: string | null) => void; onDone: () => void; onMembers: () => void }) {
  const { timeLabel } = useGymTime();
  return <section className="space-y-4" aria-live="polite">
    <h2 tabIndex={-1} data-kiosk-focus className="text-2xl">{text('resultsTitle')}</h2>
    <ul className="space-y-3">{screen.rows.map(({ member, result }) => <li key={member.id} className={'space-y-3 rounded-xl border-2 p-4 '
      + (result?.status === 'checked_in' || result?.status === 'already_checked_in' ? 'border-success bg-success/10' : 'border-border')}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"><Person member={member}/>
        <span className="text-xl font-medium">{text(!result ? 'error' : result.status === 'select_session' ? 'chooseClass' : result.status)}</span></div>
      {result?.status === 'see_front_desk' && <p className="mt-2 text-sm">{text('frontDeskHelp')}</p>}
      {result?.status === 'select_session' && <div className="grid gap-3 sm:grid-cols-2">
        {result.sessions.map((session) => <Button wrap key={session.id} className={big} disabled={busy} onClick={() => onChoose(member.id, session.id)}>{text('session', { name: session.name, time: timeLabel(session.startsAt) })}</Button>)}
        <Button variant="outline" className={big} disabled={busy} onClick={() => onChoose(member.id, null)}>{text('openMat')}</Button></div>}
    </li>)}</ul>
    <div className="grid gap-3 sm:grid-cols-2"><Button variant="outline" className={big} disabled={busy} onClick={onMembers}>{text('changeMembers')}</Button>
      <Button variant="outline" className={big} onClick={onDone}>{text('done')}</Button></div>
  </section>;
}
