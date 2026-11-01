// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { setLogSink } from '../../core/log.js';
import * as goLive from '../../areas/settings/go-live.js';
import { createSeedCommand } from '../seed-cli.js';
import { studentRows, useUnconfiguredSandbox } from './portal.fixture.test-helper.js';

const { db, fixture } = useUnconfiguredSandbox();

describe('demo portal seed failure report on a sandbox seeded without the test account', { timeout: 90_000 }, () => {
  it('reports the student billing failure, not a failing switch restore', async () => {
    const { gymId } = db.seeded, keyed = fixture(true);
    const { home } = await studentRows(db, gymId), gateway = await keyed.provider(gymId), seedCard = gateway.seedCard.bind(gateway);
    let studentFailed = false;
    vi.spyOn(gateway, 'seedCard').mockImplementation(async (customerId, householdId, declines) => {
      if (householdId === home.id) { studentFailed = true; throw Object.assign(new Error('Test card unavailable'), { code: 'TEST_CARD_DOWN' }); }
      return seedCard(customerId, householdId, declines);
    });
    // The portal seed's restore fails too (the billing seed's own restore, earlier, works); the seed's own failure must
    // still be the one reported.
    const create = goLive.createGoLiveService;
    const spy = vi.spyOn(goLive, 'createGoLiveService').mockImplementation(options => {
      const service = create(options);
      return { ...service, async update(context, input) {
        if (studentFailed && input.billingEnabled === false) throw Object.assign(new Error('Switch unavailable'), { code: 'RESTORE_DOWN' });
        return service.update(context, input);
      } };
    });
    const logs: string[] = [], previous = setLogSink(line => logs.push(line));
    try {
      expect(await createSeedCommand(db.forGym, keyed.seed).run([gymId], { stdout: vi.fn(), stderr: vi.fn() })).toBe(1);
    } finally { setLogSink(previous); spy.mockRestore(); }
    const events = logs.map(line => JSON.parse(line) as { event: string; step?: string; error?: { code?: string } });
    expect(events.find(entry => entry.event === 'demo.seed_failed')).toMatchObject({ step: 'portal', error: { code: 'TEST_CARD_DOWN' } });
    expect(events.find(entry => entry.event === 'demo.portal.billing_restore_failed')).toMatchObject({ gymId, error: { code: 'RESTORE_DOWN' } });
  });
});
