// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { useEffect, useRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import type { PortalContext, PortalHousehold as Household, PortalMember } from '@plaingym/shared/contracts';
import { ShellServicesContext } from '../../../app/context.js';
import type { ShellServices } from '../../../app/services.js';
import { PortalBillingPage } from '../billing/page.js';
import { PortalWaivers } from '../waivers/page.js';
import { PortalHousehold } from './page.js';
import { PortalSchedulePage } from '../schedule/page.js';
import { PortalCheckinPage } from '../checkin/page.js';
import { PortalProgressPage } from '../progress/page.js';
import { gymToday, knownMinor, needsGuardian, portalHouseholdKey, portalHouseholdsOptions, portalLoginKey, portalRecoveryNoticeKey, usePortalScope } from './api.js';
import { PortalRecoveryNotice } from './recovery.js';
import { portalTestCache } from './test-cache.test-helper.js';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ids = { gym: id(1), user: id(2), household: id(3), payer: id(4), child: id(5), adult: id(6), invoice: id(7), paid: id(8), card: id(9), template: id(10), signature: id(11) };
const payer: PortalContext = { role: 'payer', memberId: ids.payer };
const adult: PortalContext = { role: 'member', memberId: ids.adult };
const household = { id: ids.household, name: 'Rivera household', email: 'payer@example.test', phone: null, sms: { phoneValid: false, phoneE164: null, notices: null }, address: { line1: '1 Main St' }, billingDay: 1, revision: 3 };
const person = (memberId: string, firstName: string, dateOfBirth: string | null) => ({ id: memberId, firstName, lastName: 'Rivera', email: null, phone: null,
  sms: { phoneValid: false, phoneE164: null, notices: null, announcements: null },
  dateOfBirth, photoKey: null, status: 'active', emergencyContacts: [{ name: 'Grandparent', relationship: null, phone: '555-0100' }], revision: 1 });
const people = [person(ids.payer, 'Pat', '1980-04-02'), person(ids.child, 'Kim', '2016-06-01'), person(ids.adult, 'Alex', '1990-01-01'), person(id(12), 'Jordan', null)];
const page = <T,>(data: T[]) => ({ data, pagination: { limit: 100, offset: 0, total: data.length } });
const contactable = (member: ReturnType<typeof person>): PortalMember => ({ ...member, status: 'active', phone: '+12025550123',
  sms: { phoneValid: true, phoneE164: '+12025550123', notices: null, announcements: null } });
function memberRow(name: string) {
  const items = screen.getAllByRole('listitem').filter(item => within(item).queryByText(/Rivera$/));
  return items.find(item => within(item).queryByText(new RegExp('^' + name)))!;
}
type Handler = (path: string, init?: RequestInit) => unknown;
function PageHost({ children }: { children: ReactNode }) {
  const scope = usePortalScope(), cache = useQueryClient(), previous = useRef(scope.key[4]);
  useEffect(() => {
    if (previous.current !== undefined && previous.current !== scope.key[4]) cache.setQueryData(portalRecoveryNoticeKey(portalLoginKey(ids.gym, ids.user)), true);
    previous.current = scope.key[4];
  }, [cache, scope.key]);
  return <><PortalRecoveryNotice /><div key={scope.key[4]}>{children}</div></>;
}
/**
 * Renders a page with the API answered by `handle`. Every portal answer names the household it was read for, `answeredFor`
 * (the open household unless a test says otherwise); the household lists, which the pages read again after an answer for
 * another household, keep naming the open one.
 */
function mount(element: ReactNode, handle: Handler, { context, answeredFor, householdLists, usePageHost = true, country }: {
  context?: PortalContext; answeredFor?: string; householdLists?: () => Promise<Response>; usePageHost?: boolean; country?: string;
} = {}) {
  vi.stubGlobal('scrollTo', vi.fn());
  let current = ids.household;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/portal/households') {
      if (!householdLists) return Response.json({ data: { current, households: [{ householdId: current, name: 'Test household', role: 'payer' }] } });
      const response = await householdLists();
      if (response.ok) current = (await response.clone().json()).data.current;
      return response;
    }
    if (path === '/api/portal/credits') return Response.json({ data: [], householdId: answeredFor ?? current });
    // The role comes from the open household; the page's own reads are what a test may answer for another one.
    if (path === '/api/portal/context' && (context || (element as { type?: unknown }).type === PortalBillingPage)) return Response.json({ data: context ?? payer, householdId: current });
    const result = await handle(path, init);
    return result instanceof Response ? result : result === undefined ? new Response(null, { status: 404 }) : Response.json({ ...result as object, householdId: answeredFor ?? current });
  });
  vi.stubGlobal('fetch', fetcher);
  const services: ShellServices = { loadBootstrap: async () => ({ gym: { id: ids.gym, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [], ...(country ? { country } : {}) },
    session: { userId: ids.user, displayName: 'Test User', roles: [], member: true }, login: { password: true, magicLink: false } }), signOut: vi.fn(), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  const cache = portalTestCache(ids.gym, ids.user, ids.household, { defaultOptions: { queries: { retry: false } } });
  render(<ShellServicesContext.Provider value={services}><QueryClientProvider client={cache}>
    {usePageHost ? <PageHost>{element}</PageHost> : element}
  </QueryClientProvider></ShellServicesContext.Provider>);
  const calls = (method: string, path: string) => fetcher.mock.calls.filter(([url, init]) => String(url).split('?')[0] === path && (init?.method ?? 'GET') === method);
  /** Nothing is cached under the open household's key: an answer for another household was never stored. */
  const stored = () => cache.getQueryCache().findAll({ queryKey: portalHouseholdKey(portalLoginKey(ids.gym, ids.user), ids.household) }).filter(query => query.state.data !== undefined);
  return { fetcher, calls, stored, cache };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['household', 'waivers', 'schedule', 'checkin', 'progress'] as const)('keeps the first %s read loading while a 404 refreshes household lists', async name => {
  let release!: (response: Response) => void;
  const elements = { household: <PortalHousehold />, waivers: <PortalWaivers />, schedule: <PortalSchedulePage />, checkin: <PortalCheckinPage />, progress: <PortalProgressPage /> };
  const view = mount(elements[name], () => new Response(null, { status: 404 }), {
    ...(name === 'household' || name === 'waivers' ? {} : { context: payer }),
    householdLists: () => new Promise(resolve => { release = resolve; }),
  });
  await waitFor(() => expect(view.calls('GET', '/api/portal/households')).toHaveLength(1));
  expect(screen.getByRole('status').textContent).toContain('Loading');
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => { release(new Response(null, { status: 503 })); });
  expect(await screen.findByRole('alert')).toBeDefined();
  expect(view.calls('GET', '/api/portal/households')).toHaveLength(1);
});

it('keeps a first context failure visible during an ordinary household-list refetch', async () => {
  let release!: (response: Response) => void;
  const view = mount(<PortalHousehold />, () => new Response(null, { status: 500 }), { householdLists: () => new Promise(resolve => { release = resolve; }) });
  await screen.findByRole('alert');
  let read!: Promise<unknown>;
  await act(async () => { read = view.cache.fetchQuery(portalHouseholdsOptions(portalLoginKey(ids.gym, ids.user), true)); });
  expect(screen.getByRole('alert')).toBeDefined();
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => { release(Response.json({ data: { current: ids.household, households: [{ householdId: ids.household, name: 'Rivera', role: 'payer' }] } })); await read; });
  expect(screen.getByRole('alert')).toBeDefined();
});

it.each(['billing', 'waivers', 'checkin', 'progress'] as const)('waits for 404 recovery before showing a first inner %s read failure', async name => {
  let release!: (response: Response) => void;
  const elements = { billing: <PortalBillingPage />, waivers: <PortalWaivers />, checkin: <PortalCheckinPage />, progress: <PortalProgressPage /> };
  const view = mount(elements[name], path => {
    if (path === '/api/portal/schedule/members') return { data: [{ id: ids.payer, name: 'Pat' }] };
    if (path.startsWith('/api/portal/members?')) return page(people);
    return new Response(null, { status: 404 });
  }, { context: payer, householdLists: () => new Promise(resolve => { release = resolve; }) });
  await waitFor(() => expect(view.calls('GET', '/api/portal/households')).toHaveLength(1));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  await act(async () => release(new Response(null, { status: 503 })));
  expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
});

it.each(['schedule', 'checkin', 'progress'] as const)('shows loading, not a failure, while a %s read recovers, and keeps the page if recovery fails', async name => {
  let release!: (response: Response) => void, moved = false;
  const element = name === 'schedule' ? <PortalSchedulePage now={() => new Date('2026-10-29T16:00:00Z')} /> : name === 'checkin' ? <PortalCheckinPage /> : <PortalProgressPage />;
  const view = mount(element, path => {
    if (path === '/api/portal/schedule/members') return moved ? Response.json({ data: [], householdId: id(99) }) : { data: [{ id: ids.payer, name: 'Pat' }] };
    if (path.startsWith('/api/portal/schedule?') || path.includes('/attendance?')) return page([]);
    if (path.endsWith('/checkin-code')) return { data: { memberId: ids.payer, code: 'pgci1_' + 'a'.repeat(43), version: 1, revision: 1 } };
    if (path.endsWith('/progress')) return { data: { history: [], programs: [], ranks: [], criteria: [] } };
    return undefined;
  }, { context: payer, householdLists: () => new Promise(resolve => { release = resolve; }) });
  const heading = await screen.findByRole('heading', { level: 1 });
  moved = true;
  act(() => { void view.cache.invalidateQueries({ queryKey: [...portalHouseholdKey(portalLoginKey(ids.gym, ids.user), ids.household), 'act-for'], exact: true }); });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Loading'));
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  await act(async () => { release(new Response(null, { status: 503 })); });
  expect(await screen.findByRole('heading', { level: 1 })).toBe(heading);
  moved = false;
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
});

