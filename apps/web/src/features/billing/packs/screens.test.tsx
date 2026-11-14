// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ClassPack, ShellBootstrap } from '@plaingym/shared/contracts';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { ShellServicesContext } from '../../../app/context.js';
import { createShellServices } from '../../../app/services.js';
import { ApiError } from '../../../lib/api.js';
import { createRegistries } from '../../../lib/registries.js';
import { packClient, type PackClient } from './api.js';
import { PackCatalog } from './catalog.js';
import { PackEditor } from './editor.js';
import { AdjustmentForm } from './forms.js';
import { PackPanel, PacksTab } from './member-tab.js';

vi.mock('../invoices/detail.js', () => ({ InvoiceDetails: ({ invoiceId, onCreditChange }: { invoiceId: string; onCreditChange?: () => void }) => <><p>Opened invoice {invoiceId}</p><button onClick={onCreditChange}>Change invoice</button></> }));
const id = (n: number) => '019a0af0-9c00-7000-8000-' + String(n).padStart(12, '0');
const createdAt = '2026-11-10T00:00:00Z';
const pack: ClassPack = { id: id(2), name: 'Ten classes', currency: 'CAD', amountCents: 12050, credits: 10,
  expiryDays: 90, active: true, taxRateIds: [], revision: 4, createdAt };
const ledger = { data: { memberId: id(3), balance: 8,
  lots: [{ id: id(5), remaining: 8, createdAt, expiresAt: '2027-02-08T08:00:00Z', saleId: id(6), invoiceId: id(9), invoiceNumber: 42 }],
  entries: [{ id: id(7), memberId: id(3), kind: 'adjust' as const, credits: -2, lotId: id(5), saleId: null,
    attendanceId: null, expiresAt: null, reason: 'Correction', adjustmentId: id(8), createdBy: id(4), createdAt, invoiceId: id(9), invoiceNumber: 42 }] },
  pagination: { limit: 25, offset: 0, total: 1 } };
