// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createWebRegistries } from '@plaingym/shared';
import { ShellServicesContext } from '../../app/context.js';
import type { ShellServices } from '../../app/services.js';
import { ApiError } from '../../lib/api.js';
import { SetupWizard } from './wizard.js';
import { createSetupClient } from './api.js';
import { createRegistries, type ExtensionView } from '../../lib/registries.js';

const services: ShellServices = {
  loadBootstrap: vi.fn(async () => ({ gym: { id: 'gym', name: 'Academy', enabledModules: [] }, session: { userId: 'owner', roles: ['owner'] as const, member: false }, login: { password: true, magicLink: false } })),
  signInWithPassword: vi.fn(async () => {}), requestMagicLink: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
};
function start(step = 0, completedSteps = Array.from({ length: step }, (_, i) => i), registries = createRegistries()) {
  let currentStep = step, revision = 1;
  const fetcher = vi.fn(async (path: RequestInfo | URL, options?: RequestInit) => {
    const name = String(path), body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {};
    if (name === '/api/setup' || name === '/api/setup/start') {
      if (name.endsWith('start')) currentStep = 1;
      return Response.json({ data: { currentStep, completedSteps, completed: false, revision } });
    }
    if (name.endsWith('/catalog')) return Response.json({ data: [{ id: 'bjj', name: 'Brazilian Jiu-Jitsu', version: 1, summary: 'Programs and belt colors' }] });
    if (name.endsWith('/owner')) { currentStep = 2; return Response.json({ data: { userId: '019a0af0-9c00-7000-8000-000000000001' } }); }
    if (name.endsWith('/gym')) { currentStep = 3; revision++; return Response.json({ data: { ...body, revision } }); }
    if (name.endsWith('/packs')) { currentStep = 4; revision++; return Response.json({ data: { currentStep, completedSteps: [0, 1, 2, 3], completed: false, revision } }); }
    if (name.endsWith('/smtp')) { currentStep = 6; revision++; return Response.json({ data: { configured: false, test: 'not_sent', revision } }); }
    if (name.endsWith('/stripe')) { currentStep = 7; revision++; return Response.json({ data: { configured: false, mode: null, webhookRegistered: false, revision } }); }
    if (name.endsWith('/finish')) return Response.json({ data: { completed: true, billingEnabled: false, memberEmailsEnabled: false, revision: ++revision } });
    return Response.json({}, { status: 500 });
  });
  const client = createSetupClient(fetcher as typeof fetch);
  // The registered step 8 component uses the global fetch.
  vi.stubGlobal('fetch', fetcher);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={query}><ShellServicesContext.Provider value={services}><SetupWizard client={client} registries={registries} /></ShellServicesContext.Provider></QueryClientProvider>);
  return { fetcher, client, query };
}
beforeEach(() => { sessionStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('setup wizard', () => {
  it('keeps restore submit and Back together, and Back works without validating the restore form', async () => {
    const { fetcher } = start();
    await userEvent.click(await screen.findByRole('button', { name: 'Restore a backup' }));
    const actions = screen.getByRole('group', { name: 'Setup actions' });
    const restore = within(actions).getByRole('button', { name: 'Restore a backup' });
    expect(restore.getAttribute('type')).toBe('submit');
    const back = within(actions).getByRole('button', { name: 'Back' });
    restore.focus(); await userEvent.tab();
    expect(document.activeElement).toBe(back);
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Start fresh' });
    expect(fetcher.mock.calls.some(([path]) => path === '/api/setup/restore')).toBe(false);
  });
  it('keeps email submit and skip in one bar and skipping works with empty required fields', async () => {
    const { fetcher } = start(5);
    await screen.findByRole('button', { name: 'Send test email and save' });
    const actions = screen.getByRole('group', { name: 'Setup actions' });
    const submit = within(actions).getByRole('button', { name: 'Send test email and save' });
    expect(submit.getAttribute('type')).toBe('submit');
    const skip = within(actions).getByRole('button', { name: 'Skip email configuration' });
    expect(skip.getAttribute('type')).toBe('button');
    submit.focus(); await userEvent.tab();
    expect(document.activeElement).toBe(skip);
    await userEvent.keyboard('{Enter}');
    await screen.findByLabelText('Restricted Stripe key');
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/smtp');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'skip', revision: 1 });
  });
  it('keeps backup setup-later, import finish and Back to backups in working action bars', async () => {
    const { fetcher } = start(7);
    await screen.findByRole('button', { name: 'Generate backup key' });
    const backupActions = screen.getByRole('group', { name: 'Setup actions' });
    expect(within(backupActions).getByRole('button', { name: 'Generate backup key' }).getAttribute('type')).toBe('submit');
    await userEvent.click(within(backupActions).getByRole('button', { name: 'Set up later' }));
    let actions = screen.getByRole('group', { name: 'Setup actions' });
    expect(within(actions).getByRole('button', { name: 'Start fresh' })).toBeDefined();
    await userEvent.click(within(actions).getByRole('button', { name: 'Back to backups' }));
    await screen.findByRole('button', { name: 'Generate backup key' });
    expect(fetcher.mock.calls.some(([path]) => path === '/api/setup/finish')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Set up later' }));
    actions = screen.getByRole('group', { name: 'Setup actions' });
    await userEvent.click(within(actions).getByRole('button', { name: 'Start fresh' }));
    await screen.findByText(/Setup is complete/);
    expect(screen.queryByRole('button', { name: 'Back to backups' })).toBeNull();
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/finish');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'fresh', revision: 1, skipBackups: true });
  });
  it('submits the owner form from its action bar', async () => {
    start(1);
    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    const submit = within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' });
    expect(submit.getAttribute('type')).toBe('submit');
    await userEvent.click(submit);
    await screen.findByLabelText('Gym name');
    expect(services.signInWithPassword).toHaveBeenCalledWith('owner@example.org', 'owner-password-123');
  });
  it('keeps the unregistered payment fallback in an action bar and continues to backups', async () => {
    const { fetcher } = start(6, [0, 1, 2, 3, 4, 5], createWebRegistries<ExtensionView>([]));
    await screen.findByText('Payment configuration is not set up. Continue with billing paused.');
    const actions = screen.getByRole('group', { name: 'Setup actions' });
    await userEvent.click(within(actions).getByRole('button', { name: 'Save and continue' }));
    await screen.findByRole('button', { name: 'Generate backup key' });
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/stripe');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'skip', revision: 1 });
  });
  it('takes the installer token out of the URL and sends it only on bootstrap actions', async () => {
    window.history.replaceState(null, '', '/setup#token=private-install-token');
    const { client, fetcher } = start();
    await screen.findByRole('button', { name: 'Start fresh' });
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem('setup.token')).toBe('private-install-token');
    await client.call('start', { choice: 'fresh' });
    expect(fetcher).toHaveBeenCalledWith('/api/setup/start', expect.objectContaining({ headers: expect.objectContaining({ 'X-Setup-Token': 'private-install-token' }) }));
    expect(fetcher.mock.calls.find(([path]) => path === '/api/setup')?.[1]?.headers).not.toHaveProperty('X-Setup-Token');
  });
  it('renders the registered Stripe step at step 6', async () => {
    start(6);
    expect(await screen.findByLabelText('Restricted Stripe key')).toBeDefined();
    expect(screen.getByText('Step 7 / 9')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Validate and connect' })).toBeDefined();
  });
  it('offers setup later and finishes from step 8 without asking for S3 credentials', async () => {
    const { fetcher } = start(7);
    await userEvent.click(await screen.findByRole('button', { name: 'Set up later' }));
    expect(await screen.findByText('Step 9 / 9')).toBeDefined();
    expect(fetcher.mock.calls.find(([path]) => path === '/api/setup/finish')).toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    await screen.findByText(/Setup is complete/);
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/finish');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'fresh', revision: 1, skipBackups: true });
  });
  it('sends the street address in the shared address shape and omits it when blank', async () => {
    const { fetcher } = start(2);
    await userEvent.type(await screen.findByLabelText('Gym name'), 'Mat Academy');
    await userEvent.type(screen.getByLabelText('Street address'), ' 123 Main ');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await screen.findByText('Step 4 / 9');
    const gym = (index: number) => JSON.parse(String(fetcher.mock.calls.filter(([path]) => path === '/api/setup/gym')[index]?.[1]?.body)) as { address: unknown };
    expect(gym(0).address).toEqual({ line1: '123 Main' });
    cleanup();
    const blank = start(2);
    await userEvent.type(await screen.findByLabelText('Gym name'), 'Mat Academy');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await screen.findByText('Step 4 / 9');
    const call = blank.fetcher.mock.calls.find(([path]) => path === '/api/setup/gym');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ address: {} });
  });
  it('returns from step 8 to the backup step when backups were deferred', async () => {
    start(7);
    await userEvent.click(await screen.findByRole('button', { name: 'Set up later' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Back to backups' }));
    expect(await screen.findByRole('button', { name: 'Generate backup key' })).toBeDefined();
  });
  it('starts without asking for a gym bootstrap, then signs in the newly created owner', async () => {
    const { fetcher } = start();
    await userEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));
    expect(services.loadBootstrap).not.toHaveBeenCalled();
    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await screen.findByLabelText('Gym name');
    expect(services.signInWithPassword).toHaveBeenCalledWith('owner@example.org', 'owner-password-123');
    expect(fetcher).toHaveBeenCalledWith('/api/setup/owner', expect.objectContaining({ credentials: 'same-origin' }));
    expect(screen.queryByLabelText('Password (12–128 characters)')).toBeNull();
  });
  it('loads the shipped pack catalog and submits IDs with versions', async () => {
    const { fetcher } = start(3);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Brazilian Jiu-Jitsu/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await screen.findByText('Use the built-in website');
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/packs');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ revision: 1, packs: [{ packId: 'bjj', version: 1 }] });
  });
  it('explains relay delivery and permits skipping SMTP without erasing fallback settings', async () => {
    const { fetcher } = start(5);
    await screen.findByText(/Mail sent directly from the server itself lands in spam/);
    expect(screen.getByText(/SPF and DKIM/)).toBeDefined();
    expect(screen.getByText(/AUTH_PASSWORD_LOGIN=auto/)).toBeDefined();
    await userEvent.click(await screen.findByRole('button', { name: 'Skip email configuration' }));
    await screen.findByLabelText('Restricted Stripe key');
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/smtp');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'skip', revision: 1 });
  });
  it('requires backup key confirmation before allowing setup to finish', async () => {
    start(7);
    await screen.findByRole('button', { name: 'Generate backup key' });
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull();
    expect(screen.getByText(/Only your backup private key can open them/)).toBeDefined();
  });
  it('can finish at step 8 after a confirmed key survives a reload', async () => {
    const { fetcher } = start(8, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(await screen.findByText('Import or start fresh')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Back to backups' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));
    expect(await screen.findByText(/Setup is complete/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/finish');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'fresh', revision: 1 });
  });
  it('retains entered fields on a failed save', async () => {
    const { fetcher } = start(2);
    await userEvent.type(await screen.findByLabelText('Gym name'), 'Retry Academy');
    await waitFor(() => expect(screen.getByLabelText('Gym name')).toBeDefined());
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 500 }));
    fireEvent.submit(screen.getByRole('button', { name: 'Save and continue' }).closest('form')!);
    await screen.findByText('Could not save this step. Check the details and try again.');
    expect((screen.getByLabelText('Gym name') as HTMLInputElement).value).toBe('Retry Academy');
  });
  it('never treats a rejected setup request as successful', async () => {
    const client = createSetupClient(async () => Response.json({}, { status: 409 }));
    await expect(client.call('start', { choice: 'fresh' })).rejects.toBeInstanceOf(ApiError);
  });
});
