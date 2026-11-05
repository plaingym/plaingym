// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, desc, eq, gte, isNotNull, isNull, max } from 'drizzle-orm';
import { auditEvents, forGym, forSystem, stripeEvents, uuidv7, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { z } from 'zod';
import { clock as systemClock } from '../../../core/clock.js';
import { recentWebhookFailureMs, type WebhookHealthQuery } from '../../../core/interfaces/webhook-health.js';
import type { JobContext, Jobs } from '../../../infra/jobs/index.js';
import type { PaymentEvent, Payments } from '../../../infra/payments/index.js';
import { PaymentWebhookError } from '../../../infra/payments/webhook-error.js';
import { stripeTestClearedAction } from '../customers.js';

export const webhookDispatchJob = 'billing.webhooks.dispatch';
export type PaymentsResolver = (gymId: string) => Promise<Payments | null>;
/** Handlers re-read payment objects through Payments and apply idempotent transitions. */
export type WebhookHandler = (event: PaymentEvent, context: JobContext & { payments: Payments }) => Promise<void>;
/**
 * `livemode` is stored with the event: the mode of the key that verified it, which the provider checks against the
 * event's own. Events stored before it was recorded have none.
 */
const eventSchema = z.strictObject({
  id: z.string().min(1), type: z.string().min(1), gymId: z.uuid(), objectId: z.string().min(1),
  objectKind: z.enum(['charge', 'checkout', 'setup', 'payment_method', 'refund', 'dispute']),
  livemode: z.boolean().optional(),
});
/** Audited when a Stripe test-mode event is finished, unread, for a gym whose key is now live. */
export const testEventSkippedAction = 'billing.webhook.test_event_skipped';
const dispatchSchema = z.strictObject({ eventId: z.string().min(1), replay: z.boolean().optional() });

export function createWebhookInbox(options: {
  paymentsFor: PaymentsResolver;
  jobs: Jobs;
  gymSettings: { get(gymId: string): Promise<{ timezone: string }> };
  clock?: Clock;
  scope?: typeof forGym;
  system?: typeof forSystem;
}) {
  const scope = options.scope ?? forGym, system = options.system ?? forSystem, clock = options.clock ?? systemClock;
  const handlers = new Map<string, WebhookHandler>();
  const match = (gymId: string, eventId: string) => and(eq(stripeEvents.gymId, gymId), eq(stripeEvents.eventId, eventId));
  async function paymentsFor(gymId: string) {
    const payments = await options.paymentsFor(gymId);
    if (!payments) throw new AppError('unavailable', 'Payments are not set up for this gym');
    return payments;
  }
  /**
   * Whether a stored event is from Stripe test mode: its recorded `livemode`, or, for one stored before that was recorded,
   * whether it arrived before the gym's latest switch from test to live (the key was a test key until then).
   */
  async function testMode(gymId: string, row: typeof stripeEvents.$inferSelect, event: z.infer<typeof eventSchema>) {
    if (event.livemode !== undefined) return !event.livemode;
    return scope(gymId, async (tx) => {
      const [latest] = await tx.select({ at: auditEvents.occurredAt }).from(auditEvents)
        .where(and(eq(auditEvents.action, stripeTestClearedAction), eq(auditEvents.targetId, gymId)))
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
      return latest !== undefined && row.receivedAt < latest.at;
    });
  }
  async function stored(gymId: string, eventId: string) {
    return scope(gymId, async (tx) => (await tx.select().from(stripeEvents).where(match(gymId, eventId)))[0]);
  }
  return {
    register(type: string, handler: WebhookHandler) {
      if (!type || handlers.has(type)) throw new Error('Duplicate or empty webhook handler');
      handlers.set(type, handler);
    },
    async receive(gymId: string, body: Uint8Array, signature: string): Promise<void> {
      // Verification and any provider ownership lookups must finish before the inbox write.
      const provider = await paymentsFor(gymId);
      const event = eventSchema.parse(await provider.parseWebhook(body, signature));
      if (event.gymId !== gymId) throw new PaymentWebhookError('webhook_not_for_gym');
      const { timezone } = await options.gymSettings.get(gymId);
      const payload = provider.keyMode ? { ...event, livemode: provider.keyMode === 'live' } : event;
      await system((tx) => tx.insert(stripeEvents).values({ eventId: event.id, gymId, type: event.type,
        payload, receivedAt: clock.now() }).onConflictDoNothing({ target: stripeEvents.eventId }));
      // A delivery can die after insertion but before enqueue. A duplicate repairs that gap;
      // the queue's persistent idempotency key still creates only one dispatch job.
      const row = await stored(gymId, event.id);
      if (!row || row.processedAt) return;
      await options.jobs.enqueue(webhookDispatchJob, { eventId: event.id }, {
        gymId, timezone, idempotencyKey: row.id, maxAttempts: 10,
      });
    },
    async dispatch(payload: unknown, context: JobContext): Promise<void> {
      const input = dispatchSchema.parse(payload), row = await stored(context.gymId, input.eventId);
      if (!row || (row.processedAt && !input.replay)) return;
      try {
        const event = eventSchema.parse(row.payload);
        if (event.gymId !== context.gymId || event.id !== row.eventId || event.type !== row.type)
          throw new Error('Invalid stored webhook identity');
        const handler = handlers.get(event.type);
        const payments = handler ? await paymentsFor(context.gymId) : null;
        // The live key can't read a test-mode object, so its handler would fail every retry: the event is finished unread.
        const skipped = payments?.keyMode === 'live' && await testMode(context.gymId, row, event);
        if (handler && payments && !skipped) await handler(event, { ...context, payments });
        await scope(context.gymId, async (tx) => {
          await tx.update(stripeEvents).set({ processedAt: clock.now(), error: null }).where(match(context.gymId, input.eventId));
          if (skipped) await writeAudit(tx, { gymId: context.gymId, actorKind: 'system', action: testEventSkippedAction,
            targetType: 'stripe_event', targetId: row.id, before: null, after: { eventId: event.id, type: event.type }, occurredAt: clock.now() });
        });
      } catch (error) {
        // Provider error messages may contain secrets or personal data. Keep a safe marker only.
        await scope(context.gymId, (tx) => tx.update(stripeEvents).set({ processedAt: null, error: 'handler_failed' })
          .where(match(context.gymId, input.eventId)));
        throw error; // The job queue owns retry/backoff and the attempt limit.
      }
    },
    async replay(gymId: string, eventId: string): Promise<{ jobId: string }> {
      if (!await stored(gymId, eventId)) throw new AppError('not_found', 'Webhook event not found');
      const { timezone } = await options.gymSettings.get(gymId);
      // Replays deliberately bypass both the delivery key and the processed guard.
      return options.jobs.enqueue(webhookDispatchJob, { eventId, replay: true }, {
        gymId, timezone, idempotencyKey: 'replay:' + uuidv7(), maxAttempts: 10,
      });
    },
  };
}
export type WebhookInbox = ReturnType<typeof createWebhookInbox>;

/** System-table ownership stays in the inbox; consumers receive safe per-gym aggregates only. */
export function createWebhookHealthQuery(scope: typeof forGym = forGym, clock: Clock = systemClock): WebhookHealthQuery {
  return { async get(gymId) {
    const since = new Date(clock.now().getTime() - recentWebhookFailureMs);
    return scope(gymId, async (tx) => {
      const [times] = await tx.select({ received: max(stripeEvents.receivedAt), processed: max(stripeEvents.processedAt) })
        .from(stripeEvents).where(eq(stripeEvents.gymId, gymId));
      const [pending] = await tx.select({ total: count() }).from(stripeEvents)
        .where(and(eq(stripeEvents.gymId, gymId), isNull(stripeEvents.processedAt), isNull(stripeEvents.error)));
      const [failed] = await tx.select({ total: count() }).from(stripeEvents)
        .where(and(eq(stripeEvents.gymId, gymId), isNotNull(stripeEvents.error)));
      const [recent] = await tx.select({ total: count() }).from(stripeEvents)
        .where(and(eq(stripeEvents.gymId, gymId), isNotNull(stripeEvents.error), gte(stripeEvents.receivedAt, since)));
      return { lastReceivedAt: times?.received?.toISOString() ?? null, lastProcessedAt: times?.processed?.toISOString() ?? null,
        pendingCount: pending?.total ?? 0, failedCount: failed?.total ?? 0, recentFailedCount: recent?.total ?? 0 };
    });
  } };
}
