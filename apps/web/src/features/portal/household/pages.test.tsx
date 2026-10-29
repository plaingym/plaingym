// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PortalContext } from '@plaingym/shared/contracts';
import { ShellServicesContext } from '../../../app/context.js';
import type { ShellServices } from '../../../app/services.js';
import { PortalBillingPage } from '../billing/page.js';
import { PortalWaiversPage } from '../waivers/page.js';
import { PortalHouseholdPage } from './page.js';
import { gymToday, knownMinor, needsGuardian } from './api.js';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ids = { gym: id(1), user: id(2), household: id(3), payer: id(4), child: id(5), adult: id(6), invoice: id(7), paid: id(8), card: id(9), template: id(10), signature: id(11) };
const payer: PortalContext = { role: 'payer', householdId: ids.household, memberId: ids.payer };
const adult: PortalContext = { role: 'member', householdId: ids.household, memberId: ids.adult };
const person = (memberId: string, firstName: string, dateOfBirth: string | null) => ({ id: memberId, firstName, lastName: 'Rivera', email: null, phone: null,
  dateOfBirth, photoKey: null, status: 'active', emergencyContacts: [{ name: 'Grandparent', relationship: null, phone: '555-0100' }], revision: 1 });
const people = [person(ids.payer, 'Pat', '1980-04-02'), person(ids.child, 'Kim', '2016-06-01'), person(ids.adult, 'Alex', '1990-01-01'), person(id(12), 'Jordan', null)];
const page = <T,>(data: T[]) => ({ data, pagination: { limit: 100, offset: 0, total: data.length } });
type Handler = (path: string, init?: RequestInit) => unknown;
function mount(element: ReactNode, handle: Handler) {
  vi.stubGlobal('scrollTo', vi.fn());
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input), result = handle(path, init);
    return result instanceof Response ? result : result === undefined ? new Response(null, { status: 404 }) : Response.json(result);
  });
  vi.stubGlobal('fetch', fetcher);
  const services: ShellServices = { loadBootstrap: async () => ({ gym: { id: ids.gym, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
    session: { userId: ids.user, roles: [], member: true }, login: { password: true, magicLink: false } }), signOut: vi.fn(), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  render(<ShellServicesContext.Provider value={services}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{element}</QueryClientProvider></ShellServicesContext.Provider>);
  const calls = (method: string, path: string) => fetcher.mock.calls.filter(([url, init]) => String(url).split('?')[0] === path && (init?.method ?? 'GET') === method);
  return { fetcher, calls };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('portal billing page', () => {
  const invoice = (invoiceId: string, number: number, status: string, paidAt: string | null) => ({ id: invoiceId, number, kind: 'one_off', status, dueOn: '2026-10-20', amountCents: 2500, currency: 'USD', paidAt });
  const handle: Handler = (path, init) => {
    if (path.startsWith('/api/portal/invoices?')) return page([invoice(ids.invoice, 7, 'past_due', null), invoice(ids.paid, 6, 'paid', '2026-09-21T10:00:00.000Z')]);
    if (path === `/api/portal/invoices/${ids.invoice}`) return { data: { invoice: invoice(ids.invoice, 7, 'past_due', null), lines: [{ id: id(20), kind: 'charge', description: 'Mat fee', amountCents: 2500, currency: 'USD', quantity: 1, taxRateMillionths: null, taxInclusive: null }] } };
    if (path === `/api/portal/invoices/${ids.invoice}/checkout` && init?.method === 'POST') return { data: { url: 'https://checkout.example.test/pay', expiresAt: '2026-10-30T00:00:00.000Z' } };
    if (path === `/api/portal/invoices/${ids.paid}/receipt`) return { data: { url: 'https://files.example.test/receipt.pdf', expiresAt: '2026-10-30T00:00:00.000Z' } };
    if (path === '/api/portal/payment-methods') return { data: [{ id: ids.card, brand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2029, isDefault: true }] };
    if (path === '/api/portal/payment-methods/checkout') return Response.json({ error: { code: 'unavailable', message: 'Card setup is not available yet' } }, { status: 503 });
    return undefined;
  };
  it('lists invoices, shows lines, pays through Checkout and offers receipts for paid invoices', async () => {
    const navigate = vi.fn(), user = userEvent.setup(), view = mount(<PortalBillingPage navigate={navigate} />, handle);
    expect(await screen.findByText('Invoice #7')).toBeDefined();
    expect(screen.getByText('Past due')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'Pay now' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Download receipt' })).toHaveLength(1);
    await user.click(screen.getAllByRole('button', { name: 'Details' })[0]!);
    expect(await screen.findByText('Mat fee')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Pay now' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://checkout.example.test/pay'));
    expect(view.calls('POST', `/api/portal/invoices/${ids.invoice}/checkout`)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Download receipt' }));
    expect((await screen.findByRole('link', { name: 'Open receipt' })).getAttribute('href')).toBe('https://files.example.test/receipt.pdf');
    expect(await screen.findByText(/•••• 4242/)).toBeDefined();
  });
  it('explains when card setup is unavailable', async () => {
    const navigate = vi.fn(), user = userEvent.setup();
    mount(<PortalBillingPage navigate={navigate} />, handle);
    await user.click(await screen.findByRole('button', { name: 'Update card' }));
    expect((await screen.findByRole('alert')).textContent).toContain("Online payment isn't available");
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('portal waivers page', () => {
  const template = { id: ids.template, name: 'Participation', kind: 'waiver', version: 1, body: 'I agree.', retiredAt: null, createdAt: '2026-10-01T00:00:00.000Z' };
  const snapshot = JSON.stringify({ template: { id: ids.template, name: 'Participation', kind: 'waiver', version: 1, body: 'I agree.' },
    member: { id: ids.child, firstName: 'Kim', lastName: 'Rivera', dateOfBirth: '2016-06-01' }, signer: { kind: 'guardian', name: 'Pat', relationship: 'Parent' },
    signedAt: '2026-10-02T00:00:00.000Z', commitmentEndsOn: null, signatureImage: { key: 'k', hash: 'a'.repeat(64) } });
  const signature = { id: ids.signature, memberId: ids.child, templateId: ids.template, snapshot, snapshotHash: 'b'.repeat(64), signatureImageKey: 'k', signatureImageHash: 'a'.repeat(64), signedAt: '2026-10-02T00:00:00.000Z' };
  const image = { data: { signatureImageKey: 'gym/waivers/x.png', signatureImageHash: 'c'.repeat(64) } };
  it('lets an adult member sign their own waiver through the self routes', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), fillText: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,YQ==');
    const view = mount(<PortalWaiversPage context={adult} />, (path, init) => {
      if (path === `/api/portal/members/${ids.adult}`) return { data: people[2] };
      if (path.startsWith('/api/portal/waivers/pending')) return page([{ memberId: ids.adult, template }]);
      if (path.startsWith('/api/portal/waivers?')) return page([]);
      if (path === '/api/portal/waivers/signature-images') return image;
      if (path === '/api/portal/waivers' && init?.method === 'POST') return { data: { ...signature, memberId: ids.adult } };
      return undefined;
    }), user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Review and sign' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Relationship to the member')).toBeNull();
    await user.type(within(dialog).getByLabelText('Your full name'), 'Alex Rivera');
    await user.click(within(dialog).getByLabelText('Use my typed name as my signature'));
    await user.click(within(dialog).getByLabelText('I have read this text and agree to sign it electronically.'));
    await user.click(within(dialog).getByRole('button', { name: 'Sign' }));
    await waitFor(() => expect(view.calls('POST', '/api/portal/waivers')).toHaveLength(1));
    const body = JSON.parse(String(view.calls('POST', '/api/portal/waivers')[0]![1]!.body));
    expect(body).toMatchObject({ memberId: ids.adult, templateId: ids.template, signer: { kind: 'self', name: 'Alex Rivera' }, consent: true, signatureImageKey: 'gym/waivers/x.png' });
    expect(view.calls('GET', '/api/portal/household/waivers')).toHaveLength(0);
  });
  it('does not submit a blank canvas after switching away from a drawn signature', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() } as unknown as CanvasRenderingContext2D);
    const view = mount(<PortalWaiversPage context={adult} />, path => {
      if (path === `/api/portal/members/${ids.adult}`) return { data: people[2] };
      if (path.startsWith('/api/portal/waivers/pending')) return page([{ memberId: ids.adult, template }]);
      if (path.startsWith('/api/portal/waivers?')) return page([]);
      return undefined;
    }), user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Review and sign' }));
    const dialog = screen.getByRole('dialog'), canvas = dialog.querySelector('canvas')!;
    await user.pointer([{ keys: '[MouseLeft>]', target: canvas, coords: { clientX: 5, clientY: 5 } }, { target: canvas, coords: { clientX: 20, clientY: 20 } }, { keys: '[/MouseLeft]' }]);
    await user.click(within(dialog).getByLabelText('Use my typed name as my signature'));
    await user.click(within(dialog).getByLabelText('Use my typed name as my signature'));
    await user.type(within(dialog).getByLabelText('Your full name'), 'Alex Rivera');
    await user.click(within(dialog).getByLabelText('I have read this text and agree to sign it electronically.'));
    await user.click(within(dialog).getByRole('button', { name: 'Sign' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Draw your signature or use your typed name.');
    expect(view.calls('POST', '/api/portal/waivers/signature-images')).toHaveLength(0);
  });
  it('shows the payer every household member and asks for a guardian for children', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), fillText: vi.fn() } as unknown as CanvasRenderingContext2D);
    mount(<PortalWaiversPage context={payer} />, path => {
      if (path.startsWith('/api/portal/members?')) return page(people);
      if (path.startsWith('/api/portal/household/waivers/pending')) return page([{ memberId: ids.child, template }, { memberId: ids.adult, template }, { memberId: id(12), template }]);
      if (path.startsWith('/api/portal/household/waivers?')) return page([signature]);
      if (path === `/api/portal/household/waivers/${ids.signature}/pdf`) return { data: { url: 'https://files.example.test/w.pdf', expiresAt: '2026-10-30T00:00:00.000Z' } };
      return undefined;
    });
    const user = userEvent.setup();
    expect(await screen.findByText(/Signed by Pat \(guardian\)/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Prepare PDF' }));
    expect((await screen.findByRole('link', { name: /Open the signed PDF/ })).getAttribute('href')).toBe('https://files.example.test/w.pdf');
    // Another adult signs from their own login; the payer is offered only the child's document.
    expect(screen.getAllByRole('button', { name: 'Review and sign' })).toHaveLength(1);
    expect(screen.getAllByText(/Adults sign their own documents/)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Review and sign' }));
    expect(within(screen.getByRole('dialog')).getByText('For Kim Rivera')).toBeDefined();
    expect(within(screen.getByRole('dialog')).getByLabelText('Relationship to the member')).toBeDefined();
  });
});

describe('portal household page', () => {
  const household = { id: ids.household, name: 'Rivera household', email: 'payer@example.test', phone: null, address: { line1: '1 Main St' }, billingDay: 1, revision: 3 };
  it('lets the payer edit household contacts and children, not other adults, and shows memberships read-only', async () => {
    const view = mount(<PortalHouseholdPage context={payer} />, (path, init) => {
      if (path === '/api/portal/household' && init?.method === 'PATCH') return { data: { ...household, phone: '555-0199', revision: 4 } };
      if (path === '/api/portal/household') return { data: household };
      if (path.startsWith('/api/portal/members?')) return page(people);
      if (path === `/api/portal/members/${ids.child}` && init?.method === 'PATCH') return { data: people[1] };
      if (path.startsWith(`/api/portal/members/${ids.child}/memberships`)) return page([{ id: id(30), memberId: ids.child, planId: id(31), status: 'active',
        interval: 'monthly', startsOn: '2026-01-01', nextDueOn: '2026-11-01', trialEndsOn: null, commitmentEndsOn: null, revision: 1 }]);
      return undefined;
    }), user = userEvent.setup();
    const phone = await screen.findByLabelText('Phone');
    await user.type(phone, '555-0199');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(view.calls('PATCH', '/api/portal/household')).toHaveLength(1));
    expect(await screen.findByText('Saved.')).toBeDefined();
    expect(JSON.parse(String(view.calls('PATCH', '/api/portal/household')[0]![1]!.body))).toEqual({ name: 'Rivera household', email: 'payer@example.test',
      phone: '555-0199', address: { line1: '1 Main St' }, revision: 3 });
    const items = screen.getAllByRole('listitem').filter(item => within(item).queryByText(/Rivera$/));
    const row = (name: string) => items.find(item => within(item).queryByText(new RegExp('^' + name)))!;
    expect(within(row('Kim')).getByRole('button', { name: 'Edit details' })).toBeDefined();
    expect(within(row('Pat')).getByRole('button', { name: 'Edit details' })).toBeDefined();
    expect(within(row('Alex')).queryByRole('button', { name: 'Edit details' })).toBeNull();
    expect(within(row('Jordan')).queryByRole('button', { name: 'Edit details' })).toBeNull();
    await user.click(within(row('Kim')).getByRole('button', { name: 'Show memberships' }));
    expect(await within(row('Kim')).findByText('Monthly membership')).toBeDefined();
    expect(within(row('Kim')).queryByRole('button', { name: /cancel|freeze|change/i })).toBeNull();
    await user.click(within(row('Kim')).getByRole('button', { name: 'Edit details' }));
    const dialog = screen.getByRole('dialog');
    expect((within(dialog).getByLabelText('Relationship') as HTMLInputElement).value).toBe('');
    await user.clear(within(dialog).getByLabelText('First name')); await user.type(within(dialog).getByLabelText('First name'), 'Kimberly');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(view.calls('PATCH', `/api/portal/members/${ids.child}`)).toHaveLength(1));
    expect(JSON.parse(String(view.calls('PATCH', `/api/portal/members/${ids.child}`)[0]![1]!.body))).toMatchObject({ firstName: 'Kimberly', revision: 1,
      emergencyContacts: [{ name: 'Grandparent', relationship: null, phone: '555-0100' }] });
  });
  it('shows an adult member only their own profile, read-only', async () => {
    const view = mount(<PortalHouseholdPage context={adult} />, path => path === `/api/portal/members/${ids.adult}` ? { data: people[2] } : undefined);
    expect(await screen.findByText(/^Alex Rivera/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();
    expect(screen.queryByLabelText('Household name')).toBeNull();
    expect(view.fetcher.mock.calls.map(([path]) => String(path)).filter(path => path.startsWith('/api/portal/'))).toEqual([`/api/portal/members/${ids.adult}`]);
  });
  it('asks for a guardian with no birthday but acts for children only with a recorded one', () => {
    expect(gymToday('UTC', new Date('2026-10-29T23:30:00Z'))).toBe('2026-10-29');
    expect(gymToday('Pacific/Auckland', new Date('2026-10-29T23:30:00Z'))).toBe('2026-10-30');
    expect(needsGuardian(null, '2026-10-29')).toBe(true);
    expect(needsGuardian('2008-10-29', '2026-10-29')).toBe(false);
    expect(needsGuardian('2008-10-30', '2026-10-29')).toBe(true);
    // Acting for someone else needs a recorded birth date under 18.
    expect(knownMinor(null, '2026-10-29')).toBe(false);
    expect(knownMinor('2008-10-29', '2026-10-29')).toBe(false);
    expect(knownMinor('2008-10-30', '2026-10-29')).toBe(true);
  });
});
