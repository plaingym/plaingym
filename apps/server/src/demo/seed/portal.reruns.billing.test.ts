// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createSeedCommand } from '../seed-cli.js';
import { studentRows, useUnconfiguredSandbox } from './portal.fixture.test-helper.js';

const { db, fixture } = useUnconfiguredSandbox();

describe('demo portal seed billing on a sandbox seeded without the test account', { timeout: 90_000 }, () => {
  it('restores the billing switch when the student billing fails, and completes on retry', async () => {
    // A sandbox seeded before the test account was configured, then seeded again with it.
    const { gymId } = db.seeded, keyed = fixture(true);
    const { home } = await studentRows(db, gymId), gateway = await keyed.provider(gymId), seedCard = gateway.seedCard.bind(gateway);
    const failing = vi.spyOn(gateway, 'seedCard').mockImplementation(async (customerId, householdId, declines) => {
      if (householdId === home.id) throw new Error('Test card unavailable');
      return seedCard(customerId, householdId, declines);
    });
    const io = { stdout: vi.fn(), stderr: vi.fn() };
    expect(await createSeedCommand(db.forGym, keyed.seed).run([gymId], io)).toBe(1);
    const failed = await studentRows(db, gymId);
    expect(failed.gym.billingEnabled).toBe(false); expect(failed.invoices).toEqual([]);
    failing.mockImplementation(seedCard);
    expect(await createSeedCommand(db.forGym, keyed.seed).run([gymId], io)).toBe(0);
    const again = await studentRows(db, gymId);
    expect(again.gym.billingEnabled).toBe(true);
    expect(again.cards).toHaveLength(1);
    expect(again.invoices.map(row => row.status)).toEqual(['paid', 'paid', 'paid']);
  });
});
