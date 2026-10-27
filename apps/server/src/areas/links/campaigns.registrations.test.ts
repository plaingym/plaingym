// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { areaContributions } from '../../core/registry-areas.js';
import { TestClock } from '../../core/clock.js';

it('real campaign registrations fail loudly until runtime composition configures them', async () => {
  const context = { gymId: '01900000-0000-7000-8000-000000000001', jobId: 'unconfigured',
    timezone: 'UTC', attempt: 1, clock: new TestClock('2026-10-26T12:00:00Z') };
  const entries = areaContributions.jobs.filter(j => j.id.startsWith('links.campaigns.'));
  expect(entries).toHaveLength(3);
  expect(entries.find(j => j.id === 'links.campaigns.scan')!.cron).toBe('7 * * * *');
  for (const entry of entries) await expect(entry.handler({}, context)).rejects.toMatchObject({ code: 'unavailable', message: 'Campaign delivery is not configured' });
});
