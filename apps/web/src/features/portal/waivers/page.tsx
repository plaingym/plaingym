// SPDX-License-Identifier: AGPL-3.0-only
import { dateFormatter } from '../../../lib/instant.js';
import { PortalRecovery } from '../household/recovery.js';
import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { portalContracts as contracts, waiverSigningSnapshotSchema, type PortalContext, type WaiverTemplate } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../../app/context.js';
import { t } from '../../../lib/i18n.js';
import { ApiError } from '../../../lib/api.js';
import { Button } from '../../../components/ui/button.js';
import { Alert } from '../../../components/ui/alert.js';
import { Dialog } from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { CheckboxField } from '../../../components/ui/select.js';
import { Page, PageHeader, PageSection } from '../../../components/ui/page.js';
import { StackedItem, StackedList } from '../../../components/ui/table.js';
import { EmptyState, ErrorState, LoadingState } from '../../../components/ui/states.js';
import { CheckIcon } from '../../../components/ui/icons.js';
import { conflict, gymToday, knownMinor, needsGuardian, usePortalContext, usePortalScope, type PortalScope } from '../household/api.js';
import { portalWaiverEndpoints, type PortalWaiverEndpoints } from './endpoints.js';
import { WaiverDocument, useWaiverDocument } from '../../waivers/document.js';

const text = (key: string, values?: Record<string, string | number>) => t('portal/waivers:' + key, values);
type Person = { id: string; firstName: string; lastName: string; dateOfBirth: string | null };