it('shows one failure for a read that has its own failure state', async () => {
  let down = false;
  const view = mount(<PortalSchedulePage now={() => new Date('2026-10-29T16:00:00Z')} />, path => {
    if (path === '/api/portal/schedule/members') return { data: [{ id: ids.payer, name: 'Pat' }] };
    if (path.startsWith('/api/portal/schedule?')) return down ? new Response(null, { status: 503 }) : page([]);
    return undefined;
  }, { context: payer });
  await screen.findByRole('heading', { level: 1 });
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  down = true;
  await act(async () => { await view.cache.invalidateQueries({ queryKey: [...portalHouseholdKey(portalLoginKey(ids.gym, ids.user), ids.household), 'schedule'] }); });
  await screen.findByRole('button', { name: 'Try again' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
});

it.each(['book', 'cancel', 'regenerate'] as const)('keeps the %s action state on failed recovery and replaces it after a move', async action => {
  let release!: (response: Response) => void;
  const user = userEvent.setup(), now = new Date('2026-10-29T16:00:00Z');
  const session = { id: id(40), name: 'Fundamentals', startsAt: '2026-10-30T18:00:00Z', endsAt: '2026-10-30T19:00:00Z', coachId: null,
    capacity: 10, status: 'scheduled', revision: 1, bookingOpensAt: '2026-10-23T00:00:00Z', cancelBefore: '2026-10-30T17:00:00Z', placesLeft: 4,
    bookings: action === 'cancel' ? [{ id: id(41), memberId: ids.payer, sessionId: id(40), createdAt: now.toISOString(), status: 'booked', waitlistPosition: null, queueRank: null, cancelledAt: null }] : [] };
  mount(action === 'regenerate' ? <PortalCheckinPage /> : <PortalSchedulePage now={() => now} />, (path, init) => {
    if (init?.method === 'POST') return Response.json({ error: { code: 'conflict' } }, { status: 409, headers: { 'X-Portal-Household': id(99) } });
    if (path === '/api/portal/schedule/members') return { data: [{ id: ids.payer, name: 'Pat' }] };
    if (path.startsWith('/api/portal/schedule?')) return page([session]);
    if (path.endsWith('/checkin-code')) return { data: { memberId: ids.payer, code: 'pgci1_' + 'a'.repeat(43), version: 1, revision: 1 } };
    return undefined;
  }, { context: payer, householdLists: () => new Promise(resolve => { release = resolve; }) });
  if (action === 'regenerate') await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
  else await user.click(await screen.findByRole('button', { name: /^Fundamentals, / }));
  const name = action === 'regenerate' ? 'Replace code' : action === 'book' ? 'Book Fundamentals for Pat' : 'Cancel booking: Fundamentals for Pat';
  const button = await screen.findByRole('button', { name });
  await user.click(button);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Loading'));
  expect(button.isConnected).toBe(true);
  await act(async () => { release(new Response(null, { status: 503 })); });
  expect(await screen.findByRole('button', { name })).toBe(button);
  await user.click(button);
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Loading'));
  await act(async () => { release(Response.json({ data: { current: id(99), households: [{ householdId: id(99), name: 'New home', role: 'payer' }] } })); });
  expect(await screen.findByText(/Your household changed/)).toBeDefined();
  expect(button.isConnected).toBe(false);
  expect(screen.queryByRole('alert')).toBeNull();
});

describe('portal billing page', () => {
  it.each(['USD', 'KWD'])('shows the settlement note without Pay or manual-payment instructions for zero %s', async currency => {
    mount(<PortalBillingPage navigate={vi.fn()} />, path => path.startsWith('/api/portal/invoices?') ? page([
      { id: ids.invoice, number: 7, kind: 'one_off', status: 'open', dueOn: '2026-10-20', amountCents: 0, currency, paidAt: null },
    ]) : path === '/api/portal/payment-methods' ? { data: [] } : undefined);
    expect(await screen.findByText('No payment is needed for this invoice.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pay now' })).toBeNull();
    expect(screen.queryByText(/arrange a manual payment/)).toBeNull();
  });
  it('still loads an answer with additive envelope and record fields', async () => {
    mount(<PortalBillingPage navigate={vi.fn()} />, path => path.startsWith('/api/portal/invoices?')
      ? { ...page([{ id: ids.invoice, number: 7, kind: 'one_off', status: 'open', dueOn: '2026-10-20', amountCents: 2500, currency: 'USD', paidAt: null, added: true }]), added: true }
      : path === '/api/portal/payment-methods' ? { data: [], added: true } : undefined);
    expect(await screen.findByText('Invoice #7')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
  it.each([[32, 'USD'], [1255, 'KWD']] as const)('offers manual payment instead of a card action for %s %s', async (amountCents, currency) => {
    const navigate = vi.fn();
    mount(<PortalBillingPage navigate={navigate} />, path => path.startsWith('/api/portal/invoices?') ? page([
      { id: ids.invoice, number: 7, kind: 'one_off', status: 'open', dueOn: '2026-10-20', amountCents, currency, paidAt: null },
    ]) : path === '/api/portal/payment-methods' ? { data: [] } : undefined);
    expect(await screen.findByText('This invoice cannot be paid by card. Contact the gym to arrange a manual payment.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Pay now' })).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
  const invoice = (invoiceId: string, number: number, status: string, paidAt: string | null) => ({ id: invoiceId, number, kind: 'one_off', status, dueOn: '2026-10-20', amountCents: 2500, currency: 'USD', paidAt });
  const handle: Handler = (path, init) => {
    if (path.startsWith('/api/portal/invoices?')) return page([invoice(ids.invoice, 7, 'past_due', null), invoice(ids.paid, 6, 'paid', '2026-09-21T10:00:00.000Z')]);
    if (path === `/api/portal/invoices/${ids.invoice}`) return { data: { invoice: invoice(ids.invoice, 7, 'past_due', null), lines: [{ id: id(20), kind: 'charge', description: 'Mat fee', amountCents: 2500, currency: 'USD', quantity: 1200, taxRateMillionths: null, taxInclusive: null }] } };
    if (path === `/api/portal/invoices/${ids.invoice}/checkout` && init?.method === 'POST') return { data: { url: 'https://checkout.example.test/pay', expiresAt: '2026-10-30T00:00:00.000Z' } };
    if (path === `/api/portal/invoices/${ids.paid}/receipt`) return { data: { url: 'https://files.example.test/receipt.pdf', expiresAt: '2026-10-30T00:00:00.000Z' } };
    if (path === '/api/portal/payment-methods') return { data: [{ id: ids.card, type: 'card', bankName: null, brand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2029, isDefault: true }] };
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
    expect(screen.getByText(/Quantity 1,200/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Pay now' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://checkout.example.test/pay'));
    expect(view.calls('POST', `/api/portal/invoices/${ids.invoice}/checkout`)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Download receipt' }));
    expect((await screen.findByRole('link', { name: 'Open receipt' })).getAttribute('href')).toBe('https://files.example.test/receipt.pdf');
    expect(await screen.findByText(/•••• 4242/)).toBeDefined();
    // The provider's lowercase network reads as people write it.
    expect(screen.getByText(/^Visa •••• 4242/)).toBeDefined();
  });
  it('explains when card setup is unavailable', async () => {
    const navigate = vi.fn(), user = userEvent.setup();
    mount(<PortalBillingPage navigate={navigate} />, handle);
    await user.click(await screen.findByRole('button', { name: 'Update card' }));
    expect((await screen.findByRole('alert')).textContent).toContain("Online payment isn't available");
    expect(navigate).not.toHaveBeenCalled();
  });
  it.each(['Pay now', 'Update card'])('shows loading while %s recovers from a household conflict, without navigating', async action => {
    const navigate = vi.fn(), user = userEvent.setup();
    let release!: (response: Response) => void;
    const view = mount(<PortalBillingPage navigate={navigate} />, (path, init) => init?.method === 'POST'
      ? Response.json({ error: { code: 'conflict' } }, { status: 409, headers: { 'X-Portal-Household': id(99) } }) : handle(path, init),
    { householdLists: () => new Promise(resolve => { release = resolve; }) });
    await user.click(await screen.findByRole('button', { name: action }));
    await waitFor(() => expect(view.calls('GET', '/api/portal/households')).toHaveLength(1));
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => { release(new Response(null, { status: 503 })); });
    await user.click(await screen.findByRole('button', { name: action }));
    await waitFor(() => expect(view.calls('GET', '/api/portal/households')).toHaveLength(2));
    await act(async () => { release(Response.json({ data: { current: id(99), households: [{ householdId: id(99), name: 'New home', role: 'payer' }] } })); });
    expect(await screen.findByText(/Your household changed/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });
  it('never shows an answer for another household than the open one, and reads the household lists again', async () => {
    const view = mount(<PortalBillingPage navigate={vi.fn()} />, handle, { answeredFor: id(99) });
    await waitFor(() => expect(view.calls('GET', '/api/portal/households').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(3));
    expect(screen.queryByText('Invoice #7')).toBeNull();
    expect(screen.queryByText(/•••• 4242/)).toBeNull();
    expect(view.stored().map(query => query.queryKey.at(-1))).toEqual(['context']);
  });
});

describe('portal waivers page', () => {
  const template = { id: ids.template, name: 'Participation', kind: 'waiver', version: 1, body: 'I agree.', retiredAt: null, createdAt: '2026-10-01T00:00:00.000Z' };
  const snapshot = JSON.stringify({ template: { id: ids.template, name: 'Participation', kind: 'waiver', version: 1, body: 'I agree.' },
    member: { id: ids.child, firstName: 'Kim', lastName: 'Rivera', dateOfBirth: '2016-06-01' }, signer: { kind: 'guardian', name: 'Pat', relationship: 'Parent' },
    signedAt: '2026-10-02T00:00:00.000Z', commitmentEndsOn: null, signatureImage: { key: 'k', hash: 'a'.repeat(64) } });
  const signature = { id: ids.signature, memberId: ids.child, templateId: ids.template, snapshot, snapshotHash: 'b'.repeat(64), signatureImageKey: 'k', signatureImageHash: 'a'.repeat(64), signedAt: '2026-10-02T00:00:00.000Z' };
  const image = { data: { signatureImageKey: 'gym/waivers/x.png', signatureImageHash: 'c'.repeat(64) } };
  it.each(['upload', 'sign'] as const)('retains the drawn signature and signer after failed %s recovery and explains a move', async stage => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,YQ==');
    let release!: (response: Response) => void;
    const user = userEvent.setup();
    mount(<PortalWaivers />, (path, init) => {
      if (init?.method === 'POST') {
        if (stage === 'sign' && path.endsWith('/signature-images')) return image;
        return Response.json({ error: { code: 'conflict' } }, { status: 409, headers: { 'X-Portal-Household': id(99) } });
      }
      if (path === `/api/portal/members/${ids.adult}`) return { data: people[2] };
      if (path.startsWith('/api/portal/waivers/pending')) return page([{ memberId: ids.adult, template }]);
      if (path.startsWith('/api/portal/waivers?')) return page([]);
      return undefined;
    }, { context: adult, householdLists: () => new Promise(resolve => { release = resolve; }) });
    await user.click(await screen.findByRole('button', { name: 'Review and sign' }));
    const dialog = screen.getByRole('dialog'), form = within(dialog), canvas = dialog.querySelector('canvas')!;
    const signer = form.getByLabelText('Your full name');
    await user.type(signer, 'My draft signature');
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas);
    await user.click(form.getByLabelText('I have read this text and agree to sign it electronically.'));
    await user.click(form.getByRole('button', { name: 'Sign' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Loading'));
    expect(canvas.isConnected).toBe(true);
    await act(async () => { release(new Response(null, { status: 503 })); });
    await waitFor(() => expect(screen.getByRole('dialog')).toBe(dialog));
    expect(dialog.querySelector('canvas')).toBe(canvas);
    expect((signer as HTMLInputElement).value).toBe('My draft signature');
    await user.click(form.getByRole('button', { name: 'Sign' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Loading'));
    await act(async () => { release(Response.json({ data: { current: id(99), households: [{ householdId: id(99), name: 'New home', role: 'member' }] } })); });
    expect(await screen.findByText(/Your household changed/)).toBeDefined();
    expect(dialog.isConnected).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it.each(['saved', 'busy', 'limited'] as const)('tells an adult whether to retry a refused signing request through the self routes (%s)', async outcome => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), fillText: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,YQ==');
    const view = mount(<PortalWaivers />, (path, init) => {
      if (path === `/api/portal/members/${ids.adult}`) return { data: people[2] };
      if (path.startsWith('/api/portal/waivers/pending')) return page([{ memberId: ids.adult, template }]);
      if (path.startsWith('/api/portal/waivers?')) return page([]);
      if (path === '/api/portal/waivers/signature-images') return image;
      if (path === '/api/portal/waivers' && init?.method === 'POST') return outcome === 'busy'
        ? Response.json({ error: { code: 'rate_limited', message: 'busy', details: { reason: ['busy'] } } }, { status: 429, headers: { 'Retry-After': '1' } })
        : outcome === 'limited' ? Response.json({ error: { code: 'rate_limited', message: 'quota' } }, { status: 429 }) : { data: { ...signature, memberId: ids.adult } };
      return undefined;
    }, { context: adult }), user = userEvent.setup();
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
    if (outcome === 'busy') expect((await within(dialog).findByRole('alert')).textContent).toContain('The server is busy');
    if (outcome === 'limited') {
      const alert = await within(dialog).findByRole('alert');
      expect(alert.textContent).not.toContain('The server is busy'); expect(alert.textContent).toContain('Your signature has not been saved');
    }
  });
  it('does not submit a blank canvas after switching away from a drawn signature', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() } as unknown as CanvasRenderingContext2D);
    const view = mount(<PortalWaivers />, path => {
      if (path === `/api/portal/members/${ids.adult}`) return { data: people[2] };
      if (path.startsWith('/api/portal/waivers/pending')) return page([{ memberId: ids.adult, template }]);
      if (path.startsWith('/api/portal/waivers?')) return page([]);
      return undefined;
    }, { context: adult }), user = userEvent.setup();
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
    mount(<PortalWaivers />, path => {
      if (path.startsWith('/api/portal/members?')) return page(people);
      if (path.startsWith('/api/portal/household/waivers/pending')) return page([{ memberId: ids.child, template }, { memberId: ids.adult, template }, { memberId: id(12), template }]);
      if (path.startsWith('/api/portal/household/waivers?')) return page([signature]);
      if (path === `/api/portal/household/waivers/${ids.signature}/pdf`) return { data: { url: 'https://files.example.test/w.pdf', expiresAt: '2026-10-30T00:00:00.000Z' } };
      return undefined;
    }, { context: payer });
    const user = userEvent.setup();
    expect(await screen.findByText(/Signed by Pat \(guardian\)/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Prepare PDF' }));
    expect((await screen.findByRole('link', { name: /Open the signed PDF/ })).getAttribute('href')).toBe('https://files.example.test/w.pdf');
    // Another adult signs from their own login; the member with no birth date needs the gym to add it.
    expect(screen.getAllByRole('button', { name: 'Review and sign' })).toHaveLength(1);
    expect(screen.getAllByText(/Adults sign their own documents/)).toHaveLength(1);
    expect(screen.getByText("Ask the gym to add Jordan Rivera's date of birth so you can sign for them as their parent or guardian.")).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Review and sign' }));
    expect(within(screen.getByRole('dialog')).getByText('For Kim Rivera')).toBeDefined();
    expect(within(screen.getByRole('dialog')).getByLabelText('Relationship to the member')).toBeDefined();
  });
  it('never shows an answer for another household than the open one, and reads the household lists again', async () => {
    const view = mount(<PortalWaivers />, path => {
      if (path.startsWith('/api/portal/members?')) return page(people);
      if (path.startsWith('/api/portal/household/waivers/pending')) return page([{ memberId: ids.child, template }]);
      if (path.startsWith('/api/portal/household/waivers?')) return page([signature]);
      return undefined;
    }, { context: payer, answeredFor: id(99) });
    await waitFor(() => expect(view.calls('GET', '/api/portal/households').length).toBeGreaterThan(0));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeDefined();
    expect(screen.queryByText('Participation')).toBeNull();
    expect(screen.queryByText(/Signed by Pat/)).toBeNull();
    // Only the shared context, which the open household answered, is kept.
    expect(view.stored().map(query => query.queryKey.slice(5))).toEqual([['context']]);
  });
  it('keeps the household page queries mounted while loading recovery, then shows failure without a refetch loop', async () => {
    let release!: (response: Response) => void;
    const view = mount(<PortalHousehold />, path => path === '/api/portal/household' ? { data: household }
      : path.startsWith('/api/portal/members?') ? page(people) : undefined,
    { context: payer, answeredFor: id(99), householdLists: () => new Promise(resolve => { release = resolve; }) });
    await waitFor(() => expect(view.calls('GET', '/api/portal/households')).toHaveLength(1));
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { release(new Response(null, { status: 503 })); });
    expect((await screen.findAllByRole('button', { name: 'Try again' })).length).toBeGreaterThan(0);
    expect(view.calls('GET', '/api/portal/households')).toHaveLength(1);
    expect(view.calls('GET', '/api/portal/household')).toHaveLength(1);
    expect(view.calls('GET', '/api/portal/members')).toHaveLength(1);
  });
});

describe('portal household page', () => {
  it.each(['a draft', 'pending consent'] as const)('resets member controls on a household switch with %s', async state => {
    const nextHousehold = id(99), login = portalLoginKey(ids.gym, ids.user);
    const endpoint = `/api/portal/members/${ids.child}/sms-consent`;
    let current = ids.household;
    const view = mount(<PortalHousehold />, (path, init) => {
      if (path === '/api/portal/household') return { data: { ...household, id: current } };
      if (path.startsWith('/api/portal/members?')) return page([contactable(people[0]!),
        { ...contactable(people[1]!), firstName: current === nextHousehold ? 'Kai' : 'Kim' }]);
      if (path === endpoint && init?.method === 'PUT') return new Promise<Response>(() => {});
      return undefined;
    }, { context: payer, usePageHost: false, householdLists: async () => Response.json({ data: { current, households: [
      { householdId: ids.household, name: 'First home', role: 'payer' }, { householdId: nextHousehold, name: 'Second home', role: 'payer' },
    ] } }) });
    // Keep context available during the switch so the page key must reset the state.
    view.cache.setQueryData([...portalHouseholdKey(login, nextHousehold), 'context'], payer);
    const user = userEvent.setup();
    await screen.findByText('Kim Rivera');
    const child = within(memberRow('Kim'));
    const edit = child.getByRole<HTMLButtonElement>('button', { name: 'Edit details' });
    if (state === 'a draft') {
      await user.click(edit);
      const firstName = within(screen.getByRole('dialog')).getByLabelText<HTMLInputElement>('First name');
      await user.type(firstName, ' draft');
      expect(firstName.value).toBe('Kim draft');
    } else {
      await user.click(child.getByRole('button', { name: 'Agree to notices' }));
      await waitFor(() => expect(view.calls('PUT', endpoint)).toHaveLength(1));
      expect(edit.disabled).toBe(true);
    }

    for (const [householdId, childName] of [[nextHousehold, 'Kai'], [ids.household, 'Kim']] as const) {
      current = householdId;
      await act(async () => { await view.cache.fetchQuery(portalHouseholdsOptions(login, true)); });
      await screen.findByText(`${childName} Rivera`);
      expect(screen.queryByRole('dialog')).toBeNull();
      for (const name of ['Pat', childName]) {
        const row = within(memberRow(name));
        for (const action of ['Edit details', 'Agree to notices', 'Agree to announcements'])
          expect(row.getByRole<HTMLButtonElement>('button', { name: action }).disabled).toBe(false);
      }
    }
  });
  it('closes the editor when its member disappears and keeps it closed when the member returns', async () => {
    let listed = people;
    const view = mount(<PortalHousehold />, path => {
      if (path === '/api/portal/household') return { data: household };
      if (path.startsWith('/api/portal/members?')) return page(listed);
      return undefined;
    }, { context: payer });
    const user = userEvent.setup();
    await screen.findByText('Kim Rivera');
    await user.click(within(memberRow('Kim')).getByRole('button', { name: 'Edit details' }));
    expect(screen.getByRole('dialog')).toBeDefined();

    const queryKey = [...portalHouseholdKey(portalLoginKey(ids.gym, ids.user), ids.household), 'household', 'members'];
    listed = people.filter(member => member.id !== ids.child);
    await act(async () => { await view.cache.invalidateQueries({ queryKey, exact: true }); });
    await waitFor(() => expect(screen.queryByText('Kim Rivera')).toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();

    listed = people;
    await act(async () => { await view.cache.invalidateQueries({ queryKey, exact: true }); });
    await screen.findByText('Kim Rivera');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it.each(['household', 'member'] as const)('joins the gym\'s country code to a typed %s phone and shows no setup hint', async kind => {
    const view = mount(<PortalHousehold />, (path, init) => {
      if (path === '/api/portal/household') return { data: household };
      if (path.startsWith('/api/portal/members?')) return page([people[1]!]);
      if (path === `/api/portal/members/${ids.child}` && init?.method === 'PATCH') return { data: people[1] };
      return undefined;
    }, { context: payer, country: 'CA' });
    await screen.findByLabelText('Phone');
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Country code' }) as HTMLSelectElement).value).toBe('CA'));
    if (kind === 'household') {
      fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '604 555 0123' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(view.calls('PATCH', '/api/portal/household')).toHaveLength(1));
      expect(JSON.parse(String(view.calls('PATCH', '/api/portal/household')[0]![1]!.body))).toMatchObject({ phone: '+1 604 555 0123' });
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
      const dialog = within(screen.getByRole('dialog'));
      await waitFor(() => expect((dialog.getByRole('combobox', { name: 'Country code' }) as HTMLSelectElement).value).toBe('CA'));
      fireEvent.change(dialog.getByLabelText('Phone'), { target: { value: '604 555 0123' } });
      fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(view.calls('PATCH', `/api/portal/members/${ids.child}`)).toHaveLength(1));
      expect(JSON.parse(String(view.calls('PATCH', `/api/portal/members/${ids.child}`)[0]![1]!.body))).toMatchObject({ phone: '+1 604 555 0123' });
    }
    expect(screen.queryByText(/Settings → Gym details/)).toBeNull();
  });
  it.each(['household', 'member'] as const)('omits untouched JSON after reading extended %s data', async kind => {
    const storedHome = { ...household, address: { ...household.address, future: 'stored extension' } };
    const storedChild = { ...people[1]!, emergencyContacts: [{ ...people[1]!.emergencyContacts[0]!, future: true }] };
    const view = mount(<PortalHousehold />, (path, init) => {
      if (path === '/api/portal/household') return { data: storedHome };
      if (path.startsWith('/api/portal/members?')) return page([storedChild]);
      if (path === `/api/portal/members/${ids.child}` && init?.method === 'PATCH') return { data: storedChild };
      return undefined;
    }, { context: payer });
    await screen.findByLabelText('Phone');
    if (kind === 'household') {
      fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '555-0199' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(view.calls('PATCH', '/api/portal/household')).toHaveLength(1));
      expect(JSON.parse(String(view.calls('PATCH', '/api/portal/household')[0]![1]!.body))).toEqual({ revision: 3, phone: '555-0199' });
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
      const dialog = within(screen.getByRole('dialog'));
      fireEvent.change(dialog.getByLabelText('Phone'), { target: { value: '555-0199' } });
      fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(view.calls('PATCH', `/api/portal/members/${ids.child}`)).toHaveLength(1));
      expect(JSON.parse(String(view.calls('PATCH', `/api/portal/members/${ids.child}`)[0]![1]!.body))).toEqual({ revision: 1, phone: '555-0199' });
    }
  });
  it.each(['household', 'member'] as const)('sends a deliberately cleared %s JSON field, but skips reverted edits', async kind => {
    const view = mount(<PortalHousehold />, (path, init) => {
      if (path === '/api/portal/household') return { data: household };
      if (path.startsWith('/api/portal/members?')) return page([people[1]!]);
      if (path === `/api/portal/members/${ids.child}` && init?.method === 'PATCH') return { data: people[1] };
      return undefined;
    }, { context: payer });
    await screen.findByLabelText('Phone');
    fireEvent.change(screen.getByLabelText('Address line 1'), { target: { value: 'Draft' } });
    fireEvent.change(screen.getByLabelText('Address line 1'), { target: { value: '1 Main St' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Nothing changed.');
    expect(view.calls('PATCH', '/api/portal/household')).toHaveLength(0);
    expect(view.calls('GET', '/api/portal/household')).toHaveLength(1);
    if (kind === 'household') {
      fireEvent.change(screen.getByLabelText('Address line 1'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(view.calls('PATCH', '/api/portal/household')).toHaveLength(1));
      expect(JSON.parse(String(view.calls('PATCH', '/api/portal/household')[0]![1]!.body))).toEqual({ revision: 3, address: {} });
    } else {
      fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
      let dialog = within(screen.getByRole('dialog'));
      fireEvent.change(dialog.getByLabelText('Relationship'), { target: { value: 'Draft' } });
      fireEvent.change(dialog.getByLabelText('Relationship'), { target: { value: '' } });
      fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(view.calls('PATCH', `/api/portal/members/${ids.child}`)).toHaveLength(0);
      expect(view.calls('GET', '/api/portal/members')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
      dialog = within(screen.getByRole('dialog'));
      fireEvent.click(dialog.getByRole('button', { name: 'Remove contact' }));
      fireEvent.click(dialog.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(view.calls('PATCH', `/api/portal/members/${ids.child}`)).toHaveLength(1));
      expect(JSON.parse(String(view.calls('PATCH', `/api/portal/members/${ids.child}`)[0]![1]!.body))).toEqual({ revision: 1, emergencyContacts: [] });
    }
  });
  it('asks before discarding member edits through the dialog Close button', async () => {
    mount(<PortalHousehold />, path => path === '/api/portal/household' ? { data: household }
      : path.startsWith('/api/portal/members?') ? page(people) : undefined, { context: payer });
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'Edit details' }))[0]!);
    const dialog = screen.getByRole('dialog'), form = within(dialog), first = form.getByLabelText('First name');
    await user.type(first, ' Changed');
    await user.click(form.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(form.getByText('Discard your unsaved changes?')).toBeDefined();
    await user.click(form.getByRole('button', { name: 'Keep editing' }));
    expect((first as HTMLInputElement).value).toContain('Changed');
    expect(screen.getByRole('dialog')).toBe(dialog);
  });
  it('shows a cached read failure only in the open editor, without rewinding shell scrolling', async () => {
    let down = false;
    const view = mount(<PortalHousehold />, path => {
      if (path === '/api/portal/household') return down ? new Response(null, { status: 503 }) : { data: household };
      if (path.startsWith('/api/portal/members?')) return page(people);
      return undefined;
    }, { context: payer });
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'Edit details' }))[0]!);
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('First name'), ' draft');
    down = true;
    await act(async () => { await view.cache.invalidateQueries({ queryKey: [...portalHouseholdKey(portalLoginKey(ids.gym, ids.user), ids.household), 'household', 'details'], exact: true }); });
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeDefined();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    expect(within(dialog).getByRole('alert').parentElement!.className).toContain('sticky');
    down = false;
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull());
    expect((within(dialog).getByLabelText('First name') as HTMLInputElement).value).toBe('Pat draft');
    expect(window.scrollTo).not.toHaveBeenCalled();
  });
  it('keeps the household draft when a background read fails and its recovery fails too', async () => {
    let release!: (response: Response) => void, moved = false;
    const user = userEvent.setup();
    const view = mount(<PortalHousehold />, path => {
      if (path === '/api/portal/household') return moved ? Response.json({ error: { code: 'conflict' } }, { status: 409, headers: { 'X-Portal-Household': id(99) } }) : { data: household };
      if (path.startsWith('/api/portal/members?')) return page(people);
      return undefined;
    }, { context: payer, householdLists: () => new Promise(resolve => { release = resolve; }) });
    const phone = await screen.findByLabelText('Phone') as HTMLInputElement;
    await user.clear(phone); await user.type(phone, 'Draft');
    moved = true;
    act(() => { void view.cache.invalidateQueries({ queryKey: [...portalHouseholdKey(portalLoginKey(ids.gym, ids.user), ids.household), 'household', 'details'], exact: true }); });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Loading'));
    expect(phone.isConnected).toBe(true);
    await act(async () => { release(new Response(null, { status: 503 })); });
    expect(await screen.findByLabelText('Phone')).toBe(phone);
    expect(phone.value).toBe('Draft');
    expect(document.activeElement).toBe(phone);
    moved = false;
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    expect(phone.value).toBe('Draft');
  });
  it('retries only the read that failed, so a healthy read cannot replace the draft', async () => {
    let down = false;
    const user = userEvent.setup();
    const view = mount(<PortalHousehold />, path => {
      if (path === '/api/portal/household') return down ? new Response(null, { status: 503 }) : { data: household };
      if (path.startsWith('/api/portal/members?')) return page(people);
      return undefined;
    }, { context: payer });
    await screen.findByLabelText('Phone');
    const root = portalHouseholdKey(portalLoginKey(ids.gym, ids.user), ids.household);
    view.cache.setQueryData([...root, 'shell', 'context'], payer);
    const shell = view.cache.getQueryState([...root, 'shell', 'context'])!.dataUpdatedAt;
    down = true;
    await act(async () => { await view.cache.invalidateQueries({ queryKey: [...root, 'household', 'details'], exact: true }); });
    const members = view.calls('GET', '/api/portal/members').length;
    down = false;
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull());
    expect(view.calls('GET', '/api/portal/members')).toHaveLength(members);
    expect(view.cache.getQueryState([...root, 'shell', 'context'])!.isInvalidated).toBe(false);
    expect(view.cache.getQueryState([...root, 'shell', 'context'])!.dataUpdatedAt).toBe(shell);
  });
  it.each(['household', 'member'] as const)('preserves the %s draft on failed recovery and replaces its failure with a move notice', async kind => {
    let release!: (response: Response) => void;
    const user = userEvent.setup();
    mount(<PortalHousehold />, (path, init) => {
      if (init?.method === 'PATCH') return Response.json({ error: { code: 'conflict' } }, { status: 409, headers: { 'X-Portal-Household': id(99) } });
      if (path === '/api/portal/household') return { data: household };
      if (path.startsWith('/api/portal/members?')) return page(people);
      return undefined;
    }, { context: payer, householdLists: () => new Promise(resolve => { release = resolve; }) });
    await screen.findByLabelText('Phone');
    if (kind === 'member') await user.click(screen.getAllByRole('button', { name: 'Edit details' })[0]!);
    const form = kind === 'member' ? within(screen.getByRole('dialog')) : screen;
    const input = form.getByLabelText(kind === 'member' ? 'First name' : 'Phone');
    await user.clear(input); await user.type(input, 'Draft');
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Loading'));
    expect(input.isConnected).toBe(true);
    await act(async () => { release(new Response(null, { status: 503 })); });
    await waitFor(() => expect(form.getByRole('button', { name: 'Save' })).toBeDefined());
    expect(form.getByLabelText(kind === 'member' ? 'First name' : 'Phone')).toBe(input);
    expect((input as HTMLInputElement).value).toBe('Draft');
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Loading'));
    await act(async () => { release(Response.json({ data: { current: id(99), households: [{ householdId: id(99), name: 'New home', role: 'payer' }] } })); });
    expect(await screen.findByText(/Your household changed/)).toBeDefined();
    expect(input.isConnected).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('lets the payer edit household contacts and children, not other adults, and shows memberships read-only', async () => {
    const view = mount(<PortalHousehold />, (path, init) => {
      if (path === '/api/portal/household' && init?.method === 'PATCH') return { data: { ...household, phone: '555-0199', revision: 4 } };
      if (path === '/api/portal/household') return { data: household };
      if (path.startsWith('/api/portal/members?')) return page(people);
      if (path === `/api/portal/members/${ids.child}` && init?.method === 'PATCH') return { data: people[1] };
      if (path.startsWith(`/api/portal/members/${ids.child}/memberships`)) return page([{ id: id(30), memberId: ids.child, planId: id(31), status: 'active',
        interval: 'monthly', startsOn: '2026-01-01', nextDueOn: '2026-11-01', trialEndsOn: null, commitmentEndsOn: null, revision: 1 }]);
      return undefined;
    }, { context: payer }), user = userEvent.setup();
    const phone = await screen.findByLabelText('Phone');
    await user.type(phone, '555-0199');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(view.calls('PATCH', '/api/portal/household')).toHaveLength(1));
    expect(await screen.findByText('Saved.')).toBeDefined();
    expect(JSON.parse(String(view.calls('PATCH', '/api/portal/household')[0]![1]!.body))).toEqual({ phone: '555-0199', revision: 3 });
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
    expect(JSON.parse(String(view.calls('PATCH', `/api/portal/members/${ids.child}`)[0]![1]!.body))).toEqual({ firstName: 'Kimberly', revision: 1 });
  });
  it('holds a member consent action until that member’s editor save and refresh settle', async () => {
    let current = contactable(people[1]!);
    const patchWrite = Promise.withResolvers<void>(), refresh = Promise.withResolvers<void>();
    const endpoint = `/api/portal/members/${ids.child}`, consentEndpoint = endpoint + '/sms-consent';
    const view = mount(<PortalHousehold />, async (path, init) => {
      if (path === '/api/portal/household') return { data: household };
      if (path.startsWith('/api/portal/members?')) {
        if (current.revision === 2) await refresh.promise;
        return page([people[0]!, current, people[2]!, people[3]!]);
      }
      if (path === endpoint && init?.method === 'PATCH') {
        await patchWrite.promise;
        current = { ...current, firstName: 'Kimberly', revision: 2 };
        return { data: current };
      }
      if (path === consentEndpoint && init?.method === 'PUT') {
        current = { ...current, revision: 3, sms: { ...current.sms, notices: { at: '2026-11-16T12:00:00Z', source: 'portal' } } };
        return { data: current };
      }
      return undefined;
    }, { context: payer });
    const user = userEvent.setup();
    await screen.findByLabelText('Phone');
    await user.click(within(memberRow('Kim')).getByRole('button', { name: 'Edit details' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('First name'), { target: { value: 'Kimberly' } });
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(view.calls('PATCH', endpoint)).toHaveLength(1));
    expect(within(memberRow('Kim')).getByRole<HTMLButtonElement>('button', { name: 'Agree to notices' }).disabled).toBe(true);
    fireEvent.click(within(memberRow('Kim')).getByRole('button', { name: 'Agree to notices' }));
    expect(view.calls('PUT', consentEndpoint)).toHaveLength(0);
    await act(async () => { patchWrite.resolve(); });
    await waitFor(() => expect(view.calls('GET', '/api/portal/members')).toHaveLength(2));
    expect(within(memberRow('Kim')).getByRole<HTMLButtonElement>('button', { name: 'Agree to notices' }).disabled).toBe(true);
    fireEvent.click(within(memberRow('Kim')).getByRole('button', { name: 'Agree to notices' }));
    expect(view.calls('PUT', consentEndpoint)).toHaveLength(0);
    await act(async () => { refresh.resolve(); });
    await waitFor(() => expect(within(memberRow('Kim')).getByRole<HTMLButtonElement>('button', { name: 'Agree to notices' }).disabled).toBe(false));
    await user.click(within(memberRow('Kim')).getByRole('button', { name: 'Agree to notices' }));
    await waitFor(() => expect(view.calls('PUT', consentEndpoint)).toHaveLength(1));
    expect(JSON.parse(String(view.calls('PUT', consentEndpoint)[0]![1]!.body))).toEqual({ kind: 'notices', consent: true, revision: 2 });
  });
  it('holds an open editor save until that member’s consent and refresh settle', async () => {
    let current = contactable(people[1]!);
    const consentWrite = Promise.withResolvers<void>(), refresh = Promise.withResolvers<void>();
    const endpoint = `/api/portal/members/${ids.child}`, consentEndpoint = endpoint + '/sms-consent';
    const view = mount(<PortalHousehold />, async (path, init) => {
      if (path === '/api/portal/household') return { data: household };
      if (path.startsWith('/api/portal/members?')) {
        if (current.revision === 2) await refresh.promise;
        return page([people[0]!, current, people[2]!, people[3]!]);
      }
      if (path === consentEndpoint && init?.method === 'PUT') {
        expect(JSON.parse(String(init.body))).toEqual({ kind: 'notices', consent: true, revision: 1 });
        await consentWrite.promise;
        current = { ...current, revision: 2, sms: { ...current.sms, notices: { at: '2026-11-16T12:00:00Z', source: 'portal' } } };
        return { data: current };
      }
      if (path === endpoint && init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body)) as { firstName: string; revision: number };
        expect(input.revision).toBe(2);
        current = { ...current, firstName: input.firstName, revision: 3 };
        return { data: current };
      }
      return undefined;
    }, { context: payer });
    const user = userEvent.setup();
    await screen.findByLabelText('Phone');
    await user.click(within(memberRow('Kim')).getByRole('button', { name: 'Edit details' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('First name'), { target: { value: 'Kimberly' } });
    const save = dialog.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    fireEvent.click(within(memberRow('Kim')).getByRole('button', { name: 'Agree to notices' }));
    await waitFor(() => expect(view.calls('PUT', consentEndpoint)).toHaveLength(1));
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.form!);
    expect(view.calls('PATCH', endpoint)).toHaveLength(0);
    await act(async () => { consentWrite.resolve(); });
    await waitFor(() => expect(view.calls('GET', '/api/portal/members')).toHaveLength(2));
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.form!);
    expect(view.calls('PATCH', endpoint)).toHaveLength(0);
    await act(async () => { refresh.resolve(); });
    await waitFor(() => expect(save.disabled).toBe(false));
    await user.click(save);
    await waitFor(() => expect(view.calls('PATCH', endpoint)).toHaveLength(1));
    expect(JSON.parse(String(view.calls('PATCH', endpoint)[0]![1]!.body))).toEqual({ firstName: 'Kimberly', revision: 2 });
  });
  it('re-enables the member editor after a failed consent request and keeps its values', async () => {
    const write = Promise.withResolvers<void>();
    const endpoint = `/api/portal/members/${ids.child}`, consentEndpoint = endpoint + '/sms-consent';
    const view = mount(<PortalHousehold />, async (path, init) => {
      if (path === '/api/portal/household') return { data: household };
      if (path.startsWith('/api/portal/members?')) return page([people[0]!, contactable(people[1]!), people[2]!, people[3]!]);
      if (path === consentEndpoint && init?.method === 'PUT') { await write.promise; return new Response(null, { status: 503 }); }
      if (path === endpoint && init?.method === 'PATCH') return { data: { ...contactable(people[1]!), firstName: 'Kimberly', revision: 2 } };
      return undefined;
    }, { context: payer });
    const user = userEvent.setup();
    await screen.findByLabelText('Phone');
    await user.click(within(memberRow('Kim')).getByRole('button', { name: 'Edit details' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('First name'), { target: { value: 'Kimberly' } });
    const save = dialog.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    fireEvent.click(within(memberRow('Kim')).getByRole('button', { name: 'Agree to notices' }));
    await waitFor(() => expect(view.calls('PUT', consentEndpoint)).toHaveLength(1));
    expect(save.disabled).toBe(true);
    await act(async () => { write.resolve(); });
    expect(await screen.findByText('Consent could not be saved. Refresh and try again.')).toBeDefined();
    await waitFor(() => expect(save.disabled).toBe(false));
    expect((dialog.getByLabelText('First name') as HTMLInputElement).value).toBe('Kimberly');
    await user.click(save);
    await waitFor(() => expect(view.calls('PATCH', endpoint)).toHaveLength(1));
    expect(JSON.parse(String(view.calls('PATCH', endpoint)[0]![1]!.body))).toEqual({ firstName: 'Kimberly', revision: 1 });
  });
  it('keeps another member’s consent and editor available while one request is held', async () => {
    const write = Promise.withResolvers<void>();
    const childEndpoint = `/api/portal/members/${ids.child}/sms-consent`;
    let current = contactable(people[1]!);
    const view = mount(<PortalHousehold />, async (path, init) => {
      if (path === '/api/portal/household') return { data: household };
      if (path.startsWith('/api/portal/members?')) return page([contactable(people[0]!), current, people[2]!, people[3]!]);
      if (path === childEndpoint && init?.method === 'PUT') {
        await write.promise;
        current = { ...current, revision: 2, sms: { ...current.sms, notices: { at: '2026-11-16T12:00:00Z', source: 'portal' } } };
        return { data: current };
      }
      if (path === `/api/portal/members/${ids.payer}/sms-consent` && init?.method === 'PUT') return { data: contactable(people[0]!) };
      return undefined;
    }, { context: payer });
    const user = userEvent.setup();
    await screen.findByLabelText('Phone');
    fireEvent.click(within(memberRow('Kim')).getByRole('button', { name: 'Agree to notices' }));
    await waitFor(() => expect(view.calls('PUT', childEndpoint)).toHaveLength(1));
    expect(within(memberRow('Kim')).getByRole<HTMLButtonElement>('button', { name: 'Edit details' }).disabled).toBe(true);
    expect(within(memberRow('Pat')).getByRole<HTMLButtonElement>('button', { name: 'Agree to notices' }).disabled).toBe(false);
    expect(within(memberRow('Pat')).getByRole<HTMLButtonElement>('button', { name: 'Edit details' }).disabled).toBe(false);
    await user.click(within(memberRow('Pat')).getByRole('button', { name: 'Agree to notices' }));
    await waitFor(() => expect(view.calls('PUT', `/api/portal/members/${ids.payer}/sms-consent`)).toHaveLength(1));
    await act(async () => { write.resolve(); });
  });
  it('keeps the editor draft and re-enables consent after a failed member save', async () => {
    const write = Promise.withResolvers<void>();
    const endpoint = `/api/portal/members/${ids.child}`;
    const view = mount(<PortalHousehold />, async (path, init) => {
      if (path === '/api/portal/household') return { data: household };
      if (path.startsWith('/api/portal/members?')) return page([people[0]!, contactable(people[1]!), people[2]!, people[3]!]);
      if (path === endpoint && init?.method === 'PATCH') { await write.promise; return new Response(null, { status: 503 }); }
      return undefined;
    }, { context: payer });
    const user = userEvent.setup();
    await screen.findByLabelText('Phone');
    await user.click(within(memberRow('Kim')).getByRole('button', { name: 'Edit details' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('First name'), { target: { value: 'Kimberly' } });
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(view.calls('PATCH', endpoint)).toHaveLength(1));
    expect(within(memberRow('Kim')).getByRole<HTMLButtonElement>('button', { name: 'Agree to notices' }).disabled).toBe(true);
    await act(async () => { write.resolve(); });
    expect(await screen.findByText('We couldn\'t save. Check the details and try again.')).toBeDefined();
    await waitFor(() => expect(within(memberRow('Kim')).getByRole<HTMLButtonElement>('button', { name: 'Agree to notices' }).disabled).toBe(false));
    expect((dialog.getByLabelText('First name') as HTMLInputElement).value).toBe('Kimberly');
    expect(screen.getByRole('dialog')).toBeDefined();
  });
  it('shows an adult member only their own profile and consent controls', async () => {
    const view = mount(<PortalHousehold />, path => path === `/api/portal/members/${ids.adult}` ? { data: people[2] } : undefined, { context: adult });
    expect(await screen.findByText(/^Alex Rivera/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();
    expect(screen.queryByLabelText('Household name')).toBeNull();
    expect(view.fetcher.mock.calls.map(([path]) => String(path)).filter(path => path.startsWith('/api/portal/'))).toEqual(['/api/portal/context', `/api/portal/members/${ids.adult}`]);
  });
  it('tells a payer to have the gym add a missing birth date before text consent', async () => {
    mount(<PortalHousehold />, path => path === '/api/portal/household' ? { data: household }
      : path.startsWith('/api/portal/members?') ? page(people) : undefined, { context: payer });
    await screen.findByText('Jordan Rivera');
    const jordan = within(memberRow('Jordan'));
    expect(jordan.getByText("Ask the gym to add Jordan Rivera's date of birth so you can manage their text message consent as their parent or guardian.")).toBeDefined();
    expect(jordan.queryByRole('button', { name: 'Agree to notices' })).toBeNull();
    expect(jordan.queryByRole('button', { name: 'Agree to announcements' })).toBeNull();
    expect(jordan.queryByRole('button', { name: 'Edit details' })).toBeNull();
  });
  it('leaves a child with a recorded birth date their consent controls and no missing birth date text', async () => {
    mount(<PortalHousehold />, path => path === '/api/portal/household' ? { data: household }
      : path.startsWith('/api/portal/members?') ? page(people) : undefined, { context: payer });
    await screen.findByText('Kim Rivera');
    const kim = within(memberRow('Kim'));
    expect(kim.getByRole('button', { name: 'Agree to notices' })).toBeDefined();
    expect(kim.getByRole('button', { name: 'Edit details' })).toBeDefined();
    expect(kim.queryByText(/Ask the gym to add/)).toBeNull();
  });
  it('leaves an adult with a recorded birth date no consent controls and no missing birth date text', async () => {
    mount(<PortalHousehold />, path => path === '/api/portal/household' ? { data: household }
      : path.startsWith('/api/portal/members?') ? page(people) : undefined, { context: payer });
    await screen.findByText('Alex Rivera');
    const alex = within(memberRow('Alex'));
    expect(alex.queryByText(/Ask the gym to add/)).toBeNull();
    expect(alex.queryByRole('button', { name: 'Agree to notices' })).toBeNull();
  });
  it('never asks a payer for their own missing birth date', async () => {
    const withoutPayerBirthDate = people.map((member, index) => index === 0 ? { ...member, dateOfBirth: null } : member);
    mount(<PortalHousehold />, path => path === '/api/portal/household' ? { data: household }
      : path.startsWith('/api/portal/members?') ? page(withoutPayerBirthDate) : undefined, { context: payer });
    await screen.findByText('Pat Rivera');
    const pat = within(memberRow('Pat'));
    expect(pat.getByRole('button', { name: 'Agree to notices' })).toBeDefined();
    expect(pat.queryByText(/Ask the gym to add/)).toBeNull();
  });
  it('never asks a member to have the gym add their own birth date', async () => {
    mount(<PortalHousehold />, path => path === `/api/portal/members/${ids.adult}` ? { data: { ...people[2], dateOfBirth: null } } : undefined, { context: adult });
    expect(await screen.findByRole('button', { name: 'Agree to notices' })).toBeDefined();
    expect(screen.queryByText(/Ask the gym to add/)).toBeNull();
  });
  it('keeps a payer household draft through consent changes and saves it with the latest revision', async () => {
    let current: Household = { ...household, phone: '+12025550123', sms: { phoneValid: true, phoneE164: '+12025550123', notices: null } };
    const view = mount(<PortalHousehold />, (path, init) => {
      if (path === '/api/portal/household/sms-consent' && init?.method === 'PUT') {
        const input = JSON.parse(String(init.body)) as { consent: boolean; revision: number };
        expect(input.revision).toBe(current.revision);
        current = { ...current, revision: current.revision + 1, sms: { ...current.sms,
          notices: input.consent ? { at: '2026-11-16T12:00:00Z', source: 'portal' } : null } };
        return { data: current };
      }
      if (path === '/api/portal/household' && init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body)) as { name: string; revision: number };
        expect(input.revision).toBe(current.revision);
        current = { ...current, name: input.name, revision: current.revision + 1 }; return { data: current };
      }
      if (path === '/api/portal/household') return { data: current };
      return path.startsWith('/api/portal/members?') ? page([]) : undefined;
    }, { context: payer }), user = userEvent.setup();
    const name = await screen.findByLabelText('Household name');
    await user.clear(name); await user.type(name, 'Unsaved household');
    await user.click(await screen.findByRole('button', { name: 'Agree to notices' }));
    await screen.findByRole('button', { name: 'Withdraw notices consent' });
    expect(screen.getByLabelText('Household name')).toBe(name);
    expect((name as HTMLInputElement).value).toBe('Unsaved household');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Withdraw notices consent' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Withdraw notices consent' }));
    await screen.findByRole('button', { name: 'Agree to notices' });
    expect((name as HTMLInputElement).value).toBe('Unsaved household');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    await waitFor(() => expect(save.disabled).toBe(false));
    await user.click(save);
    await screen.findByText('Saved.');
    expect(JSON.parse(String(view.calls('PATCH', '/api/portal/household')[0]![1]!.body))).toEqual({ name: 'Unsaved household', revision: 5 });
  });
  it('requires the payer to save a changed phone before granting notices consent', async () => {
    let current: Household = { ...household, phone: '+12025550123', sms: { phoneValid: true, phoneE164: '+12025550123', notices: null } };
    const endpoint = '/api/portal/household/sms-consent';
    const view = mount(<PortalHousehold />, (path, init) => {
      if (path === '/api/portal/household' && init?.method === 'PATCH') {
        const input = JSON.parse(String(init.body)) as { phone: string; revision: number };
        expect(input).toEqual({ phone: '+12025550199', revision: 3 });
        current = { ...current, phone: input.phone, sms: { ...current.sms, phoneE164: input.phone }, revision: 4 };
      }
      if (path === endpoint && init?.method === 'PUT') {
        current = { ...current, revision: 5, sms: { ...current.sms, notices: { at: '2026-11-16T12:00:00Z', source: 'portal' } } };
        return { data: current };
      }
      if (path === '/api/portal/household') return { data: current };
      return path.startsWith('/api/portal/members?') ? page([]) : undefined;
    }, { context: payer });
    const user = userEvent.setup();
    const phone = await screen.findByLabelText('Phone');
    const agree = screen.getByRole<HTMLButtonElement>('button', { name: 'Agree to notices' });
    const hint = 'Save your phone number before agreeing to text notices.';
    fireEvent.change(phone, { target: { value: ' +12025550123 ' } });
    expect(agree.disabled).toBe(false);
    expect(screen.queryByText(hint)).toBeNull();
    fireEvent.change(phone, { target: { value: ' +12025550199 ' } });
    expect(agree.disabled).toBe(true);
    expect(screen.getByText(hint)).toBeDefined();
    await user.click(agree);
    expect(view.calls('PUT', endpoint)).toHaveLength(0);
    fireEvent.blur(phone); // Leaving the field, as a person does before pressing Save, shows the trimmed number.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(view.calls('GET', '/api/portal/household')).toHaveLength(2);
    expect((phone as HTMLInputElement).value).toBe('+12025550199');
    expect(agree.disabled).toBe(false);
    expect(screen.queryByText(hint)).toBeNull();
    expect(view.calls('PUT', endpoint)).toHaveLength(0);
    await user.click(agree);
    await screen.findByRole('button', { name: 'Withdraw notices consent' });
    const [, init] = view.calls('PUT', endpoint)[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ consent: true, revision: 4 });
    expect(new Headers(init?.headers).get('X-Portal-Household')).toBe(ids.household);
  });
  it('lets a payer withdraw notices and keeps their unsaved phone after refetch', async () => {
    let current: Household = { ...household, phone: '+12025550123', sms: { phoneValid: true, phoneE164: '+12025550123',
      notices: { at: '2026-11-16T12:00:00Z', source: 'portal' } } };
    const endpoint = '/api/portal/household/sms-consent';
    const view = mount(<PortalHousehold />, (path, init) => {
      if (path === endpoint && init?.method === 'PUT') {
        current = { ...current, revision: 4, sms: { ...current.sms, notices: null } };
        return { data: current };
      }
      if (path === '/api/portal/household') return { data: current };
      return path.startsWith('/api/portal/members?') ? page([]) : undefined;
    }, { context: payer });
    const user = userEvent.setup();
    const phone = await screen.findByLabelText<HTMLInputElement>('Phone');
    fireEvent.change(phone, { target: { value: '+12025550199' } });
    const withdraw = screen.getByRole<HTMLButtonElement>('button', { name: 'Withdraw notices consent' });
    const hint = 'Save your phone number before agreeing to text notices.';
    expect(withdraw.disabled).toBe(false);
    expect(screen.queryByText(hint)).toBeNull();
    await user.click(withdraw);
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'Agree to notices' })).disabled).toBe(true);
    expect(screen.getByText(hint)).toBeDefined();
    expect(view.calls('GET', '/api/portal/household')).toHaveLength(2);
    expect(phone.value).toBe('+12025550199');
    expect(view.calls('PATCH', '/api/portal/household')).toHaveLength(0);
    const [, init] = view.calls('PUT', endpoint)[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ consent: false, revision: 3 });
    expect(new Headers(init?.headers).get('X-Portal-Household')).toBe(ids.household);
  });
  it.each([false, true])('pauses household consent during a contact save (notices already granted: %s)', async granted => {
    let current: Household = { ...household, phone: '+12025550123', sms: { phoneValid: true, phoneE164: '+12025550123',
      notices: granted ? { at: '2026-11-16T12:00:00Z', source: 'portal' } : null } };
    const contactSave = Promise.withResolvers<void>(), contactRead = Promise.withResolvers<void>();
    const endpoint = '/api/portal/household', consentEndpoint = endpoint + '/sms-consent';
    const view = mount(<PortalHousehold />, async (path, init) => {
      if (path === endpoint && init?.method === 'PATCH') {
        await contactSave.promise;
        current = { ...current, name: 'New name', revision: 4 };
        return { data: current };
      }
      if (path === endpoint) {
        if (current.revision === 4) await contactRead.promise;
        return { data: current };
      }
      if (path === consentEndpoint && init?.method === 'PUT') {
        current = { ...current, revision: 5, sms: { ...current.sms,
          notices: granted ? null : { at: '2026-11-16T12:00:00Z', source: 'portal' } } };
        return { data: current };
      }
      return path.startsWith('/api/portal/members?') ? page([]) : undefined;
    }, { context: payer });
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Household name');
    const consent = screen.getByRole<HTMLButtonElement>('button', { name: granted ? 'Withdraw notices consent' : 'Agree to notices' });
    expect(consent.disabled).toBe(false);
    fireEvent.change(name, { target: { value: 'New name' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(view.calls('PATCH', endpoint)).toHaveLength(1));
    expect(consent.disabled).toBe(true);
    await user.click(consent);
    expect(view.calls('PUT', consentEndpoint)).toHaveLength(0);
    await act(async () => { contactSave.resolve(); });
    await waitFor(() => expect(view.calls('GET', endpoint)).toHaveLength(2));
    expect(consent.disabled).toBe(true);
    await user.click(consent);
    expect(view.calls('PUT', consentEndpoint)).toHaveLength(0);
    await act(async () => { contactRead.resolve(); });
    await waitFor(() => expect(consent.disabled).toBe(false));
    await user.click(consent);
    await screen.findByRole('button', { name: granted ? 'Agree to notices' : 'Withdraw notices consent' });
    const requests = view.calls('PUT', consentEndpoint);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(String(requests[0]![1]?.body))).toEqual({ consent: !granted, revision: 4 });
  });
  it.each([false, true])('pauses contact Save during billing-phone consent (write fails: %s)', async fails => {
    let current: Household = { ...household, phone: '+12025550123', sms: { phoneValid: true, phoneE164: '+12025550123', notices: null } };
    const consentWrite = Promise.withResolvers<void>(), consentRead = Promise.withResolvers<void>();
    const endpoint = '/api/portal/household', consentEndpoint = endpoint + '/sms-consent';
    const view = mount(<PortalHousehold />, async (path, init) => {
      if (path === consentEndpoint && init?.method === 'PUT') {
        await consentWrite.promise;
        if (fails) return new Response(null, { status: 503 });
        current = { ...current, revision: 4, sms: { ...current.sms, notices: { at: '2026-11-16T12:00:00Z', source: 'portal' } } };
        return { data: current };
      }
      if (path === endpoint && init?.method === 'PATCH') {
        current = { ...current, name: 'My draft', revision: current.revision + 1 };
        return { data: current };
      }
      if (path === endpoint) {
        if (current.revision === 4 && current.sms.notices) await consentRead.promise;
        return { data: current };
      }
      return path.startsWith('/api/portal/members?') ? page([]) : undefined;
    }, { context: payer });
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Household name');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    fireEvent.change(name, { target: { value: 'My draft' } });
    await user.click(screen.getByRole('button', { name: 'Agree to notices' }));
    await waitFor(() => expect(view.calls('PUT', consentEndpoint)).toHaveLength(1));
    expect(JSON.parse(String(view.calls('PUT', consentEndpoint)[0]![1]?.body))).toEqual({ consent: true, revision: 3 });
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.form!);
    expect(view.calls('PATCH', endpoint)).toHaveLength(0);
    await act(async () => { consentWrite.resolve(); });
    if (fails) {
      await screen.findByText('Consent could not be saved. Refresh and try again.');
    } else {
      await waitFor(() => expect(view.calls('GET', endpoint)).toHaveLength(2));
      expect(save.disabled).toBe(true);
      fireEvent.submit(save.form!);
      expect(view.calls('PATCH', endpoint)).toHaveLength(0);
      await act(async () => { consentRead.resolve(); });
    }
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(view.calls('PATCH', endpoint)).toHaveLength(0);
    await user.click(save);
    await screen.findByText('Saved.');
    expect(JSON.parse(String(view.calls('PATCH', endpoint)[0]![1]?.body))).toEqual({ name: 'My draft', revision: fails ? 3 : 4 });
  });
  it.each([false, true])('retains later edits after a household save (concurrent change: %s)', async concurrent => {
    let current: Household = household;
    const firstSave = Promise.withResolvers<void>();
    const endpoint = '/api/portal/household';
    const view = mount(<PortalHousehold />, async (path, init) => {
      if (path === endpoint && init?.method === 'PATCH') {
        const { revision, ...changes } = JSON.parse(String(init.body)) as { name: string; phone?: string; revision: number };
        expect(revision).toBe(current.revision);
        if (revision === 3) await firstSave.promise;
        const saved = { ...current, ...changes, revision: revision + 1 };
        current = concurrent && revision === 3 ? { ...saved, name: 'Another save', revision: 5 } : saved;
        return { data: saved };
      }
      if (path === endpoint) return { data: current };
      return path.startsWith('/api/portal/members?') ? page([]) : undefined;
    }, { context: payer });
    const user = userEvent.setup();
    const name = await screen.findByLabelText<HTMLInputElement>('Household name');
    const phone = screen.getByLabelText<HTMLInputElement>('Phone');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    fireEvent.change(name, { target: { value: 'First edit' } });
    await user.click(save);
    await waitFor(() => expect(view.calls('PATCH', endpoint)).toHaveLength(1));
    expect(JSON.parse(String(view.calls('PATCH', endpoint)[0]![1]!.body))).toEqual({ name: 'First edit', revision: 3 });
    fireEvent.change(phone, { target: { value: '+12025550199' } });
    fireEvent.change(name, { target: { value: 'Later edit' } });
    await act(async () => { firstSave.resolve(); });
    await screen.findByText('Saved.');
    expect(name.value).toBe('Later edit');
    expect(phone.value).toBe('+12025550199');
    await waitFor(() => expect(save.disabled).toBe(false));
    await user.click(save);
    if (concurrent) {
      await screen.findByText('These details changed while you were editing. Discard your edits to load the latest details.');
      expect(view.calls('PATCH', endpoint)).toHaveLength(1);
      expect(name.value).toBe('Later edit');
      expect(phone.value).toBe('+12025550199');
      await user.click(screen.getByRole('button', { name: 'Discard edits' }));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
      expect(name.value).toBe('Another save');
      expect(phone.value).toBe('');
      fireEvent.change(name, { target: { value: 'New edit' } });
      await user.click(save);
      await screen.findByText('Saved.');
      expect(JSON.parse(String(view.calls('PATCH', endpoint)[1]![1]!.body))).toEqual({ name: 'New edit', revision: 5 });
    } else {
      await waitFor(() => expect(view.calls('PATCH', endpoint)).toHaveLength(2));
      expect(JSON.parse(String(view.calls('PATCH', endpoint)[1]![1]!.body))).toEqual({ name: 'Later edit', phone: '+12025550199', revision: 4 });
      await screen.findByText('Saved.');
    }
  });
  it('reports a failed discard, pauses billing-phone consent while refreshing, and retries with the latest contact details', async () => {
    let current: Household = { ...household, phone: '+12025550123', sms: { phoneValid: true, phoneE164: '+12025550123', notices: null } };
    const failedRead = Promise.withResolvers<Response>(), retryRead = Promise.withResolvers<{ data: Household }>();
    let heldRead: Promise<Response | { data: Household }> | undefined;
    const endpoint = '/api/portal/household', consentEndpoint = endpoint + '/sms-consent';
    const failureText = "We couldn't save. Check the details and try again.";
    const view = mount(<PortalHousehold />, (path, init) => {
      if (path === endpoint && init?.method === 'PATCH') {
        const { revision, ...changes } = JSON.parse(String(init.body)) as { revision: number; email?: string };
        if (revision !== current.revision) {
          return Response.json({ error: { code: 'conflict' } }, { status: 409 });
        }
        current = { ...current, ...changes, revision: revision + 1 };
        return { data: current };
      }
      if (path === endpoint) {
        if (heldRead) {
          const response = heldRead;
          heldRead = undefined;
          return response;
        }
        return { data: current };
      }
      if (path === consentEndpoint && init?.method === 'PUT') {
        current = { ...current, revision: 5, sms: { ...current.sms, notices: { at: '2026-11-16T12:00:00Z', source: 'portal' } } };
        return { data: current };
      }
      return path.startsWith('/api/portal/members?') ? page([]) : undefined;
    }, { context: payer });
    const user = userEvent.setup();
    const name = await screen.findByLabelText<HTMLInputElement>('Household name');
    const email = screen.getByLabelText<HTMLInputElement>('Email');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    fireEvent.change(name, { target: { value: 'My draft' } });
    fireEvent.change(email, { target: { value: 'draft@example.test' } });
    current = { ...current, name: 'Saved elsewhere', email: 'new@example.test', revision: 4 };
    await user.click(save);
    const discard = await screen.findByRole<HTMLButtonElement>('button', { name: 'Discard edits' });
    expect(view.calls('PATCH', endpoint)).toHaveLength(1);
    heldRead = failedRead.promise;
    await user.click(discard);
    await waitFor(() => expect(view.calls('GET', endpoint)).toHaveLength(2));
    expect(discard.disabled).toBe(true);
    await user.click(discard);
    expect(view.calls('GET', endpoint)).toHaveLength(2);
    await act(async () => { failedRead.resolve(new Response(null, { status: 503 })); });
    expect(await screen.findByText(failureText)).toBeDefined();
    await waitFor(() => expect(discard.disabled).toBe(false));
    expect(name.value).toBe('My draft');
    expect(email.value).toBe('draft@example.test');
    expect(discard.closest('[role="alert"]')?.textContent).toContain('These details changed while you were editing.');
    const consent = screen.getByRole<HTMLButtonElement>('button', { name: 'Agree to notices' });
    expect(consent.disabled).toBe(false);
    heldRead = retryRead.promise;
    await user.click(discard);
    await waitFor(() => expect(view.calls('GET', endpoint)).toHaveLength(3));
    expect(screen.queryByText(failureText)).toBeNull();
    expect(name.value).toBe('My draft');
    expect(consent.disabled).toBe(true);
    await user.click(consent);
    expect(view.calls('PUT', consentEndpoint)).toHaveLength(0);
    await act(async () => { retryRead.resolve({ data: current }); });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(name.value).toBe('Saved elsewhere');
    expect(email.value).toBe('new@example.test');
    await waitFor(() => expect(consent.disabled).toBe(false));
    await user.click(consent);
    await screen.findByRole('button', { name: 'Withdraw notices consent' });
    expect(JSON.parse(String(view.calls('PUT', consentEndpoint)[0]![1]?.body))).toEqual({ consent: true, revision: 4 });
    fireEvent.change(email, { target: { value: 'retry@example.test' } });
    await waitFor(() => expect(save.disabled).toBe(false));
    await user.click(save);
    await screen.findByText('Saved.');
    expect(JSON.parse(String(view.calls('PATCH', endpoint)[1]![1]!.body))).toEqual({ email: 'retry@example.test', revision: 5 });
  });
  it('rebases later edits on the saved household when the refetch after a save fails', async () => {
    let current: Household = household, failRead = false;
    const firstSave = Promise.withResolvers<void>();
    const endpoint = '/api/portal/household';
    const view = mount(<PortalHousehold />, async (path, init) => {
      if (path === endpoint && init?.method === 'PATCH') {
        const { revision, ...changes } = JSON.parse(String(init.body)) as { name?: string; phone?: string; revision: number };
        expect(revision).toBe(current.revision);
        if (revision === 3) { await firstSave.promise; failRead = true; }
        current = { ...current, ...changes, revision: revision + 1 };
        return { data: current };
      }
      if (path === endpoint && failRead) { failRead = false; return new Response(null, { status: 500 }); }
      if (path === endpoint) return { data: current };
      return path.startsWith('/api/portal/members?') ? page([]) : undefined;
    }, { context: payer });
    const user = userEvent.setup();
    const name = await screen.findByLabelText<HTMLInputElement>('Household name');
    const phone = screen.getByLabelText<HTMLInputElement>('Phone');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    fireEvent.change(name, { target: { value: 'First edit' } });
    await user.click(save);
    await waitFor(() => expect(view.calls('PATCH', endpoint)).toHaveLength(1));
    fireEvent.change(phone, { target: { value: '+12025550199' } });
    await act(async () => { firstSave.resolve(); });
    await screen.findByText('Saved.');
    expect(view.calls('GET', endpoint)).toHaveLength(2);
    expect(phone.value).toBe('+12025550199');
    await act(async () => { await view.cache.invalidateQueries(); });
    await waitFor(() => expect(name.value).toBe('First edit'));
    expect(phone.value).toBe('+12025550199');
    await user.click(save);
    await waitFor(() => expect(view.calls('PATCH', endpoint)).toHaveLength(2));
    expect(JSON.parse(String(view.calls('PATCH', endpoint)[1]![1]!.body))).toEqual({ phone: '+12025550199', revision: 4 });
    expect(screen.queryByRole('button', { name: 'Discard edits' })).toBeNull();
  });
  it('drops a country chosen with an empty phone when discarding edits', async () => {
    let current: Household = household;
    const endpoint = '/api/portal/household';
    const view = mount(<PortalHousehold />, (path, init) => {
      if (path === endpoint && init?.method === 'PATCH') {
        const { revision, ...changes } = JSON.parse(String(init.body)) as { name?: string; phone?: string; revision: number };
        if (revision !== current.revision) return Response.json({ error: { code: 'conflict' } }, { status: 409 });
        current = { ...current, ...changes, revision: revision + 1 };
        return { data: current };
      }
      if (path === endpoint) return { data: current };
      return path.startsWith('/api/portal/members?') ? page([]) : undefined;
    }, { context: payer, country: 'CA' });
    const user = userEvent.setup();
    const name = await screen.findByLabelText<HTMLInputElement>('Household name');
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Country code' });
    const phone = screen.getByLabelText<HTMLInputElement>('Phone');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    expect(select.value).toBe('CA');
    fireEvent.change(name, { target: { value: 'Draft name' } });
    current = { ...current, name: 'Saved elsewhere', revision: 4 };
    await user.click(save);
    const discard = await screen.findByRole('button', { name: 'Discard edits' });
    await user.selectOptions(select, 'GB');
    expect(select.value).toBe('GB');
    await user.click(discard);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(select.value).toBe('CA');
    await user.type(phone, '604 555 0100');
    await user.click(save);
    await screen.findByText('Saved.');
    expect(JSON.parse(String(view.calls('PATCH', endpoint)[1]![1]!.body))).toEqual({ phone: '+1 604 555 0100', revision: 4 });
  });
  it('drops a country chosen with an empty phone after a save with no phone', async () => {
    let current: Household = household;
    const endpoint = '/api/portal/household';
    const view = mount(<PortalHousehold />, (path, init) => {
      if (path === endpoint && init?.method === 'PATCH') {
        const { revision, ...changes } = JSON.parse(String(init.body)) as { name?: string; phone?: string; revision: number };
        current = { ...current, ...changes, revision: revision + 1 };
        return { data: current };
      }
      if (path === endpoint) return { data: current };
      return path.startsWith('/api/portal/members?') ? page([]) : undefined;
    }, { context: payer, country: 'CA' });
    const user = userEvent.setup();
    const name = await screen.findByLabelText<HTMLInputElement>('Household name');
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Country code' });
    const phone = screen.getByLabelText<HTMLInputElement>('Phone');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    await user.selectOptions(select, 'GB');
    expect(select.value).toBe('GB');
    // Save with no changes (draft.reset branch).
    await user.click(save);
    await screen.findByText('Nothing changed.');
    expect(select.value).toBe('CA');
    // Also check saving another field with no phone (reconcileSaved branch).
    await user.selectOptions(select, 'GB');
    expect(select.value).toBe('GB');
    fireEvent.change(name, { target: { value: 'Updated household' } });
    await user.click(save);
    await screen.findByText('Saved.');
    expect(select.value).toBe('CA');
    await user.type(phone, '604 555 0100');
    await user.click(save);
    await screen.findByText('Saved.');
    expect(JSON.parse(String(view.calls('PATCH', endpoint)[1]![1]!.body))).toEqual({ phone: '+1 604 555 0100', revision: 4 });
  });
  it('keeps a country picked with no number while a household save is in flight', async () => {
    let current: Household = household;
    const patchWrite = Promise.withResolvers<void>();
    const endpoint = '/api/portal/household';
    mount(<PortalHousehold />, async (path, init) => {
      if (path === endpoint && init?.method === 'PATCH') {
        await patchWrite.promise;
        const { revision, ...changes } = JSON.parse(String(init.body)) as { name?: string; revision: number };
        current = { ...current, ...changes, revision: revision + 1 };
        return { data: current };
      }
      if (path === endpoint) return { data: current };
      return path.startsWith('/api/portal/members?') ? page([]) : undefined;
    }, { context: payer, country: 'CA' });
    const user = userEvent.setup();
    const name = await screen.findByLabelText<HTMLInputElement>('Household name');
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Country code' });
    fireEvent.change(name, { target: { value: 'Updated household' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.selectOptions(select, 'GB');
    expect(select.value).toBe('GB');
    await act(async () => { patchWrite.resolve(); });
    await screen.findByText('Saved.');
    expect(select.value).toBe('GB');
  });
  it('keeps a carrier-kept number typed under another country while a household save is in flight and sends it on the next save', async () => {
    let current: Household = household;
    const patchWrite = Promise.withResolvers<void>();
    const endpoint = '/api/portal/household';
    const view = mount(<PortalHousehold />, async (path, init) => {
      if (path === endpoint && init?.method === 'PATCH') {
        const { revision, ...changes } = JSON.parse(String(init.body)) as { name?: string; phone?: string; revision: number };
        if (revision === 3) await patchWrite.promise;
        current = { ...current, ...changes, revision: revision + 1 };
        return { data: current };
      }
      if (path === endpoint) return { data: current };
      return path.startsWith('/api/portal/members?') ? page([]) : undefined;
    }, { context: payer, country: 'CA' });
    const user = userEvent.setup();
    const name = await screen.findByLabelText<HTMLInputElement>('Household name');
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Country code' });
    const phone = screen.getByLabelText<HTMLInputElement>('Phone');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    fireEvent.change(name, { target: { value: 'Updated household' } });
    await user.click(save);
    await waitFor(() => expect(view.calls('PATCH', endpoint)).toHaveLength(1));
    await user.selectOptions(select, 'BR');
    await user.type(phone, '0021 44 20 7946 0018');
    await act(async () => { patchWrite.resolve(); });
    await screen.findByText('Saved.');
    expect(select.value).toBe('BR');
    expect(phone.value).toBe('0021 44 20 7946 0018');
    await waitFor(() => expect(save.disabled).toBe(false));
    await user.click(save);
    await waitFor(() => expect(view.calls('PATCH', endpoint)).toHaveLength(2));
    expect(JSON.parse(String(view.calls('PATCH', endpoint)[1]![1]!.body))).toEqual({ phone: '0021 44 20 7946 0018', revision: 4 });
  });
  it('saves and withdraws each adult SMS choice with the profile revision and open household', async () => {
    let current: PortalMember = { ...people[2]!, status: 'active', phone: '+12025550123', sms: { phoneValid: true, phoneE164: '+12025550123', notices: null, announcements: null } };
    const endpoint = `/api/portal/members/${ids.adult}/sms-consent`;
    const view = mount(<PortalHousehold />, (path, init) => {
      if (path === endpoint && init?.method === 'PUT') {
        const input = JSON.parse(String(init.body)) as { kind: 'notices' | 'announcements'; consent: boolean; revision: number };
        expect(input.revision).toBe(current.revision);
        current = { ...current, revision: current.revision + 1, sms: { ...current.sms,
          [input.kind]: input.consent ? { at: '2026-11-16T12:00:00Z', source: 'portal' } : null } };
        return { data: current };
      }
      return path === `/api/portal/members/${ids.adult}` ? { data: current } : undefined;
    }, { context: adult }), user = userEvent.setup();
    for (const kind of ['notices', 'announcements']) {
      const agree = await screen.findByRole('button', { name: 'Agree to ' + kind });
      await waitFor(() => expect((agree as HTMLButtonElement).disabled).toBe(false));
      await user.click(agree);
      const withdraw = await screen.findByRole('button', { name: 'Withdraw ' + kind + ' consent' });
      await waitFor(() => expect((withdraw as HTMLButtonElement).disabled).toBe(false));
      await user.click(withdraw);
      await waitFor(() => expect(current.sms[kind as 'notices' | 'announcements']).toBeNull());
      await screen.findByRole('button', { name: 'Agree to ' + kind });
    }
    expect(view.calls('PUT', endpoint)).toHaveLength(4);
    for (const [, init] of view.calls('PUT', endpoint)) expect(new Headers(init?.headers).get('X-Portal-Household')).toBe(ids.household);
    expect(view.calls('GET', '/api/portal/household')).toHaveLength(0);
    expect(view.calls('GET', '/api/portal/members')).toHaveLength(0);
  });
  it('never shows an answer for another household than the open one, and reads the household lists again', async () => {
    const view = mount(<PortalHousehold />, path => {
      if (path === '/api/portal/household') return { data: household };
      if (path.startsWith('/api/portal/members?')) return page(people);
      return undefined;
    }, { context: payer, answeredFor: id(99) });
    await waitFor(() => expect(view.calls('GET', '/api/portal/households').length).toBeGreaterThan(0));
    expect((await screen.findAllByRole('button', { name: 'Try again' })).length).toBeGreaterThan(0);
    expect(screen.queryByText('Rivera household')).toBeNull();
    expect(screen.queryByText(/^Kim Rivera/)).toBeNull();
    expect(view.stored().map(query => query.queryKey.slice(5))).toEqual([['context']]);
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
