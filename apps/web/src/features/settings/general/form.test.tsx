// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GymSettings, ShellBootstrap } from '@plaingym/shared/contracts';
import { ShellServicesContext } from '../../../app/context.js';
import { createShellServices } from '../../../app/services.js';
import { createInvoiceClient } from '../../billing/invoices/api.js';
import { OneOffEditor } from '../../billing/invoices/editor.js';
import { GeneralSettingsForm } from './form.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn() }));
vi.mock('../../../lib/api.js', async (original) => ({ ...await original<typeof import('../../../lib/api.js')>(), createApiClient: () => client }));
const id = (n: number) => '01900000-0000-7000-8000-' + String(n).padStart(12, '0');
const settings: GymSettings = { id: id(1), name: 'Gym', slug: 'gym', timezone: 'America/Vancouver', currency: 'CAD', address: {}, branding: {},
  websiteEnabled: false, existingSiteUrl: null, bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false,
  billingEnabled: false, memberEmailsEnabled: false, retryDays: [3, 7], dropInChargeTypeId: null, revision: 3,
  createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T12:00:00Z' };
const reply = (status: number, data?: unknown) => ({ response: { ok: status < 300, status }, data });
const empty = { data: [], pagination: { limit: 100, offset: 0, total: 0 } };
afterEach(cleanup);

describe('general settings and the cached shell summary', () => {
  it('shows the new currency in the one-off invoice editor right after saving, within the summary\'s stale time', async () => {
    let saved = settings;
    const loadBootstrap = vi.fn(async (): Promise<ShellBootstrap> => ({
      gym: { id: settings.id, name: saved.name, timezone: saved.timezone, currency: saved.currency, enabledModules: [] },
      session: { userId: id(2), roles: ['owner'], member: false }, login: { password: true, magicLink: false } }));
    client.GET.mockResolvedValue(reply(200, { data: settings }));
    client.PATCH.mockImplementation(async (path: string, { body }: { body: Partial<GymSettings> }) => {
      saved = { ...saved, ...body, revision: saved.revision + 1 };
      return reply(200, { data: saved });
    });
    const invoices = createInvoiceClient(vi.fn(async () => Response.json(empty)) as unknown as typeof fetch);
    // The shell's own stale time: without invalidation, the editor would keep the old currency for 30 seconds.
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    render(<QueryClientProvider client={cache}><ShellServicesContext.Provider value={createShellServices(loadBootstrap)}>
      <GeneralSettingsForm/>
      <OneOffEditor gymId={settings.id} householdId={id(3)} client={invoices} close={() => {}} created={() => {}}/>
    </ShellServicesContext.Provider></QueryClientProvider>);
    const editor = screen.getByRole('dialog');
    fireEvent.change(await within(editor).findByLabelText('Charge source'), { target: { value: 'custom' } });
    expect(within(editor).getByLabelText('Amount (CAD)')).toBeDefined();

    const currency = await screen.findByRole('form', { name: 'Billing currency' });
    fireEvent.change(within(currency).getByLabelText('Billing currency'), { target: { value: 'usd' } });
    fireEvent.click(within(currency).getByRole('button', { name: 'Save changes' }));
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings/currency', { body: { revision: 3, currency: 'USD' } });
    expect(await within(editor).findByLabelText('Amount (USD)')).toBeDefined();
    expect(loadBootstrap).toHaveBeenCalledTimes(2);

    // A timezone change (the general form) refreshes it too.
    const general = screen.getByRole('form', { name: 'Gym details' });
    fireEvent.change(within(general).getByLabelText('Timezone'), { target: { value: 'America/Toronto' } });
    fireEvent.click(within(general).getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(loadBootstrap).toHaveBeenCalledTimes(3));
    expect(client.PATCH).toHaveBeenLastCalledWith('/api/settings', { body: expect.objectContaining({ revision: 4, timezone: 'America/Toronto' }) });
  });
});
