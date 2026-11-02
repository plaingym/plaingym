// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { uuidv7, taxRates } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { addsTaxOnTop } from './adds-tax-on-top.js';

const database = useTestDatabase(), factory = createFactories(database);

describe('addsTaxOnTop', () => {
  it('matches exactly the exclusive rates above zero, archived or not, and leaves the archived filter to the caller', async () => {
    const gymId = uuidv7();
    await factory('gyms', gymId, { currency: 'CAD' });
    const rate = (name: string, rateMillionths: number, inclusive: boolean, active = true) => factory('taxRates', gymId, { name, rateMillionths, inclusive, active });
    await rate('Included', 99_750, true);
    await rate('Zero', 0, false);
    await rate('Exclusive', 50_000, false);
    await rate('Archived exclusive', 70_000, false, false);
    const names = await database.forGym(gymId, async tx => (await tx.select({ name: taxRates.name }).from(taxRates).where(addsTaxOnTop)).map(row => row.name).sort());
    expect(names).toEqual(['Archived exclusive', 'Exclusive']);
  });
});
