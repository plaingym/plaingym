// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { Integrations } from '@plaingym/shared/contracts';
import { integrations, renderSection, serve } from './fixtures.test-helper.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), POST: vi.fn(), DELETE: vi.fn() }));
vi.mock('../../../lib/api.js', () => ({ api: client, createApiClient: () => client }));

const reason = /Whoever runs this install manages email and payments/;
const managed: Integrations = { ...integrations, integrationsEditable: false, backups: null, revision: 4,
  email: { ...integrations.email, source: 'gym', host: 'smtp.gym.test', port: 587, security: 'starttls', from: 'desk@gym.test',
    signInAfterRemove: { password: false, magicLink: true } },
  payments: { configured: true, mode: 'live', webhookRegistered: true, accountLocked: true, testData: null, importedCustomersOnly: false } };
let current: Integrations;
beforeEach(() => { for (const fn of Object.values(client)) fn.mockReset(); serve(client.GET, () => current); });
afterEach(cleanup);

describe('Settings → Email and payments managed by the operator', () => {
  it('shows the sections with the reason and offers no way to change them', async () => {
    current = managed; renderSection();
    expect(await screen.findByText(reason)).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Email' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Payments' })).toBeDefined();
    expect(screen.getByText(/smtp\.gym\.test/)).toBeDefined();
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    // Reloading is all that's left.
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Reload']);
    expect(client.PUT).not.toHaveBeenCalled();
  });
  it('shows a gym on the install’s email and without Stripe the same way', async () => {
    current = { ...managed, email: integrations.email, payments: integrations.payments }; renderSection();
    expect(await screen.findByText(reason)).toBeDefined();
    expect(screen.getByText(/Stripe isn’t connected/)).toBeDefined();
    expect(screen.queryByRole('form')).toBeNull();
  });
  it('keeps the forms when owners may change them, and the demo’s own text in a sandbox', async () => {
    current = { ...managed, integrationsEditable: true }; renderSection();
    expect(await screen.findByRole('form', { name: 'Payments' })).toBeDefined();
    expect(screen.queryByText(reason)).toBeNull();
    cleanup();
    current = { ...managed, sandbox: true }; renderSection();
    expect(await screen.findByText(/This sandbox sends email to the demo outbox/)).toBeDefined();
    expect(screen.queryByText(reason)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Email' })).toBeNull();
  });
});