function client() {
  return { ...packClient, packs: vi.fn(async () => [pack]), taxes: vi.fn(async () => []),
    settings: vi.fn(async () => ({ currency: 'CAD' })),
    ledger: vi.fn(async () => ledger),
    call: vi.fn(async () => ({ data: { id: id(9) } })),
  } as unknown as PackClient;
}
function start(view: React.ReactNode, role: StaffRole = 'owner', cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const bootstrap: ShellBootstrap = { gym: { id: id(1), name: 'Gym', timezone: 'America/Vancouver', currency: 'CAD', enabledModules: [] },
    session: { userId: id(4), displayName: 'Staff', roles: [role], member: false }, login: { password: true, magicLink: false } };
  return render(<QueryClientProvider client={cache}><ShellServicesContext.Provider value={createShellServices(async () => bootstrap)}>{view}</ShellServicesContext.Provider></QueryClientProvider>);
}
function editor(api: PackClient, record?: ClassPack) {
  start(<PackEditor {...(record ? { record } : {})} currency="CAD" taxes={[]} client={api} close={vi.fn()} saved={vi.fn()}/>);
}
const field = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form')!);
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['0', '101', '1.5'])('rejects invalid catalog credit count %s before calling the API', async value => {
  const api = client(); editor(api);
  field('Name', 'Pack'); field('Credits', value); submit();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('1 to 100 credits'));
  expect(api.call).not.toHaveBeenCalled();
});
it.each([{ name: '   ', price: '100', days: '30' }, { name: 'Pack', price: '1.001', days: '' }, { name: 'Pack', price: '10', days: '0' }, { name: 'Pack', price: '10', days: '3651' }])('validates name, money precision and expiry: %j', async value => {
  const api = client(); editor(api); field('Name', value.name); field(/Price/, value.price); field(/Expiry days/, value.days); submit();
  await screen.findByRole('alert'); expect(api.call).not.toHaveBeenCalled();
});
it('creates a pack with exact minor units, credits, selected taxes and no expiry', async () => {
  const api = client();
  start(<PackEditor currency="CAD" taxes={[{ id: id(10), name: 'Tax', rateMillionths: 50000, inclusive: false, active: true, revision: 1, createdAt }]} client={api} close={vi.fn()} saved={vi.fn()}/>);
  field('Name', 'New pack'); field(/Price/, '125.29'); field('Credits', '12'); fireEvent.click(screen.getByLabelText('Tax')); submit();
  await waitFor(() => expect(api.call).toHaveBeenCalledWith('createClassPack', { name: 'New pack', amountCents: 12529, currency: 'CAD', credits: 12, expiryDays: null, taxRateIds: [id(10)], active: true }));
});
it('parses zero-decimal prices in the existing pack currency', async () => {
  const api = client(); editor(api, { ...pack, currency: 'JPY', amountCents: 1200 }); field(/Price/, '1250'); submit();
  await waitFor(() => expect(api.call).toHaveBeenCalledWith('updateClassPack', expect.objectContaining({ currency: 'JPY', amountCents: 1250, revision: 4 }), { packId: pack.id }));
});
it.each([true, false])('archives or restores through the active flag: %s', async active => {
  const api = client(); editor(api, { ...pack, active }); fireEvent.click(screen.getByLabelText('Active')); submit();
  await waitFor(() => expect(api.call).toHaveBeenCalledWith('updateClassPack', expect.objectContaining({ active: !active, revision: 4 }), { packId: pack.id }));
});
it('holds the stale revision and prevents saving again until the editor is reopened', async () => {
  const api = client(); vi.mocked(api.call).mockRejectedValue(new ApiError(409, 'conflict')); editor(api, pack); submit();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('changed elsewhere'));
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  submit(); expect(api.call).toHaveBeenCalledOnce();
});
it('lists archived packs only when requested', async () => {
  const api = client(); vi.mocked(api.packs).mockResolvedValue([pack, { ...pack, id: id(11), name: 'Old pack', active: false }]);
  start(<PackCatalog gymId={id(1)} client={api}/>);
  await screen.findByText(pack.name); expect(screen.queryByText('Old pack')).toBeNull();
  fireEvent.click(screen.getByLabelText('Show archived packs')); expect(screen.getByText('Old pack')).toBeDefined();
});
it('reloads packs and tax rates when the catalog section refreshes after a tax change', async () => {
  const api = client(), cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  start(<PackCatalog gymId={id(1)} client={api}/>, 'owner', cache);
  await screen.findByText(pack.name); expect(api.packs).toHaveBeenCalledOnce();
  await cache.invalidateQueries({ queryKey: ['billing', id(1), 'catalog'] });
  await waitFor(() => expect(api.packs).toHaveBeenCalledTimes(2)); expect(api.taxes).toHaveBeenCalledTimes(2);
});
it('opens the newly sold invoice and excludes archived packs from sale choices', async () => {
  const api = client(); vi.mocked(api.packs).mockResolvedValue([pack, { ...pack, id: id(11), name: 'Archived pack', active: false }]);
  start(<PackPanel gymId={id(1)} memberId={id(3)} timezone="America/Vancouver" access={{ record: true, links: true, refund: false }} client={api}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Sell a pack' }));
  const choice = await screen.findByRole('combobox', { name: 'Class pack' }); expect(choice.children).toHaveLength(1);
  field('Due date', '2026-11-20'); fireEvent.submit(choice.closest('form')!);
  await waitFor(() => expect(api.call).toHaveBeenCalledWith('sellClassPack', { memberId: id(3), dueOn: '2026-11-20' }, { packId: pack.id }));
  expect(await screen.findByText('Opened invoice ' + id(9))).toBeDefined();
  expect(screen.queryByLabelText('Class pack')).toBeNull();
});
it('requires a nonblank adjustment reason and rejects a zero credit change', async () => {
  const api = client(); start(<AdjustmentForm memberId={id(3)} client={api} close={vi.fn()} adjusted={vi.fn()}/>);
  field('Credit change', '2'); field('Reason', '   ');
  const form = screen.getByRole('button', { name: 'Apply adjustment' }).closest('form')!;
  fireEvent.submit(form); await screen.findByRole('alert'); expect(api.call).not.toHaveBeenCalled();
  field('Reason', 'Correction'); field('Credit change', '0'); fireEvent.submit(form); expect(api.call).not.toHaveBeenCalled();
});
it('shows the server refusal inside the adjustment dialog without dismissing it', async () => {
  const api = client(); vi.mocked(api.call).mockRejectedValue(new ApiError(409, 'conflict', ['insufficient_credits']));
  const adjusted = vi.fn(); start(<AdjustmentForm memberId={id(3)} client={api} close={vi.fn()} adjusted={adjusted}/>);
  field('Credit change', '-9'); field('Reason', 'Correction'); fireEvent.submit(screen.getByLabelText('Reason').closest('form')!);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('not enough available credits'));
  expect(adjusted).not.toHaveBeenCalled(); expect(screen.getByRole('dialog', { name: 'Adjust credits' })).toBeDefined();
});
it('blocks duplicate submissions and reuses the adjustment ID after an uncertain response', async () => {
  const api = client(); let reject!: (cause: unknown) => void;
  vi.mocked(api.call).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  start(<AdjustmentForm memberId={id(3)} client={api} close={vi.fn()} adjusted={vi.fn()}/>);
  field('Credit change', '3'); field('Reason', ' Correction '); const form = screen.getByLabelText('Reason').closest('form')!;
  fireEvent.submit(form); fireEvent.submit(form); expect(api.call).toHaveBeenCalledOnce();
  const first = vi.mocked(api.call).mock.calls[0]![1];
  reject(new Error('Lost response')); await screen.findByRole('alert');
  fireEvent.submit(form); expect(api.call).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.call).mock.calls[1]![1]).toEqual(first);
  expect(first).toMatchObject({ memberId: id(3), credits: 3, reason: 'Correction', adjustmentId: expect.any(String) });
});
it('keeps an adjustment ID for values retried after other values were tried', async () => {
  const api = client(); vi.mocked(api.call).mockRejectedValue(new Error('Lost response'));
  start(<AdjustmentForm memberId={id(3)} client={api} close={vi.fn()} adjusted={vi.fn()}/>);
  field('Credit change', '5'); field('Reason', 'Correction'); const form = screen.getByLabelText('Reason').closest('form')!;
  const settled = () => waitFor(() => { expect(form.querySelector('fieldset')!.disabled).toBe(false); screen.getByRole('alert'); });
  fireEvent.submit(form); await settled();
  field('Credit change', '4'); fireEvent.submit(form); await settled();
  field('Credit change', '5'); fireEvent.submit(form); await settled(); expect(api.call).toHaveBeenCalledTimes(3);
  const ids = vi.mocked(api.call).mock.calls.map(call => (call[1] as { adjustmentId: string }).adjustmentId);
  expect(ids[2]).toBe(ids[0]); expect(ids[1]).not.toBe(ids[0]);
});
it('renders balance, lot expiry, history reason and an invoice action', async () => {
  const api = client(); start(<PackPanel gymId={id(1)} memberId={id(3)} timezone="America/Vancouver" access={{ record: false, links: false, refund: false }} client={api}/>);
  await screen.findByText('Available credits: 8'); expect(screen.getByText('Credits remaining: 8')).toBeDefined();
  expect(screen.getByText('Correction')).toBeDefined(); expect(screen.getByText(/^Expires /)).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Sell a pack' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Adjust credits' })).toBeNull();
  expect(api.packs).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole('button', { name: 'Invoice #42' })[0]!);
  expect(await screen.findByText('Opened invoice ' + id(9))).toBeDefined();
});
it('requests the next page of history without changing member scope', async () => {
  const api = client(); vi.mocked(api.ledger).mockResolvedValue({ ...ledger, pagination: { limit: 25, offset: 0, total: 26 } });
  start(<PackPanel gymId={id(1)} memberId={id(3)} timezone="UTC" access={{ record: false, links: false, refund: false }} client={api}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
  await waitFor(() => expect(api.ledger).toHaveBeenLastCalledWith(id(3), 25));
});
it('keeps the balance and pager on screen while the next history page loads', async () => {
  const api = client(), first = { ...ledger, pagination: { limit: 25, offset: 0, total: 26 } };
  let finish!: (page: typeof ledger) => void;
  vi.mocked(api.ledger).mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  start(<PackPanel gymId={id(1)} memberId={id(3)} timezone="UTC" access={{ record: false, links: false, refund: false }} client={api}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
  await waitFor(() => expect(api.ledger).toHaveBeenLastCalledWith(id(3), 25));
  expect(screen.getByText('Available credits: 8')).toBeDefined();
  expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true);
  finish({ ...first, pagination: { limit: 25, offset: 25, total: 26 } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', false));
});
it('follows a delayed credit effect after collection and closing the invoice', async () => {
  const api = client();
  const empty = { ...ledger, data: { ...ledger.data, balance: 0 } };
  vi.mocked(api.ledger).mockResolvedValue(empty);
  start(<PackPanel gymId={id(1)} memberId={id(3)} timezone="UTC" access={{ record: false, links: false, refund: false }} client={api}/>);
  fireEvent.click((await screen.findAllByRole('button', { name: 'Invoice #42' }))[0]!);
  await screen.findByText('Opened invoice ' + id(9));
  vi.mocked(api.ledger).mockResolvedValueOnce(empty).mockResolvedValue({ ...ledger, data: { ...ledger.data, balance: 10 } });
  fireEvent.click(screen.getByRole('button', { name: 'Change invoice' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(await screen.findByText('Available credits: 10', {}, { timeout: 5000 })).toBeDefined();
});
it.each(['owner', 'admin', 'front_desk', 'coach'] as const)('registers and renders the member tab with %s permissions', async role => {
  const entry = createRegistries().memberTabs.forModules(new Set()).find(row => row.id === 'memberTabs.packs')!;
  expect(entry.permission).toEqual({ kind: 'staff', capability: 'billing.read' });
  expect(entry.component).toBe(PacksTab);
  const load = vi.spyOn(packClient, 'ledger').mockResolvedValue(ledger);
  start(<PacksTab memberId={id(3)}/>, role);
  if (canStaff([role], 'billing.read')) {
    await screen.findByText('Available credits: 8'); expect(load).toHaveBeenCalledWith(id(3), 0);
    expect(screen.queryByRole('button', { name: 'Sell a pack' }) !== null).toBe(canStaff([role], 'payments.record'));
    expect(screen.queryByRole('button', { name: 'Adjust credits' }) !== null).toBe(canStaff([role], 'payments.record'));
  } else { await screen.findByText('You do not have access to class packs'); expect(load).not.toHaveBeenCalled(); }
});

it.each(['currency_mismatch', 'tax_inactive'])('keeps Save available for the specific %s refusal', async reason => {
  const api = client(); vi.mocked(api.call).mockRejectedValue(new ApiError(409, 'conflict', [reason])); editor(api, pack); submit();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining(reason === 'currency_mismatch' ? 'currency' : 'tax'));
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
  expect(screen.queryByText(/changed elsewhere/)).toBeNull();
});
it.each([false, true])('follows credit effects only after an invoice changes: %s', async changed => {
  const api = client(), cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(cache, 'invalidateQueries');
  start(<PackPanel gymId={id(1)} memberId={id(3)} timezone="UTC" access={{ record: false, links: false, refund: false }} client={api}/>, 'owner', cache);
  fireEvent.click((await screen.findAllByRole('button', { name: 'Invoice #42' }))[0]!);
  await screen.findByText('Opened invoice ' + id(9));
  vi.useFakeTimers();
  const before = vi.mocked(api.ledger).mock.calls.length;
  if (changed) fireEvent.click(screen.getByRole('button', { name: 'Change invoice' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  // The real invoice action invalidates billing once; the callback only starts follow-up reads.
  expect(invalidate).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(2001); });
  expect(api.ledger).toHaveBeenCalledTimes(before + (changed ? 1 : 0));
  expect(api.call).not.toHaveBeenCalled();
});
