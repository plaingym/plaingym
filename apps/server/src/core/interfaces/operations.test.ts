// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { FakeGymSettingsAccessor } from './gym-settings.js';
import { FakeJobStatsQuery } from './job-stats.js';
import { FakeWebhookHealthQuery } from './webhook-health.js';
import { gym, otherGym } from './test-fixtures.js';
const settings = { gymId: gym, timezone: 'America/Vancouver', currency: 'CAD', billingEnabled: false,
  memberEmailsEnabled: false, websiteEnabled: false, bookingWindowDays: 14, cancellationCutoffMinutes: 60, revision: 1 };
describe('Operational read interfaces', () => {
  it('returns explicit settings fields and rejects unknown gyms', async () => {
    const fake = new FakeGymSettingsAccessor([{ ...settings, stripeConfig: 'secret' } as typeof settings]);
    expect(await fake.get(gym)).toEqual(settings);
    expect(await fake.get(gym)).not.toHaveProperty('stripeConfig');
    await expect(fake.get(otherGym)).rejects.toMatchObject({ code: 'not_found' });
    fake.set({ ...settings, revision: 2, billingEnabled: true });
    expect(await fake.get(gym)).toMatchObject({ revision: 2, billingEnabled: true });
  });
  it('validates timezone, currency and booking limits', () => {
    expect(() => new FakeGymSettingsAccessor([{ ...settings, currency: 'cad' }])).toThrow();
    expect(() => new FakeGymSettingsAccessor([{ ...settings, timezone: 'invalid-zone' }])).toThrow();
    expect(() => new FakeGymSettingsAccessor([{ ...settings, bookingWindowDays: -1 }])).toThrow();
    expect(() => new FakeGymSettingsAccessor([{ ...settings, revision: 0 }])).toThrow();
  });
  it('aggregates job statuses, with pending scheduled time and no install-level or other-gym rows', async () => {
    const fake = new FakeJobStatsQuery([
      { gymId: gym, status: 'pending', runAt: '2026-10-21T12:00:00Z' },
      { gymId: gym, status: 'pending', runAt: '2026-10-21T13:00:00+02:00' },
      { gymId: gym, status: 'failed', runAt: '2026-10-21T12:00:00Z' },
      { gymId: gym, status: 'running', runAt: '2026-10-21T12:00:00Z' },
      { gymId: null, status: 'failed', runAt: '2026-10-21T12:00:00Z' },
      { gymId: otherGym, status: 'failed', runAt: '2026-10-21T12:00:00Z' },
    ]);
    expect(await fake.get(gym)).toEqual({ pending: 2, running: 1, succeeded: 0, failed: 1, oldestPendingAt: '2026-10-21T13:00:00+02:00' });
    expect(await new FakeJobStatsQuery().get(gym)).toEqual({ pending: 0, running: 0, succeeded: 0, failed: 0, oldestPendingAt: null });
  });
  it('aggregates only the current gym webhook timestamps and mutually exclusive counts', async () => {
    const fake = new FakeWebhookHealthQuery([
      { gymId: gym, receivedAt: '2026-10-20T12:00:00Z', processedAt: '2026-10-20T13:00:00Z', failed: false },
      { gymId: gym, receivedAt: '2026-10-21T12:00:00Z', processedAt: null, failed: true },
      { gymId: gym, receivedAt: '2026-10-21T11:00:00Z', processedAt: null, failed: false },
      { gymId: otherGym, receivedAt: '2026-10-22T12:00:00Z', processedAt: null, failed: true },
      { gymId: null, receivedAt: '2026-10-22T12:00:00Z', processedAt: null, failed: true },
    ]);
    expect(await fake.get(gym)).toEqual({ lastReceivedAt: '2026-10-21T12:00:00Z', lastProcessedAt: '2026-10-20T13:00:00Z', pendingCount: 1, failedCount: 1 });
    expect(await new FakeWebhookHealthQuery().get(gym)).toEqual({ lastReceivedAt: null, lastProcessedAt: null, pendingCount: 0, failedCount: 0 });
  });
});
