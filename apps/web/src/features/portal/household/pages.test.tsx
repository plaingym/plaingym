// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { PortalContext } from '@plaingym/shared/contracts';
import { ShellServicesContext } from '../../../app/context.js';
import type { ShellServices } from '../../../app/services.js';
import { PortalBillingPage } from '../billing/page.js';
import { PortalWaivers } from '../waivers/page.js';
import { PortalHousehold } from './page.js';
import { PortalSchedulePage } from '../schedule/page.js';
import { PortalCheckinPage } from '../checkin/page.js';
import { PortalProgressPage } from '../progress/page.js';
import { gymToday, knownMinor, needsGuardian, portalHouseholdKey, portalLoginKey, usePortalScope } from './api.js';
import { PortalRecoveryNotice } from './recovery.js';
import { portalTestCache } from './test-cache.test-helper.js';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ids = { gym: id(1), user: id(2), household: id(3), payer: id(4), child: id(5), adult: id(6), invoice: id(7), paid: id(8), card: id(9), template: id(10), signature: id(11) };
const payer: PortalContext = { role: 'payer', memberId: ids.payer };
const adult: PortalContext = { role: 'member', memberId: ids.adult };
const household = { id: ids.household, name: 'Rivera household', email: 'payer@example.test', phone: null, address: { line1: '1 Main St' }, billingDay: 1, revision: 3 };
const person = (memberId: string, firstName: string, dateOfBirth: string | null) => ({ id: memberId, firstName, lastName: 'Rivera', email: null, phone: null,
  dateOfBirth, photoKey: null, status: 'active', emergencyContacts: [{ name: 'Grandparent', relationship: null, phone: '555-0100' }], revision: 1 });
const people = [person(ids.payer, 'Pat', '1980-04-02'), person(ids.child, 'Kim', '2016-06-01'), person(ids.adult, 'Alex', '1990-01-01'), person(id(12), 'Jordan', null)];
const page = <T,>(data: T[]) => ({ data, pagination: { limit: 100, offset: 0, total: data.length } });
type Handler = (path: string, init?: RequestInit) => unknown;
function PageHost({ children }: { children: ReactNode }) {
  const scope = usePortalScope();
  return <><PortalRecoveryNotice /><div key={scope.key[4]}>{children}</div></>;
}
/**
 * Renders a page with the API answered by `handle`. Every portal answer names the household it was read for, `answeredFor`
 * (the open household unless a test says otherwise); the household lists, which the pages read again after an answer for
 * another household, keep naming the open one.
 */
function mount(element: ReactNode, handle: Handler, { context, answeredFor, householdLists }: { context?: PortalContext; answeredFor?: string; householdLists?: () => Promise<Response> } = {}) {
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
    // The role comes from the open household; the page's own reads are what a test may answer for another one.
    if (path === '/api/portal/context' && context) return Response.json({ data: context, householdId: current });
    const result = handle(path, init);
    return result instanceof Response ? result : result === undefined ? new Response(null, { status: 404 }) : Response.json({ ...result as object, householdId: answeredFor ?? current });
  });
  vi.stubGlobal('fetch', fetcher);
  const services: ShellServices = { loadBootstrap: async () => ({ gym: { id: ids.gym, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
    session: { userId: ids.user, displayName: 'Test User', roles: [], member: true }, login: { password: true, magicLink: false } }), signOut: vi.fn(), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  const cache = portalTestCache(ids.gym, ids.user, ids.household, { defaultOptions: { queries: { retry: false } } });
  render(<ShellServicesContext.Provider value={services}><QueryClientProvider client={cache}><PageHost>{element}</PageHost></QueryClientProvider></ShellServicesContext.Provider>);
  const calls = (method: string, path: string) => fetcher.mock.calls.filter(([url, init]) => String(url).split('?')[0] === path && (init?.method ?? 'GET') === method);
  /** Nothing is cached under the open household's key: an answer for another household was never stored. */
  const stored = () => cache.getQueryCache().findAll({ queryKey: portalHouseholdKey(portalLoginKey(ids.gym, ids.user), ids.household) }).filter(query => query.state.data !== undefined);
  return { fetcher, calls, stored, cache };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
    expect(await screen.findByText('This invoice settles on its due date. No payment is needed.')).toBeDefined();
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
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(2));
    expect(screen.queryByText('Invoice #7')).toBeNull();
    expect(screen.queryByText(/•••• 4242/)).toBeNull();
    expect(view.stored()).toEqual([]);
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
  it('lets an adult member sign their own waiver through the self routes', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), fillText: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,YQ==');
    const view = mount(<PortalWaivers />, (path, init) => {
      if (path === `/api/portal/members/${ids.adult}`) return { data: people[2] };
      if (path.startsWith('/api/portal/waivers/pending')) return page([{ memberId: ids.adult, template }]);
      if (path.startsWith('/api/portal/waivers?')) return page([]);
      if (path === '/api/portal/waivers/signature-images') return image;
      if (path === '/api/portal/waivers' && init?.method === 'POST') return { data: { ...signature, memberId: ids.adult } };
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
    // Another adult signs from their own login; the payer is offered only the child's document.
    expect(screen.getAllByRole('button', { name: 'Review and sign' })).toHaveLength(1);
    expect(screen.getAllByText(/Adults sign their own documents/)).toHaveLength(2);
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
    const view = mount(<PortalHousehold />, path => path === `/api/portal/members/${ids.adult}` ? { data: people[2] } : undefined, { context: adult });
    expect(await screen.findByText(/^Alex Rivera/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Edit details' })).toBeNull();
    expect(screen.queryByLabelText('Household name')).toBeNull();
    expect(view.fetcher.mock.calls.map(([path]) => String(path)).filter(path => path.startsWith('/api/portal/'))).toEqual(['/api/portal/context', `/api/portal/members/${ids.adult}`]);
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
