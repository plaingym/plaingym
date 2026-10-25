// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Templates, MemberWaivers } from './screens.js';
import { createWaiversClient } from './api.js';
const template = { id: '01900000-0000-7000-8000-000000000001', name: 'Participation', kind: 'waiver', version: 2, body: 'Original text', retiredAt: null, createdAt: '2026-10-24T12:00:00Z' };
function fixture() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const path = String(url);
    if (init?.method === 'POST') return Response.json({ error: { code: 'conflict', message: 'Template changed; reload before saving' } }, { status: 409 });
    return Response.json({ data: path.includes('templates') ? [template] : [], pagination: { limit: 20, offset: 0, total: path.includes('templates') ? 1 : 0 } });
  });
  return { fetcher, client: createWaiversClient(fetcher) };
}
function mount(element: React.ReactNode) { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{element}</QueryClientProvider>); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('edits in the shared dialog and preserves the draft on a stale save', async () => {
  const f = fixture(), user = userEvent.setup(); mount(<Templates gymId="gym" manage client={f.client} />);
  await user.click(await screen.findByRole('button', { name: 'Edit template' }));
  const dialog = screen.getByRole('dialog'), body = within(dialog).getByLabelText('Agreement text');
  await user.clear(body); await user.type(body, 'Changed terms'); await user.click(within(dialog).getByRole('button', { name: 'Publish version' }));
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Template changed; reload before saving'); expect((body as HTMLTextAreaElement).value).toBe('Changed terms');
  const call = f.fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(String(call[1]?.body))).toEqual({ name: template.name, kind: 'waiver', body: 'Changed terms', expectedVersion: 2 });
});
it('shows unsigned state and guardian fields after reviewing the exact current text', async () => {
  const f = fixture(), user = userEvent.setup(); mount(<MemberWaivers gymId="gym" memberId={template.id} manage client={f.client} />);
  expect(await screen.findByText('No signed copies for this member')).toBeTruthy();
  await user.click(await screen.findByRole('button', { name: 'Review and sign' }));
  const dialog = screen.getByRole('dialog'); expect(within(dialog).getByText('Original text')).toBeTruthy();
  await user.click(within(dialog).getByLabelText('I am signing as a parent or guardian'));
  expect(within(dialog).getByLabelText('Relationship to member')).toBeTruthy();
  expect(within(dialog).getByLabelText('I have read this text and agree to sign it electronically.').hasAttribute('required')).toBe(true);
});
it('shows the publication validation message and keeps the unsupported draft editable', async () => {
  const f = fixture(), user = userEvent.setup(), original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation((url, init) => init?.method === 'POST'
    ? Promise.resolve(Response.json({ error: { code: 'invalid_request', message: 'Unsupported template characters: 🦄 (U+1F984)' } }, { status: 400 }))
    : original(url, init));
  mount(<Templates gymId="gym" manage client={f.client} />);
  await user.click(await screen.findByRole('button', { name: 'Edit template' }));
  const body = screen.getByLabelText('Agreement text'); await user.clear(body); await user.type(body, 'Terms 🦄');
  await user.click(screen.getByRole('button', { name: 'Publish version' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Unsupported template characters: 🦄 (U+1F984)');
  expect((body as HTMLTextAreaElement).value).toBe('Terms 🦄');
});
it('keeps configuration and signing actions off read-only views', async () => {
  const f = fixture(); mount(<Templates gymId="gym" manage={false} client={f.client} />);
  await screen.findByText('Participation'); expect(screen.queryByRole('button', { name: 'Edit template' })).toBeNull();
  cleanup(); mount(<MemberWaivers gymId="gym" memberId={template.id} manage={false} client={f.client} />);
  await waitFor(() => expect(screen.getByText(/Participation/)).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Review and sign' })).toBeNull();
});

const otherId = '01900000-0000-7000-8000-000000000002';
function signedCopy(current = false) {
  const signedTemplate = current ? template : { ...template, id: otherId, name: 'Original participation terms', version: 1 };
  const snapshot = { template: { id: signedTemplate.id, name: signedTemplate.name, version: signedTemplate.version, kind: 'waiver', body: 'Signed original terms' },
    member: { id: template.id, firstName: 'Ava', lastName: 'Chen', dateOfBirth: '2018-01-01' },
    signer: { kind: 'guardian', name: 'Daniel Chen', relationship: 'Parent' }, signedAt: '2026-10-24T01:30:00Z',
    signatureImage: { key: 'gym/signature.png', hash: 'a'.repeat(64) } };
  return { id: otherId, templateId: signedTemplate.id, memberId: template.id, snapshot: JSON.stringify(snapshot), snapshotHash: 'b'.repeat(64),
    signatureImageKey: snapshot.signatureImage.key, signatureImageHash: snapshot.signatureImage.hash, signedAt: '1999-01-01T00:00:00Z' };
}
it('uses snapshot details and gym-local dates, and checks current status outside the history page', async () => {
  const unsigned = { ...template, id: '01900000-0000-7000-8000-000000000003', name: 'New terms', version: 3 };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
    const path = new URL(String(url), 'https://gym.example.test');
    const data = path.pathname.includes('/templates') ? [template, unsigned]
      : path.searchParams.has('templateId') ? (path.searchParams.get('templateId') === template.id ? [signedCopy(true)] : [])
      : path.searchParams.get('offset') === '20' ? [signedCopy(true)] : [signedCopy()];
    return Response.json({ data, pagination: { limit: 20, offset: Number(path.searchParams.get('offset') ?? 0), total: path.pathname.includes('/templates') ? 2 : path.searchParams.has('templateId') ? data.length : 21 } });
  });
  const user = userEvent.setup();
  mount(<MemberWaivers gymId="gym" memberId={template.id} manage timezone="America/Vancouver" locale="fr-CA" client={createWaiversClient(fetcher)} />);
  expect(await screen.findByRole('heading', { name: 'Original participation terms · Version 1' })).toBeTruthy();
  expect(screen.getByText('Guardian signature: Daniel Chen (Parent)')).toBeTruthy();
  const time = document.querySelector('time')!;
  expect(time.dateTime).toBe('2026-10-24T01:30:00Z');
  expect(time.textContent).toBe(new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Vancouver', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time.dateTime)));
  expect(time.textContent).toContain('23'); // Previous calendar day in the gym, not the UTC date.
  expect(await screen.findByText('Signed — current version')).toBeTruthy();
  expect(await screen.findByText('Needs a signature')).toBeTruthy();
  await user.click(screen.getAllByRole('button', { name: 'Next' })[1]!);
  expect(await screen.findByRole('heading', { name: 'Participation · Version 2' })).toBeTruthy();
  expect(screen.getByText('Signed — current version')).toBeTruthy();
  expect(screen.getByText('Needs a signature')).toBeTruthy();
});
it('does not count an old signed version as signing the current template', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async url => {
    const path = new URL(String(url), 'https://gym.example.test');
    const data = path.pathname.includes('/templates') ? [template] : path.searchParams.has('templateId') ? [] : [signedCopy()];
    return Response.json({ data, pagination: { limit: 20, offset: 0, total: data.length } });
  });
  mount(<MemberWaivers gymId="gym" memberId={template.id} manage client={f.client} />);
  expect(await screen.findByText('Needs a signature')).toBeTruthy();
  expect(screen.queryByText('Signed — current version')).toBeNull();
});
it('shows the renderer busy response next to signed copies', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => String(url).endsWith('/pdf')
    ? Response.json({ error: { code: 'conflict', message: 'PDF renderer busy; retry shortly' } }, { status: 409 })
    : Response.json({ data: String(url).includes('/templates') ? [] : [signedCopy()], pagination: { limit: 20, offset: 0, total: 1 } }));
  mount(<MemberWaivers gymId="gym" memberId={template.id} manage client={createWaiversClient(fetcher)} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Prepare PDF' }));
  expect((await screen.findByRole('alert')).textContent).toBe('PDF renderer busy; retry shortly');
});
it.each([
  [403, 'Uploads are disabled in the demo', 'Uploads are disabled in the demo'],
  [409, 'Template changed; review the current version', 'Template changed; review the current version'],
  [500, 'Private server details', 'Could not sign.'],
])('handles signing status %s without losing the form', async (status, message, expected) => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), fillText: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,YQ==');
  const f = fixture(), user = userEvent.setup();
  f.fetcher.mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      if (String(url).endsWith('signature-images') && status !== 403) return Response.json({ data: { signatureImageKey: 'gym/signature.png', signatureImageHash: 'a'.repeat(64) } });
      return Response.json({ error: { code: status === 409 ? 'conflict' : status === 403 ? 'forbidden' : 'internal', message } }, { status });
    }
    const data = String(url).includes('/templates') ? [template] : [];
    return Response.json({ data, pagination: { limit: 20, offset: 0, total: data.length } });
  });
  mount(<MemberWaivers gymId="gym" memberId={template.id} manage client={f.client} />);
  await user.click(await screen.findByRole('button', { name: 'Review and sign' }));
  await user.type(screen.getByLabelText('Signer’s full name'), 'Daniel Chen');
  await user.click(screen.getByLabelText('Use my typed name as my signature'));
  await user.click(screen.getByLabelText('I have read this text and agree to sign it electronically.'));
  await user.click(screen.getByRole('button', { name: 'Sign agreement' }));
  expect((await screen.findByRole('alert')).textContent).toContain(expected);
  expect((screen.getByLabelText('Signer’s full name') as HTMLInputElement).value).toBe('Daniel Chen');
  if (status === 500) expect(screen.queryByText(message)).toBeNull();
});
