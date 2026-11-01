// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChargeType, GymSettings } from '@plaingym/shared/contracts';
import { bootstrapKey } from '../../app/context.js';
import { DropInSettings } from './drop-in.js';
import { createRegistries } from '../../lib/registries.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn() }));
const billing = vi.hoisted(() => ({ charges: vi.fn() }));
vi.mock('../../lib/api.js', async (original) => ({ ...await original<typeof import('../../lib/api.js')>(), api: client, createApiClient: () => client }));
vi.mock('../billing/catalog/api.js', async (original) => ({ ...await original<typeof import('../billing/catalog/api.js')>(), billingClient: billing }));
const id = (n: number) => '01900000-0000-7000-8000-' + String(n).padStart(12, '0');
const settings: GymSettings = { id: id(1), name: 'Gym', slug: 'gym', timezone: 'America/Vancouver', currency: 'CAD', address: {}, branding: {},
  websiteEnabled: false, existingSiteUrl: null, bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false,
  billingEnabled: false, memberEmailsEnabled: false, retryDays: [3, 7], dropInChargeTypeId: null, revision: 3,
  createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T12:00:00Z' };
const charge = (n: number, name: string, amountCents: number, active = true): ChargeType =>
  ({ id: id(n), createdAt: '2026-10-26T12:00:00Z', name, amountCents, currency: 'CAD', active, revision: 1, taxRateIds: [] });
const mat = charge(10, 'Mat fee', 2500), archived = charge(11, 'Old mat fee', 2000, false), towel = charge(12, 'Towel', 300);
const reply = (status: number, data?: unknown) => ({ response: { ok: status < 300, status }, data });
const contactGym = 'The drop-in page asks visitors to contact the gym about the fee.';
let cache: QueryClient;
const start = () => render(<QueryClientProvider client={cache}><DropInSettings/></QueryClientProvider>);
const field = async () => await screen.findByRole('combobox', { name: 'Drop-in charge type' }) as HTMLSelectElement;
beforeEach(() => {
  client.GET.mockReset(); client.PATCH.mockReset(); billing.charges.mockReset();
  client.GET.mockResolvedValue(reply(200, { data: settings })); billing.charges.mockResolvedValue([mat, archived, towel]);
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
});
afterEach(cleanup);

describe('drop-in fee settings', () => {
  it('registers a section for settings managers through the web composition extension point', () => {
    const section = createRegistries().settingsSections.all().find(section => section.id === 'settingsSections.settings.drop-in');
    expect(section).toMatchObject({ enabled: true, labelKey: 'settings/drop-in:title', permission: { kind: 'staff', capability: 'settings.manage' }, component: DropInSettings });
  });
  it('lists no fee by default and offers only active charge types with their prices', async () => {
    start();
    const select = await field();
    expect(select.value).toBe('');
    expect([...select.options].map(option => option.textContent)).toEqual(['No drop-in fee listed', 'Mat fee · CA$25.00', 'Towel · CA$3.00']);
    expect(screen.getByText(contactGym)).toBeDefined();
  });
  it('saves a chosen charge type with its revision, previews its price and refreshes the shell summary', async () => {
    const invalidate = vi.spyOn(cache, 'invalidateQueries');
    client.PATCH.mockResolvedValue(reply(200, { data: { ...settings, revision: 4, dropInChargeTypeId: mat.id } }));
    const user = userEvent.setup(); start();
    await user.selectOptions(await field(), mat.id);
    expect(screen.getByText('The drop-in page shows: CA$25.00')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Save drop-in fee' }));
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings/drop-in', { body: { revision: 3, dropInChargeTypeId: mat.id } });
    expect((await screen.findByRole('status')).textContent).toBe('Drop-in fee saved.');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: bootstrapKey });
  });
  it('answers a change made elsewhere with a conflict and reloads the settings and the charge types', async () => {
    client.PATCH.mockResolvedValue(reply(409));
    client.GET.mockResolvedValueOnce(reply(200, { data: settings })).mockResolvedValueOnce(reply(200, { data: { ...settings, revision: 5, dropInChargeTypeId: towel.id } }));
    const user = userEvent.setup(); start();
    const select = await field();
    await user.selectOptions(select, mat.id);
    await user.click(screen.getByRole('button', { name: 'Save drop-in fee' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed elsewhere');
    // The other change is shown, not this section's unsaved choice.
    await vi.waitFor(() => expect(select.value).toBe(towel.id));
    expect(client.GET).toHaveBeenCalledTimes(2);
    expect(billing.charges).toHaveBeenCalledTimes(2);
    client.PATCH.mockResolvedValueOnce(reply(200, { data: { ...settings, revision: 6, dropInChargeTypeId: mat.id } }));
    await user.selectOptions(select, mat.id);
    await user.click(screen.getByRole('button', { name: 'Save drop-in fee' }));
    expect(client.PATCH).toHaveBeenLastCalledWith('/api/settings/drop-in', { body: { revision: 5, dropInChargeTypeId: mat.id } });
  });
  it('reloads the charge types when the chosen one is gone, so it is no longer offered', async () => {
    client.PATCH.mockResolvedValue(reply(404));
    billing.charges.mockResolvedValueOnce([mat, towel]).mockResolvedValueOnce([mat]);
    const user = userEvent.setup(); start();
    const select = await field();
    await user.selectOptions(select, towel.id);
    await user.click(screen.getByRole('button', { name: 'Save drop-in fee' }));
    expect((await screen.findByRole('alert')).textContent).toContain('no longer available');
    await vi.waitFor(() => expect([...select.options].map(option => option.value)).toEqual(['', mat.id]));
    expect(select.value).toBe('');
  });
  it('shows a saved charge type that is not in the list as no drop-in fee, and saves it as none', async () => {
    client.GET.mockResolvedValue(reply(200, { data: { ...settings, dropInChargeTypeId: id(99) } }));
    client.PATCH.mockResolvedValue(reply(200, { data: { ...settings, revision: 4 } }));
    const user = userEvent.setup(); start();
    expect((await field()).value).toBe('');
    expect(screen.getByText(contactGym)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Save drop-in fee' }));
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings/drop-in', { body: { revision: 3, dropInChargeTypeId: null } });
    expect((await screen.findByRole('status')).textContent).toBe('Drop-in fee saved.');
  });
  it('clears the fee by saving null', async () => {
    client.GET.mockResolvedValue(reply(200, { data: { ...settings, dropInChargeTypeId: mat.id } }));
    client.PATCH.mockResolvedValue(reply(200, { data: { ...settings, revision: 4 } }));
    const user = userEvent.setup(); start();
    const select = await field();
    expect(select.value).toBe(mat.id);
    await user.selectOptions(select, '');
    await user.click(screen.getByRole('button', { name: 'Save drop-in fee' }));
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings/drop-in', { body: { revision: 3, dropInChargeTypeId: null } });
    expect(select.value).toBe('');
  });
  it('shows a saved archived charge type as archived and not shown to visitors, and won\'t save it again', async () => {
    client.GET.mockResolvedValue(reply(200, { data: { ...settings, dropInChargeTypeId: archived.id } }));
    const user = userEvent.setup(); start();
    const select = await field();
    expect(select.value).toBe(archived.id);
    const option = [...select.options].find(option => option.value === archived.id)!;
    expect(option.textContent).toBe('Old mat fee (archived) · CA$20.00');
    expect(option.disabled).toBe(true);
    expect(screen.getByText(contactGym)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Save drop-in fee' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Choose an active charge type, or no drop-in fee');
    expect(client.PATCH).not.toHaveBeenCalled();
  });
  it.each([[409, 'changed elsewhere'], [404, 'no longer available'], [500, 'The request failed']])('explains a %s save failure without private details', async (status, message) => {
    client.PATCH.mockResolvedValue(reply(status, { error: { message: 'private SQL error' } }));
    const user = userEvent.setup(); start();
    await user.selectOptions(await field(), towel.id);
    await user.click(screen.getByRole('button', { name: 'Save drop-in fee' }));
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(document.body.textContent).not.toContain('private SQL');
  });
  it('points to the catalog when there is no active charge type, and offers a retry on a failed load', async () => {
    billing.charges.mockRejectedValueOnce(new Error('private network detail')).mockResolvedValueOnce([archived]);
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Reload saved drop-in fee' }));
    expect(await screen.findByText('Add a charge type in the billing catalog to list a drop-in fee.')).toBeDefined();
    expect(document.body.textContent).not.toContain('private network');
  });
});
