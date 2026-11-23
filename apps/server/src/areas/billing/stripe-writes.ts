// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, desc, eq, or } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Compare the saved and previous Stripe mode in the gym-scoped Payments save audit.
import { sql } from 'drizzle-orm';
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

const stripeSavedAction = 'integrations.stripe_saved';
/**
 * The write guard's snapshot: the gym's latest test-data clear, or the latest Payments save that changed the Stripe mode
 * (each audited in its save's transaction). A key read before either is stale even when the save had nothing to clear.
 * Cleared test data is still identified by `latestTestSwitch` alone.
 */
export async function stripeSwitchSnapshot(tx: Transaction, gymId: string): Promise<string | null> {
  // `<>` on purpose: a first save (no earlier mode) leaves no key to be stale, since the gym had no provider before it.
  const [row] = await tx.select({ id: auditEvents.id }).from(auditEvents)
    .where(and(eq(auditEvents.targetType, 'gym'), eq(auditEvents.targetId, gymId), or(eq(auditEvents.action, stripeTestClearedAction),
      and(eq(auditEvents.action, stripeSavedAction), sql`${auditEvents.before}->>'mode' <> ${auditEvents.after}->>'mode'`))))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1);
  return row?.id ?? null;
}

/** Lock before any invoice/household locks, then compare the snapshot taken before resolving Stripe. */
export async function stripeWriteCurrent(tx: Transaction, gymId: string, switched?: string | null): Promise<boolean> {
  await holdGymSettings(tx, gymId);
  return switched === undefined || await stripeSwitchSnapshot(tx, gymId) === switched;
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
/** Runs `work` under the switch snapshot unless the provider holds a live key: a test key, or a provider with no mode. */
export function withProviderWrites<T>(provider: { readonly keyMode?: 'test' | 'live' | undefined }, gymId: string,
  switched: string | null, work: () => Promise<T>): Promise<T> {
  return provider.keyMode === 'live' ? work() : withStripeTestWrites(gymId, switched, work);
}
/**
 * Compares `switched` under the gym row lock in the caller's transaction, whatever the key mode, and throws
 * `StripeTestModeSwitched` when a switch committed since it was read. Reconciliation calls it after a provider read that
 * ended with no guarded transaction, before a provider write and before it publishes a result: a live provider isn't
 * wrapped in the guard, but still stops at the first switch it sees.
 */
export async function assertStripeSnapshot(tx: Transaction, gymId: string, switched: string | null): Promise<void> {
  if (!await stripeWriteCurrent(tx, gymId, switched)) throw new StripeTestModeSwitched();
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
