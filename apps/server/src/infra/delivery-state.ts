// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { databaseCode, forGym, isConnectionError, uuidv7, type emailDeliveries, type smsDeliveries, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as systemClock } from '../core/clock.js';

export type DeliveryState = 'sending' | 'accepted' | 'unknown' | 'not_accepted';
export interface DeliveryReservation { readonly gymId: string; readonly id: string; readonly attempts: number }
type Acceptance = 'not_accepted' | 'unknown';
type Result = { status: 'sent' | 'suppressed' };
/** Waits before the second and third outcome write. */
export const recordRetryDelaysMs = [50, 200] as const;
/** A lost connection, serialization failure or deadlock can succeed on a later try; any other error fails at once. */
const transient = (error: unknown) => {
  const code = databaseCode(error);
  return isConnectionError(error) || code === '40001' || code === '40P01';
};
/** Error policies retain email's causes and rethrows while SMS exposes only safe fixed errors. */
export interface DeliveryErrors {
  acceptance(error: unknown): Acceptance;
  record(error: unknown): unknown;
  build(error: unknown): unknown;
  buildRelease(error: unknown, cause: unknown): unknown;
  transport(error: unknown): unknown;
  outcome(acceptance: Acceptance, cause: unknown, transportError?: { error: unknown }): unknown;
  reserve(error: unknown): unknown;
  inFlight(): unknown;
}

