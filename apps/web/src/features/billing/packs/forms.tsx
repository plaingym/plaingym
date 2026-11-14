// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useRef, useState, type FormEvent } from 'react';
import { adjustClassCreditsRequestSchema, sellClassPackRequestSchema, type ClassPack } from '@plaingym/shared/contracts';
import { formatMinorUnits } from '@plaingym/shared/money';
import { Alert } from '../../../components/ui/alert.js';
import { Button } from '../../../components/ui/button.js';
import { Dialog } from '../../../components/ui/dialog.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { Select, Textarea } from '../../../components/ui/select.js';
import type { PackClient } from './api.js';
import { failure, text } from './messages.js';

export function SaleForm({ memberId, packs, today, client, close, sold }: {
  memberId: string; packs: ClassPack[]; today: string; client: PackClient; close(): void; sold(invoiceId: string): void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false);
  const packField = useId();
  const active = packs.filter(pack => pack.active);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current) return;
    const form = new FormData(event.currentTarget), packId = String(form.get('packId'));
    const input = sellClassPackRequestSchema.safeParse({ memberId, dueOn: form.get('dueOn') });
    if (!input.success || !active.some(pack => pack.id === packId)) { setError(text('invalidSale')); return; }
    inFlight.current = true; setBusy(true); setError('');
    try { const result = await client.call('sellClassPack', input.data, { packId }); sold(result.data.id); }
    catch (cause) { setError(failure(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog title={text('sell')} closeLabel={text('close')} onClose={close} dismissible={!busy}>
    <form className="min-w-0 space-y-4 wrap-anywhere" onSubmit={event => void submit(event)}>
      <p>{text('saleHelp')}</p>{error && <Alert variant="error" focusOnReveal role="alert">{error}</Alert>}
      {!active.length ? <p>{text('noActivePacks')}</p> : <fieldset disabled={busy} className="min-w-0 space-y-4">
        <div className="min-w-0"><Label htmlFor={packField}>{text('pack')}</Label><Select id={packField} name="packId" required>{active.map(pack => <option key={pack.id} value={pack.id}>{pack.name} · {formatMinorUnits(pack.amountCents, pack.currency)} · {text('creditCount', { count: pack.credits })}</option>)}</Select></div>
        <Label className="block min-w-0">{text('dueOn')}<Input name="dueOn" type="date" required defaultValue={today}/></Label>
        <Button type="submit" className="w-full sm:w-auto">{text(busy ? 'working' : 'sell')}</Button>
      </fieldset>}
    </form>
  </Dialog>;
}

export function AdjustmentForm({ memberId, client, close, adjusted }: {
  memberId: string; client: PackClient; close(): void; adjusted(): void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const inFlight = useRef(false), submissions = useRef(new Map<string, string>());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current) return;
    const form = new FormData(event.currentTarget);
    const values = { memberId, credits: Number(form.get('credits')), reason: String(form.get('reason')).trim() };
    const fingerprint = JSON.stringify(values);
    // Values tried while this form is open keep their ID, so a retry after an uncertain response
    // (also after trying other values in between) can't apply the same adjustment twice.
    const adjustmentId = submissions.current.get(fingerprint) ?? crypto.randomUUID();
    submissions.current.set(fingerprint, adjustmentId);
    const input = adjustClassCreditsRequestSchema.safeParse({ ...values, adjustmentId });
    if (!input.success) { setError(text('invalidAdjustment')); return; }
    inFlight.current = true; setBusy(true); setError('');
    try { await client.call('adjustClassCredits', input.data); adjusted(); }
    catch (cause) { setError(failure(cause)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <Dialog title={text('adjust')} closeLabel={text('close')} onClose={close} dismissible={!busy}>
    <form className="min-w-0 space-y-4 wrap-anywhere" onSubmit={event => void submit(event)}>
      <p>{text('adjustHelp')}</p>{error && <Alert variant="error" focusOnReveal role="alert">{error}</Alert>}
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <Label className="block min-w-0">{text('adjustCredits')}<Input name="credits" type="number" min="-100" max="100" step="1" required/></Label>
        <Label className="block min-w-0">{text('reason')}<Textarea name="reason" required maxLength={500}/></Label>
        <Button type="submit" className="w-full sm:w-auto">{text(busy ? 'working' : 'applyAdjustment')}</Button>
      </fieldset>
    </form>
  </Dialog>;
}
