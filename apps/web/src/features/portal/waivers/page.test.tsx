// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CatchBoundary } from '@tanstack/react-router';
import { RootError } from '../../../routes/__root.js';
import { dateLabel } from '../../../lib/instant.js';
import type { PortalContext, WaiverTemplate } from '@plaingym/shared/contracts';
import { SignWaiver, PortalWaivers } from './page.js';
import { ShellServicesContext } from '../../../app/context.js';
import type { ShellServices } from '../../../app/services.js';
import type { PortalScope } from '../household/api.js';
import { portalTestCache } from '../household/test-cache.test-helper.js';
import type { PortalWaiverEndpoints } from './endpoints.js';

const template: WaiverTemplate = {
  id: '01900000-0000-7000-8000-000000000001', name: 'Participation', kind: 'waiver', version: 1,
  body: 'Terms', retiredAt: null, createdAt: '2026-11-18T12:00:00Z',
};
const member = { id: '01900000-0000-7000-8000-000000000002', firstName: 'Ava', lastName: 'Chen', dateOfBirth: '1990-01-01' };
const scope = {
  key: ['portal', 'gym', 'user', 'household', 'household'] as const,
  ready: true, moving: false, refreshing: false, settling: false,
  own: <T extends { householdId: string }>(answer: T) => answer,
  call: vi.fn(),
} as unknown as PortalScope;

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('keeps the signature pad dark ink on white in either theme', () => {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <SignWaiver template={template} member={member} minor={false} endpoints={{} as PortalWaiverEndpoints} scope={scope}
      close={() => undefined} saved={async () => undefined} />
  </QueryClientProvider>);
  const canvas = document.querySelector('canvas');
  expect(canvas).not.toBeNull();
  expect(canvas!.classList.contains('bg-white')).toBe(true);
});

it('asks before discarding a started signature through the dialog Close button', async () => {
  const close = vi.fn(), user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <SignWaiver template={template} member={member} minor={false} endpoints={{} as PortalWaiverEndpoints} scope={scope}
      close={close} saved={async () => undefined} />
  </QueryClientProvider>);
  const dialog = screen.getByRole('dialog'), form = within(dialog), signer = form.getByLabelText('Your full name');
  await user.type(signer, 'Ava Chen');
  await user.click(form.getAllByRole('button', { name: 'Close' }).at(-1)!);
  expect(form.getByText('Discard your unsaved changes?')).toBeDefined();
  expect(close).not.toHaveBeenCalled();
  await user.click(form.getByRole('button', { name: 'Keep editing' }));
  expect((signer as HTMLInputElement).value).toBe('Ava Chen');
  expect(screen.getByRole('dialog')).toBe(dialog);
});

const portalIds = { gym: '00000000-0000-7000-8000-000000000001', user: '00000000-0000-7000-8000-000000000002',
  household: '00000000-0000-7000-8000-000000000003', payer: '00000000-0000-7000-8000-000000000004',
  child: '00000000-0000-7000-8000-000000000005', adult: '00000000-0000-7000-8000-000000000006' };
const portalTemplate: WaiverTemplate = { id: '00000000-0000-7000-8000-000000000007', name: 'Participation', kind: 'waiver', version: 1,
  body: 'Terms', retiredAt: null, createdAt: '2026-11-18T12:00:00Z' };
const payerContext: PortalContext = { role: 'payer', memberId: portalIds.payer };
const adultContext: PortalContext = { role: 'member', memberId: portalIds.adult };
const bornYearsAgo = (years: number) => `${new Date().getUTCFullYear() - years}-01-01`;
const portalPerson = (memberId: string, firstName: string, lastName: string, dateOfBirth: string | null) => ({ id: memberId, firstName, lastName,
  email: null, phone: null, sms: { phoneValid: false, phoneE164: null, notices: null, announcements: null }, dateOfBirth, photoKey: null,
  status: 'active', emergencyContacts: [], revision: 1 });
