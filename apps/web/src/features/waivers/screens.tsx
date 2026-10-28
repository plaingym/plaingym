// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type FormEvent } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import { waiverSigningSnapshotSchema, type WaiverTemplate } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { t } from '../../lib/i18n.js';
import { api } from '../../lib/api.js';
import type { ExtensionViewProps } from '../../lib/registries.js';
import { Page, PageHeader } from '../../components/ui/page.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Select, Textarea, CheckboxField } from '../../components/ui/select.js';
import { LoadingState, EmptyState, ErrorState } from '../../components/ui/states.js';
import { Alert } from '../../components/ui/alert.js';
import { waiversClient, WaiverRequestError, type WaiversClient } from './api.js';

const text = (key: string) => t('waivers/waivers:' + key);
const errorText = (error: unknown, fallback: string) => error instanceof WaiverRequestError ? error.message : text(fallback);
const snapshotDetails = (snapshot: string) => waiverSigningSnapshotSchema.parse(JSON.parse(snapshot));
export function Templates({ gymId, manage, client = waiversClient }: { gymId: string; manage: boolean; client?: WaiversClient }) {
  const [offset, setOffset] = useState(0), [editor, setEditor] = useState<WaiverTemplate | 'new' | null>(null);
  const cache = useQueryClient(), key = ['waivers', gymId];
  const query = useQuery({ queryKey: [...key, 'templates', offset], queryFn: () => client.call('listTemplates', undefined, {}, { includeRetired: 'true', offset, limit: 20 }) });
  return <Page><PageHeader title={text('title')} actions={manage && <Button onClick={() => setEditor('new')}>{text('create')}</Button>} />
    {query.isPending && <LoadingState />}{query.isError && <ErrorState onRetry={() => void query.refetch()} />}
    {query.data?.data.length === 0 && <EmptyState title={text('empty')} />}
    <ul className="space-y-3">{query.data?.data.map(row => <li key={row.id} className="min-w-0 space-y-3 rounded-xl border border-border p-4">
      <h2 className="break-words text-lg font-semibold">{row.name}</h2><p>{text(row.kind)} · {text('version')} {row.version} {row.retiredAt && text('retired')}</p>
      <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{row.body.slice(0, 240)}</p>
      {manage && <Button variant="outline" onClick={() => setEditor(row)}>{text('edit')}</Button>}
    </li>)}</ul>
    {query.data && <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={!offset} onClick={() => setOffset(offset - 20)}>{text('previous')}</Button>
      <Button variant="outline" disabled={offset + 20 >= query.data.pagination.total} onClick={() => setOffset(offset + 20)}>{text('next')}</Button></div>}
    {editor && <TemplateEditor row={editor} client={client} close={() => setEditor(null)} saved={async () => { await cache.invalidateQueries({ queryKey: key }); setEditor(null); }} />}
  </Page>;
}
function TemplateEditor({ row, client, close, saved }: { row: WaiverTemplate | 'new'; client: WaiversClient; close: () => void; saved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError(null);
    try {
      const input = { name: data.get('name'), kind: data.get('kind'), body: data.get('body') };
      if (row === 'new') await client.call('createTemplate', input);
      else await client.call('publishTemplate', { ...input, expectedVersion: row.version }, { templateId: row.id });
      await saved();
    } catch (error) { setError(errorText(error, 'saveError')); } finally { setBusy(false); }
  }
  async function retire() {
    if (row === 'new') return; setBusy(true); setError(null);
    try { await client.call('retireTemplate', { expectedVersion: row.version }, { templateId: row.id }); await saved(); }
    catch (error) { setError(errorText(error, 'saveError')); } finally { setBusy(false); }
  }
  return <Dialog title={text(row === 'new' ? 'create' : 'edit')} closeLabel={text('close')} dismissible={!busy} onClose={close} size="wide">
    <form className="space-y-4" onSubmit={event => void save(event)}>
      <p>{text('versionNote')}</p>{error && <Alert role="alert">{error}</Alert>}
      <div><Label htmlFor="waiver-name">{text('name')}</Label><Input id="waiver-name" name="name" required maxLength={200} readOnly={row !== 'new'} defaultValue={row === 'new' ? '' : row.name} /></div>
      <div><Label htmlFor="waiver-kind">{text('kind')}</Label><Select id="waiver-kind" name="kind" defaultValue={row === 'new' ? 'waiver' : row.kind}>
        {(row === 'new' ? ['waiver', 'agreement'] : [row.kind]).map(kind => <option key={kind} value={kind}>{text(kind)}</option>)}
      </Select></div>
      <div><Label htmlFor="waiver-body">{text('body')}</Label><Textarea id="waiver-body" name="body" required maxLength={80_000} rows={14} defaultValue={row === 'new' ? '' : row.body} /></div>
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy}>{text('publish')}</Button>
        {row !== 'new' && !row.retiredAt && <Button type="button" variant="destructive" disabled={busy} onClick={() => void retire()}>{text('retire')}</Button>}
        <Button type="button" variant="outline" disabled={busy} onClick={close}>{text('close')}</Button></div>
    </form>
  </Dialog>;
}
export function MemberWaivers({ gymId, memberId, manage, timezone = 'UTC', locale = 'en', client = waiversClient }: { gymId: string; memberId: string; manage: boolean; timezone?: string; locale?: string; client?: WaiversClient }) {
  const cache = useQueryClient(), key = ['waivers', gymId];
  const [signing, setSigning] = useState<WaiverTemplate | null>(null), [offset, setOffset] = useState(0), [templateOffset, setTemplateOffset] = useState(0);
  const [download, setDownload] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const templates = useQuery({ queryKey: [...key, 'current', templateOffset], queryFn: () => client.call('listTemplates', undefined, {}, { limit: 20, offset: templateOffset }) });
  const signed = useQuery({ queryKey: [...key, memberId, offset], queryFn: async () => {
    const page = await client.call('listSignatures', undefined, {}, { memberId, offset, limit: 20 });
    return { ...page, data: page.data.map(row => ({ ...row, details: snapshotDetails(row.snapshot) })) };
  } });
  // A template ID identifies one immutable version. Check that version directly,
  // independently of whichever page of historical signatures is on screen.
  const statuses = useQueries({ queries: (templates.data?.data ?? []).map(row => ({
    queryKey: [...key, memberId, 'status', row.id, row.version],
    queryFn: async () => (await client.call('listSignatures', undefined, {}, { memberId, templateId: row.id, offset: 0, limit: 1 })).data.some(signature => {
      const snapshot = snapshotDetails(signature.snapshot);
      return snapshot.template.id === row.id && snapshot.template.version === row.version;
    }),
  })) });
  const date = new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
  async function pdf(id: string) { setError(null); setDownload(null); try { setDownload((await client.call('pdf', undefined, { signatureId: id })).data.url); } catch (error) { setError(errorText(error, 'pdfError')); } }
  return <section className="min-w-0 space-y-4" aria-label={text('title')}>
    <h2 className="text-lg font-semibold">{text('title')}</h2>
    {(templates.isPending || signed.isPending) && <LoadingState />}
    {(templates.isError || signed.isError || statuses.some(status => status.isError)) && <ErrorState onRetry={() => { void templates.refetch(); void signed.refetch(); statuses.forEach(status => { void status.refetch(); }); }} />}
    {error && <Alert role="alert">{error}</Alert>}
    {download && <a className="inline-flex min-h-11 items-center break-all underline" href={download}>{text('download')}</a>}
    <h3 className="font-semibold">{text('available')}</h3>
    <ul className="space-y-3">{templates.data?.data.map((row, index) => <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
      <div className="min-w-0 break-words"><p>{row.name} · {text('version')} {row.version}</p>
        <p className="text-sm">{statuses[index]?.isSuccess ? text(statuses[index].data ? 'currentSigned' : 'needsSignature') : text('checkingSignature')}</p></div>
      {manage && <Button variant="outline" onClick={() => setSigning(row)}>{text('reviewSign')}</Button>}
    </li>)}</ul>
    {templates.data && <Pager offset={templateOffset} total={templates.data.pagination.total} setOffset={setTemplateOffset} />}
    <h3 className="font-semibold">{text('signed')}</h3>
    {signed.data?.data.length === 0 && <EmptyState title={text('unsigned')} />}
    <ul className="space-y-3">{signed.data?.data.map(row => <li key={row.id} className="space-y-2 rounded-xl border border-border p-4">
      <h4 className="break-words font-semibold">{row.details.template.name} · {text('version')} {row.details.template.version}</h4>
      <p className="break-words">{text(row.details.signer.kind === 'guardian' ? 'guardianSignature' : 'signer')}: {row.details.signer.name}
        {row.details.signer.kind === 'guardian' && ` (${row.details.signer.relationship})`}</p>
      <p className="break-words">{text('signedAt')}: <time dateTime={row.details.signedAt}>{date.format(new Date(row.details.signedAt))}</time> · {timezone}</p>
      <p className="break-all text-sm text-muted-foreground">{row.snapshotHash}</p>
      <Button variant="outline" onClick={() => void pdf(row.id)}>{text('pdf')}</Button>
    </li>)}</ul>
    {signed.data && <Pager offset={offset} total={signed.data.pagination.total} setOffset={setOffset} />}
    {signing && <Signing key={signing.id} template={signing} memberId={memberId} client={client} close={() => setSigning(null)} saved={async () => { await cache.invalidateQueries({ queryKey: key }); setSigning(null); }} />}
  </section>;
}
function Pager({ offset, total, setOffset }: { offset: number; total: number; setOffset: (value: number) => void }) {
  return <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={!offset} onClick={() => setOffset(offset - 20)}>{text('previous')}</Button>
    <Button variant="outline" disabled={offset + 20 >= total} onClick={() => setOffset(offset + 20)}>{text('next')}</Button></div>;
}
function Signing({ template, memberId, client, close, saved }: { template: WaiverTemplate; memberId: string; client: WaiversClient; close: () => void; saved: () => Promise<void> }) {
  const canvas = useRef<HTMLCanvasElement>(null), drawing = useRef(false), hasInk = useRef(false);
  const uploaded = useRef<{ signatureImageKey: string; signatureImageHash: string } | null>(null);
  const [signatureChanged, setSignatureChanged] = useState(false);
  const [guardian, setGuardian] = useState(false), [typed, setTyped] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError(null);
    try {
      const name = String(data.get('signer')).trim(), node = canvas.current!, ctx = node.getContext('2d')!;
      if (typed) { ctx.clearRect(0, 0, node.width, node.height); ctx.fillStyle = '#000'; ctx.font = '32px sans-serif'; ctx.fillText(name, 12, 65, 560); }
      if (!typed && !hasInk.current) throw new Error('Signature required');
      uploaded.current ??= (await client.call('uploadSignature', { memberId, pngBase64: node.toDataURL('image/png').split(',')[1] })).data;
      await client.call('sign', { memberId, templateId: template.id, templateVersion: template.version, consent: true, ...uploaded.current,
        signer: guardian ? { kind: 'guardian', name, relationship: data.get('relationship') } : { kind: 'self', name },
        commitmentEndsOn: data.get('commitment') || null });
      await saved();
    } catch (error) { setError(errorText(error, 'signError')); } finally { setBusy(false); }
  }
  return <Dialog title={text('reviewSign')} closeLabel={text('close')} dismissible={!busy} unsavedChanges={signatureChanged} onClose={close} size="wide">
    <form className="space-y-4" onSubmit={event => void submit(event)}>
      <h3 className="break-words font-semibold">{template.name} · {text('version')} {template.version}</h3>
      <div className="whitespace-pre-wrap break-words rounded-lg border border-border p-3" dir="auto">{template.body}</div>
      {error && <Alert role="alert">{error}</Alert>}
      <p>{text('guardianNote')}</p>
      <CheckboxField checked={guardian} onChange={e => setGuardian(e.target.checked)} label={text('guardian')} />
      <div><Label htmlFor="signer">{text('signer')}</Label><Input id="signer" name="signer" required maxLength={200} onChange={() => { uploaded.current = null; }} /></div>
      {guardian && <div><Label htmlFor="relationship">{text('relationship')}</Label><Input id="relationship" name="relationship" required maxLength={100} /></div>}
      {template.kind === 'agreement' && <div><Label htmlFor="commitment">{text('commitment')}</Label><Input type="date" id="commitment" name="commitment" /></div>}
      <CheckboxField label={text('typed')} checked={typed} onChange={e => { setTyped(e.target.checked); uploaded.current = null; }} />
      <p>{text('draw')}</p>
      <canvas ref={canvas} width={600} height={180} aria-label={text('draw')} className="h-36 w-full touch-none rounded-lg border border-border"
        onPointerDown={e => { if (typed || busy) return; const c = canvas.current!, box = c.getBoundingClientRect(), ctx = c.getContext('2d')!;
          c.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.lineWidth = 3; ctx.moveTo((e.clientX - box.left) * 600 / box.width, (e.clientY - box.top) * 180 / box.height); drawing.current = true; uploaded.current = null; }}
        onPointerMove={e => { if (!drawing.current) return; const c = canvas.current!, box = c.getBoundingClientRect(), ctx = c.getContext('2d')!;
          ctx.lineTo((e.clientX - box.left) * 600 / box.width, (e.clientY - box.top) * 180 / box.height); ctx.stroke(); hasInk.current = true; setSignatureChanged(true); }}
        onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }} />
      <Button type="button" variant="outline" disabled={busy} onClick={() => { canvas.current?.getContext('2d')?.clearRect(0, 0, 600, 180); hasInk.current = false; uploaded.current = null; }}>{text('clear')}</Button>
      <CheckboxField label={text('consent')} required />
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy}>{text('sign')}</Button><Button type="button" variant="outline" disabled={busy} onClick={close}>{text('close')}</Button></div>
    </form>
  </Dialog>;
}
export function WaiversPage() {
  const bootstrap = useBootstrap(); if (!bootstrap.data?.session) return null;
  return <Templates gymId={bootstrap.data.gym.id} manage={canStaff(bootstrap.data.session.roles, 'settings.manage')} />;
}
export function WaiversTab({ memberId }: ExtensionViewProps) {
  const bootstrap = useBootstrap();
  // The existing staff-readable options include the gym timezone. The shell's
  // bootstrap and settings contract have no locale; use the active UI language.
  const options = useQuery({ queryKey: ['waivers', bootstrap.data?.gym.id, 'formatting'], enabled: !!bootstrap.data?.session && !!memberId,
    queryFn: async () => {
      const response = await api.GET('/api/schedule/options');
      if (!response.data) throw new Error('Gym timezone unavailable');
      return response.data.data;
    } });
  if (!bootstrap.data?.session || !memberId) return null;
  if (options.isPending) return <LoadingState />;
  if (options.isError) return <ErrorState onRetry={() => void options.refetch()} />;
  return <MemberWaivers key={memberId} gymId={bootstrap.data.gym.id} memberId={memberId} timezone={options.data.timezone}
    locale={document.documentElement.lang || 'en'} manage={canStaff(bootstrap.data.session.roles, 'members.manage')} />;
}
