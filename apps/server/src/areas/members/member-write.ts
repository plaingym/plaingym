// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { databaseCode, members, type forGym, type Transaction } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { logError } from '../../core/log.js';

/** A member visible before waiting for a lock may have been deleted by the time the lock is granted. */
export async function lockMemberForWrite(tx: Transaction, id: string, strength: 'share' | 'update') {
  if (!(await tx.select({ id: members.id }).from(members).where(eq(members.id, id)))[0])
    throw new AppError('not_found', 'Member not found');
  const [member] = await tx.select().from(members).where(eq(members.id, id)).for(strength);
  if (!member) throw new AppError('conflict', 'The member changed while waiting to save');
  return member;
}

/** Reference races are retryable conflicts in member-writing services; constraint identifiers remain in the log. */
export function memberWriteScope(scope: typeof forGym): typeof forGym {
  return (gymId, run) => scope(gymId, run).catch((error: unknown) => {
    const code = databaseCode(error);
    if (code === '23503' || code === '40P01') {
      logError(code === '23503' ? 'members.write.foreign_key' : 'members.write.deadlock', { gymId }, error);
      throw new AppError('conflict', 'The referenced record changed while saving');
    }
    throw error;
  });
}
