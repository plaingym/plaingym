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
vi.mock('../../../lib/api.js', async (original) => ({ ...await original<typeof import('../../../lib/api.js')>(), api: client, createApiClient: () => client }));
const id = (n: number) => '01900000-0000-7000-8000-' + String(n).padStart(12, '0');
const settings: GymSettings = { id: id(1), name: 'Gym', slug: 'gym', timezone: 'America/Vancouver', currency: 'CAD', address: {}, branding: {},
  websiteEnabled: false, existingSiteUrl: null, bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false,
  billingEnabled: false, memberEmailsEnabled: false, retryDays: [3, 7], dropInChargeTypeId: null, revision: 3,
  createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T12:00:00Z' };
const reply = (status: number, data?: unknown) => ({ response: { ok: status < 300, status }, data });
const empty = { data: [], pagination: { limit: 100, offset: 0, total: 0 } };
afterEach(cleanup);

const renderForm = (stored: GymSettings) => {
  client.GET.mockResolvedValue(reply(200, { data: stored }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ShellServicesContext.Provider value={createShellServices(vi.fn(async () => { throw new Error('not used'); }))}><GeneralSettingsForm/></ShellServicesContext.Provider>
  </QueryClientProvider>);
  return screen.findByRole('form', { name: 'Gym details' });
};
const refusedZone = { response: { ok: false, status: 400 }, error: { error: { code: 'invalid_request', message: 'The request is invalid.', details: { timezone: ['invalid_timezone'] } }, requestId: 'r' } };

describe('general settings timezone', () => {
  it('does not send a timezone that is unchanged, so a stored zone the rule refuses still saves', async () => {
    client.PATCH.mockReset();
    client.PATCH.mockImplementation(async (path: string, { body }: { body: Partial<GymSettings> }) => reply(200, { data: { ...settings, timezone: 'CET', ...body, revision: 4 } }));
    const general = await renderForm({ ...settings, timezone: 'CET' });
    expect((within(general).getByLabelText('Timezone') as HTMLInputElement).value).toBe('CET');
    fireEvent.change(within(general).getByLabelText('Gym name'), { target: { value: 'Renamed' } });
    fireEvent.click(within(general).getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    const body = client.PATCH.mock.calls[0]![1].body as Record<string, unknown>;
    expect(body).toMatchObject({ revision: 3, name: 'Renamed' });
    expect(body).not.toHaveProperty('timezone');
    expect(await screen.findByText('Changes saved.')).toBeDefined();
  });
  it('shows the rule at the timezone field when a new zone is refused, clears it on edit, and sends the zone again', async () => {
    client.PATCH.mockReset();
    client.PATCH.mockResolvedValueOnce(refusedZone);
    const general = await renderForm(settings);
    const field = within(general).getByLabelText('Timezone');
    expect(within(general).getByText('UTC or a region such as America/Vancouver.')).toBeDefined();
    fireEvent.change(field, { target: { value: 'PST' } });
    fireEvent.click(within(general).getByRole('button', { name: 'Save changes' }));
    const error = await within(general).findByRole('alert');
    expect(error.textContent).toContain('Use UTC or a region such as America/Vancouver');
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings', { body: expect.objectContaining({ timezone: 'PST' }) });
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toContain(error.id);
    // The refusal is about the field, not the page: no generic failure message, and the typed value stays.
    expect(screen.queryByText('Unable to save or load settings.')).toBeNull();
    expect((field as HTMLInputElement).value).toBe('PST');
    fireEvent.change(field, { target: { value: 'America/Toronto' } });
    expect(within(general).queryByRole('alert')).toBeNull();
    expect(field.getAttribute('aria-invalid')).toBe('false');
  });
  it('keeps the generic message for a 400 about another field', async () => {
    client.PATCH.mockReset();
    client.PATCH.mockResolvedValueOnce({ response: { ok: false, status: 400 }, error: { error: { code: 'invalid_request', message: 'The request is invalid.' }, requestId: 'r' } });
    const general = await renderForm(settings);
    fireEvent.click(within(general).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Unable to save or load settings.')).toBeDefined();
    expect(within(general).queryByRole('alert')).toBeNull();
    expect(client.PATCH.mock.calls[0]![1].body).not.toHaveProperty('timezone');
  });
});

describe('general settings and the cached shell summary', () => {
  it('shows the new currency in the one-off invoice editor right after saving, within the summary\'s stale time', async () => {
    let saved = settings;
    const loadBootstrap = vi.fn(async (): Promise<ShellBootstrap> => ({
      gym: { id: settings.id, name: saved.name, timezone: saved.timezone, currency: saved.currency, enabledModules: [] },
      session: { userId: id(2), displayName: 'Test User', roles: ['owner'], member: false }, login: { password: true, magicLink: false } }));
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
      <OneOffEditor gymId={settings.id} householdId={id(3)} custom catalog client={invoices} close={() => {}} created={() => {}}/>
    </ShellServicesContext.Provider></QueryClientProvider>);
    const editor = screen.getByRole('dialog');
    fireEvent.change(await within(editor).findByLabelText('Charge source'), { target: { value: 'custom' } });
    expect(within(editor).getByLabelText('Amount (CAD)')).toBeDefined();

    const currency = await screen.findByRole('form', { name: 'Billing currency' });
    fireEvent.change(within(currency).getByLabelText('Billing currency'), { target: { value: 'usd' } });
    fireEvent.click(within(currency).getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(client.PATCH).toHaveBeenCalledWith('/api/settings/currency', { body: { revision: 3, currency: 'USD' } }));
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