const pageOf = <T,>(data: T[]) => ({ data, pagination: { limit: 100, offset: 0, total: data.length } });
/** Renders the portal waivers page on its own with the household's lists already loaded, as the shell leaves them. */
function mountWaivers(context: PortalContext, people: ReturnType<typeof portalPerson>[], pending: { memberId: string; template: WaiverTemplate }[],
  signed: unknown[] = []) {
  vi.stubGlobal('scrollTo', vi.fn());
  const answer = <T,>(data: T) => Response.json({ data, householdId: portalIds.household });
  const pageAnswer = <T,>(data: T[]) => Response.json({ ...pageOf(data), householdId: portalIds.household });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const path = String(input);
    if (path === '/api/portal/households') return Response.json({ data: { current: portalIds.household,
      households: [{ householdId: portalIds.household, name: 'Test household', role: context.role }] } });
    if (path === '/api/portal/context') return answer(context);
    if (path.startsWith('/api/portal/members?')) return pageAnswer(people);
    if (path.startsWith('/api/portal/household/waivers/pending')) return pageAnswer(pending);
    if (path.startsWith('/api/portal/household/waivers')) return pageAnswer(signed);
    if (path === `/api/portal/members/${context.memberId}`) return answer(people.find(person => person.id === context.memberId)!);
    if (path.startsWith('/api/portal/waivers/pending')) return pageAnswer(pending);
    if (path.startsWith('/api/portal/waivers')) return pageAnswer([]);
    return new Response(null, { status: 404 });
  }));
  const services: ShellServices = { loadBootstrap: async () => ({ gym: { id: portalIds.gym, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
    session: { userId: portalIds.user, displayName: 'Test User', roles: [], member: true }, login: { password: true, magicLink: false } }),
    signOut: vi.fn(), signInWithPassword: vi.fn(), requestMagicLink: vi.fn() };
  const cache = portalTestCache(portalIds.gym, portalIds.user, portalIds.household, { defaultOptions: { queries: { retry: false } } });
  // The app's root route shows `RootError` for a page that throws while rendering.
  render(<ShellServicesContext.Provider value={services}><QueryClientProvider client={cache}>
    <CatchBoundary getResetKey={() => 'waivers'} errorComponent={RootError}><PortalWaivers /></CatchBoundary>
  </QueryClientProvider></ShellServicesContext.Provider>);
}
/** A signed copy as the API answers it, with the stored snapshot text changed by `change`. */
function signedRow(change: (snapshot: Record<string, unknown> & { member: Record<string, unknown> }) => void) {
  const snapshot = { template: { id: portalTemplate.id, name: portalTemplate.name, kind: 'waiver', version: 1, body: 'Terms' },
    member: { id: portalIds.payer, firstName: 'Pat', lastName: 'Payer', dateOfBirth: '1980-01-01' },
    signer: { kind: 'self', name: 'Pat Payer' }, signedAt: '2026-11-18T12:00:00Z',
    signatureImage: { key: 'gym/signature.png', hash: 'a'.repeat(64) } };
  change(snapshot);
  return { id: '00000000-0000-7000-8000-000000000008', templateId: portalTemplate.id, memberId: portalIds.payer, snapshot: JSON.stringify(snapshot),
    snapshotHash: 'b'.repeat(64), signatureImageKey: 'gym/signature.png', signatureImageHash: 'a'.repeat(64), signedAt: '2026-11-18T12:00:00Z' };
}
it('shows a signed copy whose snapshot has keys this version does not know', async () => {
  mountWaivers(payerContext, [portalPerson(portalIds.payer, 'Pat', 'Payer', '1980-01-01')], [],
    [signedRow(snapshot => { snapshot.futureField = 'x'; snapshot.member.preferredName = 'Al'; })]);
  expect(await screen.findByText('Participation · Version 1')).toBeDefined();
  expect(screen.getByText('Pat Payer · Signed by Pat Payer')).toBeDefined();
  expect(document.querySelector('time')!.dateTime).toBe('2026-11-18T12:00:00Z');
  expect(document.querySelector('time')!.textContent).toBe(dateLabel('2026-11-18T12:00:00Z', 'UTC'));
});
it('shows the page error for a signed copy whose snapshot lacks its signing time', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  mountWaivers(payerContext, [portalPerson(portalIds.payer, 'Pat', 'Payer', '1980-01-01')], [],
    [signedRow(snapshot => { delete snapshot.signedAt; })]);
  expect(await screen.findByRole('heading', { name: 'Something went wrong. Please try again.' })).toBeDefined();
  expect(screen.queryByText('Participation · Version 1')).toBeNull();
});
const ownLogin = 'Adults sign their own documents, from their own login or at the gym.';

it('asks a payer to have the gym add a child\'s missing birth date and offers no signature', async () => {
  mountWaivers(payerContext, [portalPerson(portalIds.payer, 'Pat', 'Payer', '1980-01-01'), portalPerson(portalIds.child, 'Sam', 'Lee', null)],
    [{ memberId: portalIds.child, template: portalTemplate }, { memberId: portalIds.payer, template: portalTemplate }]);
  expect(await screen.findByText("Ask the gym to add Sam Lee's date of birth so you can sign for them as their parent or guardian.")).toBeDefined();
  expect(screen.getAllByRole('button', { name: 'Review and sign' })).toHaveLength(1);
  const row = screen.getByText(/^Sam Lee ·/).closest('li')!;
  expect(within(row).queryByRole('button', { name: 'Review and sign' })).toBeNull();
});
it('tells a payer that a recorded adult signs their own document', async () => {
  mountWaivers(payerContext, [portalPerson(portalIds.payer, 'Pat', 'Payer', '1980-01-01'), portalPerson(portalIds.adult, 'Alex', 'Rivera', bornYearsAgo(30))],
    [{ memberId: portalIds.adult, template: portalTemplate }]);
  expect(await screen.findByText(ownLogin)).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Review and sign' })).toBeNull();
  expect(screen.queryByText(/Ask the gym/)).toBeNull();
});
it('offers a payer the signature for a recorded child', async () => {
  mountWaivers(payerContext, [portalPerson(portalIds.payer, 'Pat', 'Payer', '1980-01-01'), portalPerson(portalIds.child, 'Sam', 'Lee', bornYearsAgo(10))],
    [{ memberId: portalIds.child, template: portalTemplate }]);
  expect(await screen.findByRole('button', { name: 'Review and sign' })).toBeDefined();
  expect(screen.queryByText(ownLogin)).toBeNull();
});
it('offers a payer the signature for their own document without a birth date', async () => {
  mountWaivers(payerContext, [portalPerson(portalIds.payer, 'Pat', 'Payer', null)], [{ memberId: portalIds.payer, template: portalTemplate }]);
  expect(await screen.findByRole('button', { name: 'Review and sign' })).toBeDefined();
  expect(screen.queryByText(/Ask the gym/)).toBeNull();
});
it('offers a non-payer adult their own signature without the payer line', async () => {
  mountWaivers(adultContext, [portalPerson(portalIds.adult, 'Alex', 'Rivera', bornYearsAgo(30))], [{ memberId: portalIds.adult, template: portalTemplate }]);
  expect(await screen.findByRole('button', { name: 'Review and sign' })).toBeDefined();
  expect(screen.queryByText(ownLogin)).toBeNull();
  expect(screen.queryByText(/Ask the gym/)).toBeNull();
});
