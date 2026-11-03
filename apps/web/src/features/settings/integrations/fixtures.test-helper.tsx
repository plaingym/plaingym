// SPDX-License-Identifier: AGPL-3.0-only
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GymSettings, Integrations } from '@plaingym/shared/contracts';
import { IntegrationsSettings } from './section.js';

export const settings: GymSettings = { id: '01900000-0000-7000-8000-000000000001', name: 'Gym', slug: 'gym',
  timezone: 'America/Vancouver', currency: 'CAD', address: {}, branding: {}, websiteEnabled: false, existingSiteUrl: null,
  bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false, billingEnabled: false,
  memberEmailsEnabled: false, retryDays: [3, 7], dropInChargeTypeId: null, revision: 3, createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z' };
export const integrations: Integrations = {
  email: { source: 'none', host: null, port: null, security: null, from: null, signIn: { password: true, magicLink: false },
    signInAfterSave: { password: false, magicLink: true }, signInAfterRemove: null, removeBlocked: false },
  payments: { configured: false, mode: null, webhookRegistered: false, accountLocked: false, testData: null, importedCustomersOnly: false },
  backups: { configured: false, destination: null, publicKey: null, pending: null, retentionBudgetBytes: 8_000_000_000 },
  sandbox: false, revision: 3,
};
export const health = (lastReceivedAt: string | null, latestRestorableAt: string | null) => ({ data: { generatedAt: '2026-11-02T12:00:00Z', tiles: [
  { id: 'last_backup', status: 'healthy', checkedAt: '2026-11-02T12:00:00Z', message: 'ok', details: { latestRestorableAt, ageSeconds: 60, overdue: false,
    retainedBytes: 1, retentionBudgetBytes: 8_000_000_000, pruningStopped: false, keyReminder: true } },
  { id: 'stripe_webhooks', status: 'healthy', checkedAt: '2026-11-02T12:00:00Z', message: 'ok', details: { lastReceivedAt, lastProcessedAt: lastReceivedAt, pending: 0, failed: 0 } },
  ...['failed_jobs', 'smtp', 'disk', 'version', 'last_charge_run', 'automatic_updates', 'update_available'].map((id) => ({ id, status: 'unavailable', checkedAt: null, message: 'n/a', details: null })),
] } });
export const reply = (status: number, body?: unknown) => ({ response: { ok: status < 300, status }, ...(status < 300 ? { data: body } : { error: body }) });
export const refusal = (status: number, field: string, code: string) => reply(status, { error: { code: 'conflict', message: 'private server text', details: { [field]: [code] } }, requestId: 'r' });
/** The section under a fresh query cache, as the settings page renders it. */
export const renderSection = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><IntegrationsSettings/></QueryClientProvider>);
/** Answers GETs for the settings, the integrations and the health checks. */
export function serve(GET: { mockImplementation(fn: (path: string) => Promise<unknown>): unknown }, current: () => Integrations, tiles = health(null, null)) {
  GET.mockImplementation(async (path: string) => path === '/api/settings' ? reply(200, { data: settings })
    : path === '/api/health' ? reply(200, tiles) : reply(200, { data: current() }));
}
