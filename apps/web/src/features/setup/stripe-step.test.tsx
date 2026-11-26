// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StripeStep } from './stripe-step.js';
import { SetupHoldContext } from './hold.js';
import { SetupWizard } from './wizard.js';
import { createSetupClient } from './api.js';
import { ShellServicesContext } from '../../app/context.js';
import type { ShellServices } from '../../app/services.js';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const webhookUrl = new URL('/webhooks/stripe', location.origin).href;
type StripeResponse = { configured: boolean; mode: 'test' | 'live' | null; webhookRegistered: boolean; revision: number };
const connected = (overrides: Partial<StripeResponse> = {}): StripeResponse => ({
  configured: true, mode: 'test', webhookRegistered: true, revision: 8, ...overrides,
});
function setup({ failure = 0, stripe = connected() }: { failure?: number; stripe?: StripeResponse } = {}) {
  const fetcher = vi.fn(async (path: RequestInfo | URL, _init?: RequestInit) => String(path) === '/api/setup'
    ? Response.json({ data: { currentStep: 6, completedSteps: [0, 1, 2, 3, 4, 5], completed: false, revision: 7 } })
    : failure ? Response.json({ error: { code: 'conflict', message: 'Private error' } }, { status: failure })
      : Response.json({ data: stripe }));
  const queries = new QueryClient();
  const invalidate = vi.spyOn(queries, 'invalidateQueries');
  const onComplete = vi.fn();
  render(<QueryClientProvider client={queries}><StripeStep fetcher={fetcher} onComplete={onComplete} /></QueryClientProvider>);
  return { fetcher, user: userEvent.setup(), invalidate, onComplete };
}
it('shows the full permission table, masks the key, and confirms the connection before moving on', async () => {
  const { fetcher, user, invalidate, onComplete } = setup();
  for (const resource of ['Setup Intents', 'Events', 'Disputes', 'Charges and Refunds']) expect(screen.getByText(resource)).toBeDefined();
  expect(screen.getByText('Mandates').nextElementSibling?.textContent).toBe('Read');
  const field = screen.getByLabelText('Restricted Stripe key') as HTMLInputElement;
  expect(field.type).toBe('password');
  await user.type(field, 'rk_test_SYNTHETIC');
  await user.click(screen.getByRole('button', { name: 'Validate and connect' }));
  expect(await screen.findByText(`Connected in test mode. Webhook registered at ${webhookUrl}.`)).toBeDefined();
  expect(screen.queryByLabelText('Restricted Stripe key')).toBeNull();
  expect(screen.queryByText('Key permissions')).toBeNull();
  expect(invalidate).not.toHaveBeenCalled();
  expect(onComplete).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Continue to backups' }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['setup', 'status'] });
  expect(JSON.parse(String(fetcher.mock.calls.find(([path]) => String(path) === '/api/setup/stripe')?.[1]?.body))).toEqual({ choice: 'configure', restrictedKey: 'rk_test_SYNTHETIC', revision: 7 });
});
it('names live mode in the confirmation', async () => {
  const { user } = setup({ stripe: connected({ mode: 'live' }) });
  await user.type(screen.getByLabelText('Restricted Stripe key'), 'rk_live_SYNTHETIC');
  await user.click(screen.getByRole('button', { name: 'Validate and connect' }));
  expect(await screen.findByText(`Connected in live mode. Webhook registered at ${webhookUrl}.`)).toBeDefined();
});
it('says when the webhook is not registered yet', async () => {
  const { user } = setup({ stripe: connected({ webhookRegistered: false }) });
  await user.type(screen.getByLabelText('Restricted Stripe key'), 'rk_test_SYNTHETIC');
  await user.click(screen.getByRole('button', { name: 'Validate and connect' }));
  expect(await screen.findByText('Connected in test mode. The webhook isn\'t registered yet. Check Settings → Integrations → Payments after setup.')).toBeDefined();
});
it('confirms a connection whose mode is unknown', async () => {
  const { user } = setup({ stripe: connected({ mode: null }) });
  await user.type(screen.getByLabelText('Restricted Stripe key'), 'rk_test_SYNTHETIC');
  await user.click(screen.getByRole('button', { name: 'Validate and connect' }));
  expect(await screen.findByText(`Connected to Stripe. Webhook registered at ${webhookUrl}.`)).toBeDefined();
});
it('moves on at once when setting up later', async () => {
  const { user, invalidate, onComplete } = setup();
  await user.click(screen.getByRole('button', { name: 'Set up later' }));
  expect(await screen.findByText('Stripe step saved. Continue to backups.')).toBeDefined();
  expect(screen.queryByText(/Connected/)).toBeNull();
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['setup', 'status'] });
});
it('refuses unrestricted keys without making a request', async () => {
  const { fetcher, user } = setup();
  await user.type(screen.getByLabelText('Restricted Stripe key'), 'sk_test_SYNTHETIC');
  await user.click(screen.getByRole('button', { name: 'Validate and connect' }));
  expect(await screen.findByText(/beginning with rk_test_/)).toBeDefined();
  expect(fetcher).not.toHaveBeenCalled();
});
it('clears the credential after a conflict and allows skipping', async () => {
  const { user, invalidate, onComplete } = setup({ failure: 409 });
  const field = screen.getByLabelText('Restricted Stripe key') as HTMLInputElement;
  await user.type(field, 'rk_test_SYNTHETIC');
  await user.click(screen.getByRole('button', { name: 'Validate and connect' }));
  expect(await screen.findByText(/Setup changed/)).toBeDefined();
  expect(field.value).toBe('');
  expect(screen.getByRole('button', { name: 'Set up later' })).toBeDefined();
  expect(invalidate).not.toHaveBeenCalled();
  expect(onComplete).not.toHaveBeenCalled();
});
it('holds the wizard step on configure until Continue to backups runs, and never holds on skip', async () => {
  const hold = vi.fn(), release = vi.fn(), onComplete = vi.fn();
  const order: string[] = [];
  release.mockImplementation(() => order.push('release'));
  onComplete.mockImplementation(() => order.push('onComplete'));
  const fetcher = vi.fn(async (path: RequestInfo | URL) => String(path) === '/api/setup'
    ? Response.json({ data: { currentStep: 6, completedSteps: [0, 1, 2, 3, 4, 5], completed: false, revision: 7 } })
    : Response.json({ data: connected() }));
  const queries = new QueryClient();
  const invalidate = vi.spyOn(queries, 'invalidateQueries');
  const user = userEvent.setup();
  render(<QueryClientProvider client={queries}><SetupHoldContext.Provider value={{ connected: null, hold, release }}><StripeStep fetcher={fetcher} onComplete={onComplete} /></SetupHoldContext.Provider></QueryClientProvider>);
  await user.type(screen.getByLabelText('Restricted Stripe key'), 'rk_test_SYNTHETIC');
  await user.click(screen.getByRole('button', { name: 'Validate and connect' }));
  await screen.findByText(`Connected in test mode. Webhook registered at ${webhookUrl}.`);
  expect(hold).toHaveBeenCalledExactlyOnceWith({ mode: 'test', webhookRegistered: true });
  expect(release).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Continue to backups' }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  expect(order).toEqual(['release', 'onComplete']);
  expect(invalidate).not.toHaveBeenCalled();
  cleanup();
  const holdSkip = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}><SetupHoldContext.Provider value={{ connected: null, hold: holdSkip, release: vi.fn() }}><StripeStep fetcher={fetcher} /></SetupHoldContext.Provider></QueryClientProvider>);
  await user.click(screen.getByRole('button', { name: 'Set up later' }));
  await screen.findByText('Stripe step saved. Continue to backups.');
  expect(holdSkip).not.toHaveBeenCalled();
});
/** The wizard at the payments step, where every status read after Skip answers `reload`. */
async function skipInWizard(reload: () => Response) {
  const status = (currentStep: number) => Response.json({ data: { currentStep, completedSteps: [0, 1, 2, 3, 4, 5], completed: false, revision: 7, googleSkipped: true, backupsLater: false } });
  let skipped = false;
  const fetcher = vi.fn(async (path: RequestInfo | URL) => {
    if (String(path) === '/api/setup') return skipped ? reload() : status(6);
    if (String(path) !== '/api/setup/stripe') return Response.json({}, { status: 500 });
    skipped = true;
    return Response.json({ data: connected({ configured: false, mode: null, webhookRegistered: false }) });
  });
  vi.stubGlobal('fetch', fetcher);
  const services: ShellServices = {
    loadBootstrap: async () => ({ gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: 'owner', displayName: 'Test User', roles: ['owner'] as const, member: false }, login: { password: true, magicLink: false } }),
    signInWithPassword: vi.fn(async () => {}), requestMagicLink: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
  };
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queries}><ShellServicesContext.Provider value={services}><SetupWizard client={createSetupClient(fetcher as typeof fetch)} /></ShellServicesContext.Provider></QueryClientProvider>);
  await userEvent.click(await screen.findByRole('button', { name: 'Set up later' }));
  return { status };
}
it('reads the status through the wizard on skip, so a failed read focuses the reload alert', async () => {
  await skipInWizard(() => Response.json({}, { status: 500 }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Could not load the latest setup progress.');
  await waitFor(() => expect(document.activeElement).toBe(alert));
  expect(screen.getByText('Stripe step saved. Continue to backups.')).toBeDefined();
});
it('moves the wizard to backups on skip once the status read works', async () => {
  await skipInWizard(() => Response.json({ data: { currentStep: 7, completedSteps: [0, 1, 2, 3, 4, 5, 6], completed: false, revision: 8, googleSkipped: true, backupsLater: false } }));
  const heading = await screen.findByRole('heading', { name: 'Protect your gym with backups' });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(screen.queryByRole('alert')).toBeNull();
});
it('ignores a second Continue to backups click while the wizard is still releasing the hold', async () => {
  let finish: () => void = () => undefined;
  const release = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })), onComplete = vi.fn();
  const user = userEvent.setup();
  render(<QueryClientProvider client={new QueryClient()}>
    <SetupHoldContext.Provider value={{ connected: { mode: 'test', webhookRegistered: true }, hold: vi.fn(), release }}>
      <StripeStep fetcher={vi.fn()} onComplete={onComplete} />
    </SetupHoldContext.Provider>
  </QueryClientProvider>);
  const button = screen.getByRole('button', { name: 'Continue to backups' });
  await user.click(button);
  await user.click(button);
  expect(release).toHaveBeenCalledTimes(1);
  expect(onComplete).not.toHaveBeenCalled();
  finish();
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
});
it('renders the confirmation from the wizard hold context without a local connect', () => {
  render(<QueryClientProvider client={new QueryClient()}>
    <SetupHoldContext.Provider value={{ connected: { mode: 'live', webhookRegistered: false }, hold: vi.fn(), release: vi.fn() }}>
      <StripeStep fetcher={vi.fn()} />
    </SetupHoldContext.Provider>
  </QueryClientProvider>);
  expect(screen.getByRole('status').textContent).toBe('Connected in live mode. The webhook isn\'t registered yet. Check Settings → Integrations → Payments after setup.');
  expect(screen.queryByLabelText('Restricted Stripe key')).toBeNull();
});