/** Durable reservations shared by email and SMS. Only proven non-sends can claim a subsequent attempt. */
export function createDeliveryState<Message, SendResult extends Result>(config: {
  table: typeof emailDeliveries | typeof smsDeliveries; validKey(key: string): void; inFlightMs: number;
  name: string; errors: DeliveryErrors;
}, options: { scope?: typeof forGym; clock?: Clock } = {}) {
  const { table, validKey, inFlightMs, name, errors } = config;
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  const stillSending = () => new AppError('conflict', `This ${name} is still being sent`);
  const otherRequest = () => new AppError('conflict', 'This send generation belongs to another request');
  const settled = (row: { state: string; updatedAt: Date }): DeliveryState =>
    row.state === 'sending' && row.updatedAt.getTime() <= clock.now().getTime() - inFlightMs ? 'unknown' : row.state as DeliveryState;
  async function state(gymId: string, key: string): Promise<DeliveryState | undefined>;
  async function state(tx: Transaction, gymId: string, key: string): Promise<DeliveryState | undefined>;
  async function state(txOrGym: Transaction | string, gymOrKey: string, transactionKey?: string): Promise<DeliveryState | undefined> {
    if (typeof txOrGym === 'string') return scope(txOrGym, tx => state(tx, txOrGym, gymOrKey));
    const tx = txOrGym, gymId = gymOrKey, key = transactionKey!;
    validKey(key);
    const [row] = await tx.select({ state: table.state, updatedAt: table.updatedAt })
      .from(table).where(and(eq(table.gymId, gymId), eq(table.key, key)));
    return row && settled(row);
  }
  async function claim(tx: Transaction, gymId: string, key: string, digest?: string) {
    validKey(key);
    const now = clock.now();
    const [created] = await tx.insert(table).values({ id: uuidv7(now.getTime()), gymId, key, state: 'sending',
      attempts: 1, commandDigest: digest ?? null, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: [table.gymId, table.key] }).returning({ id: table.id, attempts: table.attempts });
    if (created) return created;
    const [row] = await tx.select().from(table).where(and(eq(table.gymId, gymId), eq(table.key, key))).for('update');
    if (!row) throw new Error(`${name[0]!.toUpperCase() + name.slice(1)} delivery reservation vanished`);
    // Two requests can both pass replay before either reserves; compare again under the lock.
    if (digest !== undefined && row.commandDigest !== digest) throw otherRequest();
    const current = settled(row);
    if (current === 'sending') return { inFlight: true as const };
    if (current !== 'not_accepted') return { skipped: current as 'accepted' | 'unknown' };
    await tx.update(table).set({ state: 'sending', attempts: row.attempts + 1, updatedAt: now }).where(eq(table.id, row.id));
    return { id: row.id, attempts: row.attempts + 1 };
  }
  /** Retry only the outcome transaction, never the transport, and only after a transient database error, with a short
   * backoff; a lost commit acknowledgement is safe too, since the guarded update matches only the reserved attempt. */
  async function record(reservation: DeliveryReservation, next: Exclude<DeliveryState, 'sending'>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await scope(reservation.gymId, tx => tx.update(table).set({ state: next, updatedAt: clock.now() })
          .where(and(eq(table.id, reservation.id), eq(table.attempts, reservation.attempts), eq(table.state, 'sending'))));
        return;
      } catch (error) {
        if (attempt === 2 || !transient(error)) throw errors.record(error);
        const ms = recordRetryDelaysMs[attempt as 0 | 1];
        await new Promise(resolve => setTimeout(resolve, ms));
      }
    }
  }
  async function attempt(reservation: DeliveryReservation, transport: (message: Message) => Promise<SendResult>,
    message: Message | (() => Message | Promise<Message>)): Promise<SendResult> {
    assertNoTransaction(`${name}.deliveries.send`);
    let built: Message;
    try { built = typeof message === 'function' ? await (message as () => Message | Promise<Message>)() : message; }
    catch (error) {
      try { await release(reservation); }
      catch (cause) { throw errors.buildRelease(error, cause); }
      throw errors.build(error);
    }
    let result: SendResult;
    try { result = await transport(built); }
    catch (error) {
      try { await record(reservation, errors.acceptance(error) === 'not_accepted' ? 'not_accepted' : 'unknown'); }
      catch (cause) { throw errors.outcome(errors.acceptance(error), cause, { error }); }
      throw errors.transport(error);
    }
    try { await record(reservation, result.status === 'sent' ? 'accepted' : 'not_accepted'); }
    catch (cause) { throw errors.outcome(result.status === 'sent' ? 'unknown' : 'not_accepted', cause); }
    return result;
  }
  async function send(gymId: string, key: string, transport: (message: Message) => Promise<SendResult>, message: Message):
    Promise<SendResult | { status: 'skipped'; state: 'accepted' | 'unknown' }> {
    assertNoTransaction(`${name}.deliveries.send`);
    let reserved: Awaited<ReturnType<typeof claim>>;
    try { reserved = await scope(gymId, tx => claim(tx, gymId, key)); }
    catch (error) { throw errors.reserve(error); }
    if ('inFlight' in reserved) throw errors.inFlight();
    if ('skipped' in reserved) return { status: 'skipped', state: reserved.skipped };
    return attempt({ gymId, ...reserved }, transport, message);
  }
  async function replay(tx: Transaction, gymId: string, key: string, digest: string): Promise<{ result: unknown; outcome?: 'unknown' } | undefined> {
    validKey(key);
    const [row] = await tx.select().from(table).where(and(eq(table.gymId, gymId), eq(table.key, key)));
    if (!row) return undefined;
    if (row.commandDigest !== digest) throw otherRequest();
    const current = settled(row);
    if (current === 'sending') throw stillSending();
    return current === 'not_accepted' ? undefined : { result: row.commandResult, ...(current === 'unknown' ? { outcome: 'unknown' as const } : {}) };
  }
  async function reserve(tx: Transaction, gymId: string, key: string, digest: string): Promise<DeliveryReservation>;
  async function reserve(tx: Transaction, gymId: string, key: string): Promise<DeliveryReservation | undefined>;
  async function reserve(tx: Transaction, gymId: string, key: string, digest?: string): Promise<DeliveryReservation | undefined> {
    const reserved = await claim(tx, gymId, key, digest);
    if ('skipped' in reserved && digest === undefined) return undefined;
    if ('inFlight' in reserved || 'skipped' in reserved) throw stillSending();
    return { gymId, ...reserved };
  }
  async function remember(tx: Transaction, reservation: DeliveryReservation, result: unknown): Promise<void> {
    await tx.update(table).set({ commandResult: result }).where(eq(table.id, reservation.id));
  }
  async function release(reservation: DeliveryReservation): Promise<void> { await record(reservation, 'not_accepted'); }
  return { state, send, replay, reserve, remember, attempt, release };
}
