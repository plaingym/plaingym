// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { scheduleContracts } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createScheduleService } from './schedule.js';
import { createScheduleJobs } from './schedule.jobs.js';
import { createScheduleRoutes } from './schedule.routes.js';
it('registers every frozen schedule endpoint with its declared permission', () => {
  const entries = createScheduleRoutes();
  for (const contract of Object.values(scheduleContracts)) {
    expect(entries.find((entry) => entry.definition.method === contract.method && entry.definition.path === contract.path)?.definition.permission).toEqual(contract.permission);
  }
});
it('materializes each scheduled gym in its own timezone using the job clock and ignoring payload IDs', async () => {
  const clock = new TestClock('2026-11-01T04:00:00Z'), worker = new FakeJobs(clock);
  const materialize = vi.fn().mockResolvedValue(0);
  createServerRegistry({ jobs: createScheduleJobs({ ...createScheduleService(), materialize }) }).registerJobs(worker, new Set());
  expect(worker.schedules.get('schedule.materialize')).toBe('0 0 * * *');
  await worker.triggerSchedule('schedule.materialize', [{ gymId: 'gym-a', timezone: 'America/New_York' }, { gymId: 'gym-b', timezone: 'Asia/Tokyo' }], 'today');
  await worker.runNext(); await worker.runNext();
  expect(materialize.mock.calls).toEqual([['gym-a', 'America/New_York', clock], ['gym-b', 'Asia/Tokyo', clock]]);
  await worker.enqueue('schedule.materialize', { gymId: 'forged', timezone: 'UTC' }, { gymId: 'gym-a', timezone: 'America/New_York' });
  await worker.runNext();
  expect(materialize).toHaveBeenLastCalledWith('gym-a', 'America/New_York', clock);
});
