// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, desc, eq } from 'drizzle-orm';
import { auditEvents, type forGym, type Transaction } from '@plaingym/db';
import { holdGymSettings } from '../settings/settings.js';

export const stripeTestClearedAction = 'integrations.stripe_test_cleared';
/** One ordering for every reader of the gym's latest committed test-to-live switch. */
export async function latestTestSwitch(tx: Transaction, gymId: string): Promise<{ id: string; occurredAt: Date } | null> {
  const [row] = await tx.select({ id: auditEvents.id, occurredAt: auditEvents.occurredAt }).from(auditEvents)
    .where(and(eq(auditEvents.action, stripeTestClearedAction), eq(auditEvents.targetType, 'gym'), eq(auditEvents.targetId, gymId)))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1);
  return row ?? null;
}
export const latestTestSwitchId = async (tx: Transaction, gymId: string): Promise<string | null> => (await latestTestSwitch(tx, gymId))?.id ?? null;

/** Lock before any invoice/household locks, then compare the snapshot taken before resolving Stripe. */
export async function stripeWriteCurrent(tx: Transaction, gymId: string, switched?: string | null): Promise<boolean> {
  await holdGymSettings(tx, gymId);
  return switched === undefined || await latestTestSwitchId(tx, gymId) === switched;
}

const writes = new AsyncLocalStorage<{ gymId: string; switched: string | null }>();
const guardedScopes = new WeakSet<typeof forGym>();
/** The inbox finishes this event as skipped; the stale transaction has already rolled back. */
export class StripeTestModeSwitched extends Error {
  constructor() { super('Stripe test mode was cleared'); }
}
/** Carries a test provider's snapshot across separately committed handler and transition transactions, never a transaction. */
export function withStripeTestWrites<T>(gymId: string, switched: string | null, work: () => Promise<T>): Promise<T> {
  return writes.run({ gymId, switched }, work);
}
/** Every guarded transaction takes the switch's gym lock before it can read or write cleared references. */
export function stripeWriteScope(scope: typeof forGym): typeof forGym {
  if (guardedScopes.has(scope)) return scope;
  const guarded: typeof forGym = (gymId, work) => scope(gymId, async tx => {
    const pending = writes.getStore();
    if (pending) {
      if (pending.gymId !== gymId) throw new Error('Stripe write gym mismatch');
      if (!await stripeWriteCurrent(tx, gymId, pending.switched)) throw new StripeTestModeSwitched();
    }
    return work(tx);
  });
  guardedScopes.add(guarded);
  return guarded;
}