/** Payers see and sign for every current household member; an adult member sees only their own documents. */
export function PortalWaivers() {
  // The open household is read once; everything below is keyed by it and checks each answer was for it.
  const scope = usePortalScope(), context = usePortalContext(scope);
  if (!context.data) return context.isPending || scope.settling ? <LoadingState /> : <ErrorState onRetry={() => void context.refetch()} />;
  return <PortalWaiversPage context={context.data} scope={scope} />;
}
function PortalWaiversPage({ context, scope }: { context: PortalContext; scope: PortalScope }) {
  const bootstrap = useBootstrap(), cache = useQueryClient(), payer = context.role === 'payer', { ready, own } = scope;
  const endpoints = portalWaiverEndpoints(payer);
  const [signing, setSigning] = useState<{ template: WaiverTemplate; member: Person } | null>(null);
  const people = useQuery({ queryKey: [...scope.key, 'waivers', context.role, 'people'], enabled: ready, queryFn: async (): Promise<Person[]> => payer
    ? own(await scope.call(contracts.members, undefined, {}, { limit: 100, offset: 0 })).data
    : [own(await scope.call(contracts.profile, undefined, { memberId: context.memberId! })).data] });
  const pending = useQuery({ queryKey: [...scope.key, 'waivers', context.role, 'pending'], enabled: ready, queryFn: async () => own(await scope.call(endpoints.pending, undefined, {}, { limit: 100, offset: 0 })) });
  const signed = useQuery({ queryKey: [...scope.key, 'waivers', context.role, 'signed'], enabled: ready, queryFn: async () => own(await scope.call(endpoints.signed, undefined, {}, { limit: 100, offset: 0 })) });
  const pdf = useMutation({ mutationFn: async (signatureId: string) => own(await scope.call(endpoints.pdf, undefined, { signatureId })).data.url });
  const gym = bootstrap.data?.gym;
  if (!gym) return null;
  const name = (memberId: string) => { const person = people.data?.find(row => row.id === memberId); return person ? `${person.firstName} ${person.lastName}` : ''; };
  const date = dateFormatter('date', gym.timezone), today = gymToday(gym.timezone);
  const failed = people.isError || pending.isError || signed.isError;
  const settling = scope.settling && (!people.data || !pending.data || !signed.data);
  return <Page className="max-w-3xl"><PortalRecovery moving={scope.moving}>
    <PageHeader title={text('title')} description={text(payer ? 'descriptionPayer' : 'description')} />
    {(people.isPending || pending.isPending || signed.isPending || settling) && <LoadingState />}
    {failed && !settling && <ErrorState onRetry={() => { void people.refetch(); void pending.refetch(); void signed.refetch(); }} />}
    {pdf.isError && <Alert variant="error" focusOnReveal role="alert">{text('pdfFailed')}</Alert>}
    {pdf.data && <Alert role="status"><a className="inline-flex min-h-11 items-center font-medium underline" href={pdf.data} target="_blank" rel="noreferrer">{text('openPdf')}</a></Alert>}
    {people.data && pending.data && signed.data && <>
      <PageSection title={text('pending')}>
        {pending.data.data.length === 0 ? <EmptyState title={text('allSigned')} icon={<CheckIcon className="size-8 text-success" />} /> : <StackedList>{pending.data.data.map(row => {
          const member = people.data.find(person => person.id === row.memberId);
          return <StackedItem key={row.memberId + row.template.id} className="flex-row flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 break-words"><p className="font-semibold">{row.template.name}</p>
              <p className="text-sm text-muted-foreground">{name(row.memberId)} · {text('version', { version: row.template.version })}</p></div>
            {member && (!payer || member.id === context.memberId || knownMinor(member.dateOfBirth, today))
              ? <Button onClick={() => setSigning({ template: row.template, member })}>{text('reviewSign')}</Button>
              : <p className="text-sm text-muted-foreground">{text('ownLogin')}</p>}
          </StackedItem>;
        })}</StackedList>}
      </PageSection>
      <PageSection title={text('signed')}>
        {signed.data.data.length === 0 ? <EmptyState title={text('noneSigned')} /> : <StackedList>{signed.data.data.map(row => {
          const details = waiverSigningSnapshotSchema.parse(JSON.parse(row.snapshot));
          return <StackedItem key={row.id} className="gap-2">
            <p className="break-words font-semibold">{details.template.name} · {text('version', { version: details.template.version })}</p>
            <p className="break-words text-sm">{name(row.memberId)} · {text(details.signer.kind === 'guardian' ? 'signedByGuardian' : 'signedBy', { name: details.signer.name })}</p>
            <p className="text-sm text-muted-foreground"><time dateTime={row.signedAt}>{date.format(new Date(row.signedAt))}</time></p>
            <div><Button variant="outline" disabled={pdf.isPending} onClick={() => pdf.mutate(row.id)}>{text('pdf')}</Button></div>
          </StackedItem>;
        })}</StackedList>}
      </PageSection>
    </>}
    {signing && <SignWaiver key={signing.template.id + signing.member.id} template={signing.template} member={signing.member} endpoints={endpoints} scope={scope}
      minor={needsGuardian(signing.member.dateOfBirth, today)} close={() => setSigning(null)}
      saved={async () => { await cache.invalidateQueries({ queryKey: [...scope.key, 'waivers', context.role] }); setSigning(null); }} />}
  </PortalRecovery></Page>;
}
/** Draw or type a signature; the server validates the template version, guardian rule and image, and stores one immutable snapshot. */
export function SignWaiver({ template, member, minor, endpoints, scope, close, saved }: { template: WaiverTemplate; member: Person; minor: boolean;
  endpoints: PortalWaiverEndpoints; scope: PortalScope; close: () => void; saved: () => Promise<void> }) {
  const { own } = scope;
  const document = useWaiverDocument(template, scope.key, async () => own(await scope.call(endpoints.document, undefined, { templateId: template.id })));
  const canvas = useRef<HTMLCanvasElement>(null), drawing = useRef(false), hasInk = useRef(false);
  const uploaded = useRef<{ signatureImageKey: string; signatureImageHash: string } | null>(null);
  const [typed, setTyped] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [changed, setChanged] = useState(false);
  const point = (event: { clientX: number; clientY: number }, node: HTMLCanvasElement) => {
    const box = node.getBoundingClientRect(); return [(event.clientX - box.left) * 600 / box.width, (event.clientY - box.top) * 180 / box.height] as const;
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError(null);
    try {
      const signer = String(data.get('signer')).trim(), node = canvas.current!, ctx = node.getContext('2d')!;
      if (typed) { ctx.clearRect(0, 0, node.width, node.height); ctx.fillStyle = '#000'; ctx.font = '32px sans-serif'; ctx.fillText(signer, 12, 65, 560); }
      else if (!hasInk.current) { setError(text('signatureRequired')); return; }
      uploaded.current ??= own(await scope.call(endpoints.upload, { memberId: member.id, pngBase64: node.toDataURL('image/png').split(',')[1] })).data;
      own(await scope.call(endpoints.sign, { memberId: member.id, templateId: template.id, templateVersion: template.version, consent: true, ...uploaded.current,
        signer: minor ? { kind: 'guardian', name: signer, relationship: String(data.get('relationship')).trim() } : { kind: 'self', name: signer } }));
      await saved();
    } catch (failure) { setError(text(failure instanceof ApiError && failure.status === 429 ? failure.reason.includes('busy') ? 'retry' : 'limited' : conflict(failure) ? 'changed' : 'signFailed')); } finally { setBusy(false); }
  }
  const reset = () => { uploaded.current = null; };
  return <Dialog title={text('reviewSign')} closeLabel={text('close')} dismissible={!busy} unsavedChanges={changed} onClose={close} size="wide">
    <form className="space-y-4" onSubmit={event => void submit(event)}>
      <h3 className="break-words font-semibold">{template.name} · {text('version', { version: template.version })}</h3>
      <p className="text-sm text-muted-foreground">{text('for', { name: `${member.firstName} ${member.lastName}` })}</p>
      <WaiverDocument template={template} query={document} />
      {error && <Alert variant="error" focusOnReveal role="alert">{error}</Alert>}
      {minor && <p>{text('guardianNote')}</p>}
      <div><Label htmlFor="signer">{text(minor ? 'guardianName' : 'signer')}</Label><Input id="signer" name="signer" required maxLength={200} autoComplete="name" onChange={reset} /></div>
      {minor && <div><Label htmlFor="relationship">{text('relationship')}</Label><Input id="relationship" name="relationship" required maxLength={100} onChange={reset} /></div>}
      <CheckboxField label={text('typed')} checked={typed} onChange={event => { setTyped(event.target.checked); hasInk.current = false; reset(); }} />
      {!typed && <><p id="draw-help">{text('draw')}</p>
        <canvas ref={canvas} width={600} height={180} aria-label={text('draw')} aria-describedby="draw-help" className="h-36 w-full touch-none rounded-lg border border-border bg-white"
          onPointerDown={event => { if (busy) return; const node = canvas.current!, ctx = node.getContext('2d')!, [x, y] = point(event, node);
            node.setPointerCapture?.(event.pointerId); ctx.beginPath(); ctx.lineWidth = 3; ctx.moveTo(x, y); drawing.current = true; reset(); }}
          onPointerMove={event => { if (!drawing.current) return; const node = canvas.current!, ctx = node.getContext('2d')!, [x, y] = point(event, node);
            ctx.lineTo(x, y); ctx.stroke(); hasInk.current = true; setChanged(true); }}
          onPointerUp={() => { drawing.current = false; }} onPointerCancel={() => { drawing.current = false; }} />
        <Button type="button" variant="outline" disabled={busy} onClick={() => { canvas.current?.getContext('2d')?.clearRect(0, 0, 600, 180); hasInk.current = false; reset(); }}>{text('clear')}</Button></>}
      {typed && <canvas ref={canvas} width={600} height={180} className="hidden" aria-hidden="true" />}
      <CheckboxField label={template.document ? t('waivers/waivers:documentConsent') : text('consent')} required />
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={busy || !!template.document && !document.data}>{text('sign')}</Button><Button type="button" variant="outline" disabled={busy} onClick={close}>{text('close')}</Button></div>
    </form>
  </Dialog>;
}
