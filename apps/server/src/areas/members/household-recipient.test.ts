// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { householdRecipient } from './household-recipient.js';

const db = useTestDatabase(), factory = createFactories(db);
async function household(email: string | null) {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const home = await factory('households', gymId, { email });
  const recipient = (memberId?: string) => db.forGym(gymId, tx => householdRecipient(tx, gymId, home.id, memberId));
  return { gymId, home, recipient };
}

describe('household email recipient with PostgreSQL', () => {
  it('returns the trimmed household address, matching members case-insensitively', async () => {
    const h = await household('  Payer@Example.invalid ');
    await factory('members', h.gymId, { householdId: h.home.id, email: 'payer@example.INVALID ' });
    await factory('members', h.gymId, { householdId: h.home.id, email: 'child@example.invalid', emailOptOut: true });
    expect(await h.recipient()).toEqual({ email: 'Payer@Example.invalid', suppressed: false });
  });
  it.each([
    ['opted out', { emailOptOut: true }],
    ['undeliverable', { emailDeliverable: false }],
  ])('suppresses the address when a member at it is %s', async (_label, flags) => {
    const h = await household('payer@example.invalid');
    await factory('members', h.gymId, { householdId: h.home.id, email: 'PAYER@example.invalid', ...flags });
    expect(await h.recipient()).toEqual({ email: 'payer@example.invalid', suppressed: true });
  });
  it.each([null, '', '   '])('has no recipient without a household address (%j)', async email => {
    const h = await household(email);
    await factory('members', h.gymId, { householdId: h.home.id, email: 'payer@example.invalid' });
    expect(await h.recipient()).toBeNull();
  });
  it('also suppresses for a named member who cannot receive email, and only when named', async () => {
    const h = await household('payer@example.invalid');
    const signer = await factory('members', h.gymId, { householdId: h.home.id, email: 'signer@example.invalid', emailDeliverable: false });
    const other = await factory('members', h.gymId, { householdId: h.home.id, email: 'other@example.invalid' });
    expect(await h.recipient()).toEqual({ email: 'payer@example.invalid', suppressed: false });
    expect(await h.recipient(other.id)).toEqual({ email: 'payer@example.invalid', suppressed: false });
    expect(await h.recipient(signer.id)).toEqual({ email: 'payer@example.invalid', suppressed: true });
  });
  it("never reads another gym's household or members", async () => {
    const a = await household('payer@example.invalid'), b = await household('other@example.invalid');
    expect(await db.forGym(a.gymId, tx => householdRecipient(tx, a.gymId, b.home.id))).toBeNull();
    expect(await db.forGym(a.gymId, tx => householdRecipient(tx, b.gymId, b.home.id))).toBeNull();
  });
});
