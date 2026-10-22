// SPDX-License-Identifier: AGPL-3.0-only
import { inArray } from 'drizzle-orm';
import { authUser, type Transaction } from '@plaingym/db';
import { idSchema } from '@plaingym/shared/contracts';

/** Only deterministic sandbox identities are disposable; ordinary identities remain shared. */
export async function deleteDemoIdentities(tx: Transaction, gymId: string): Promise<void> {
  idSchema.parse(gymId);
  const emails = ['owner', 'coach', 'student'].map((role) => `${role}.${gymId}@example.invalid`);
  await tx.delete(authUser).where(inArray(authUser.email, emails));
}
