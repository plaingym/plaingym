// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, eq, gte, inArray, isNotNull, isNull, max, min, or } from 'drizzle-orm';
import { auditEvents, forGym, forSystem, paymentAttempts, stripeEvents, uuidv7, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { z } from 'zod';
import { clock as systemClock } from '../../../core/clock.js';
import { logError, stackFrames, type LogFields } from '../../../core/log.js';
import { recentWebhookFailureMs, type WebhookHealthQuery } from '../../../core/interfaces/webhook-health.js';
import type { JobContext, Jobs, JobRecovery } from '../../../infra/jobs/index.js';
import type { PaymentEvent, Payments } from '../../../infra/payments/index.js';
import { PaymentWebhookError } from '../../../infra/payments/webhook-error.js';
import { createWebhookInboxRecovery, webhookDispatchRetried } from './inbox-recovery.js';
import { latestTestSwitch, stripeSwitchSnapshot, StripeTestModeSwitched, withProviderWrites } from '../stripe-writes.js';

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
// A newer release may persist more fields. An older reader keeps the fields it knows after rollback.
const storedEventSchema = z.object(eventSchema.shape);
/** Audited when a Stripe test-mode event is finished, unread, for a gym whose key is now live. */
export const testEventSkippedAction = 'billing.webhook.test_event_skipped';
/**
 * The billing handlers' own fixed failure texts. A failed handler's message is logged only when it is one of
 * these, thrown as a plain `Error`; any other text (a provider's, or one holding an ID or a name) is left out.
 */
export const handlerFailureReasons: ReadonlySet<string> = new Set([
  'Payments are not configured for this gym', 'Billing retry runner is not configured',
  'Webhook payment object is unresolved', 'Payment success time is unresolved', 'Checkout link gym mismatch',
  'Checkout link session is unresolved', 'Checkout link session mismatch', 'Checkout link association is unresolved',
  'Webhook PaymentIntent is unresolved', 'Webhook payment gym mismatch', 'Webhook invoice is unmatched or ambiguous',
  'Webhook invoice is unresolved', 'Webhook payment customer mismatch', 'Webhook attempt is unresolved',
  'Webhook payment amount mismatch', 'Webhook bank account mismatch', 'Refund payment is unresolved',
  'Dispute payment is unresolved', 'Refund payment mismatch', 'Webhook gym mismatch', 'Webhook object kind mismatch',
  'Expected PaymentIntent', 'Refunded charge has no resolved refunds', 'Refund parent mismatch',
  'Invoice has another dispute; staff resolution required', 'Checkout gym mismatch', 'Checkout invoice mismatch',
  'Checkout payment amount mismatch', 'Completed Checkout payment is unresolved',
  'Collected payment method is unresolved', 'Completed Checkout setup is unresolved',
  'Payment method creation time is unresolved', 'Saved card household is unresolved', 'Saved card household mismatch',
  'SetupIntent is unresolved', 'SetupIntent gym mismatch', 'Successful SetupIntent has no payment method',
]);
const fixedReasonText = /^[A-Za-z][A-Za-z ]{0,99}$/;
function failureReason(error: unknown) {
  return error instanceof Error && error.constructor === Error && handlerFailureReasons.has(error.message)
    && fixedReasonText.test(error.message) ? error.message : undefined;
}
const errorIdentifier = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const errorCode = /^[A-Za-z0-9_]{1,32}$/;
function errorNameAndCode(error: unknown) {
  const name = error instanceof Error && errorIdentifier.test(error.name) ? error.name : typeof error;
  const code = error instanceof Error ? (error as unknown as Record<string, unknown>).code : undefined;
  return { name, ...(typeof code === 'string' && errorCode.test(code) ? { code } : {}) };
}
/**
 * A failed handler's diagnostics, built here rather than by the shared logger: the error's name and code, its
 * stack frames, and its cause's name and code. No field is read from message text. Frames come from the shared
 * logger's `stackFrames`, taken only after the stack's exact `name: message` header, so a multiline message never
 * passes for a frame.
 */
export function handlerFailureFields(error: unknown): LogFields {
  const { name, code } = errorNameAndCode(error);
  const fields: Record<string, string> = { errorName: name, ...(code ? { errorCode: code } : {}) };
  if (error instanceof Error) {
    const frames = stackFrames(error);
    if (frames.length > 0) fields.errorFrames = frames.join('\n');
  }
  if (error instanceof Error && error.cause !== undefined) {
    const cause = errorNameAndCode(error.cause);
    fields.causeName = cause.name;
    if (cause.code) fields.causeCode = cause.code;
  }
  return fields;
}
// Read from a stored job: unknown keys are ignored for the same reason.
const dispatchSchema = z.object({ eventId: z.string().min(1), replay: z.boolean().optional() });

export function createWebhookInbox(options: {
  paymentsFor: PaymentsResolver;
  jobs: Jobs;
  recovery?: JobRecovery;
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
      const latest = await latestTestSwitch(tx, gymId);
      return latest !== null && row.receivedAt < latest.occurredAt;
    });
  }
  async function stored(gymId: string, eventId: string) {
    return scope(gymId, async (tx) => (await tx.select().from(stripeEvents).where(match(gymId, eventId)))[0]);
  }
  return {
    recoverFailed: createWebhookInboxRecovery({ job: webhookDispatchJob, scope, clock, ...(options.recovery ? { recovery: options.recovery } : {}) }),
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
      // A redelivery also recovers a dispatch that used all its attempts; its audit counts toward the sweep's limit.
      // Reset only this gym's failed original job; concurrent deliveries cannot reset queued or running work.
      if (options.recovery) for (const job of await options.recovery.failedJobs(webhookDispatchJob, [row.id], { gymId }))
        if (await options.recovery.retryFailed(job.jobId, { gymId, runAt: clock.now() }))
          await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: webhookDispatchRetried,
            targetType: 'stripe_event', targetId: row.id, after: { jobId: job.jobId }, occurredAt: clock.now() }));
    },
    async dispatch(payload: unknown, context: JobContext): Promise<void> {
      const input = dispatchSchema.parse(payload);
      const logFailure = (error: unknown, type?: string) => {
        const reason = failureReason(error);
        logError('billing.webhooks.handler_failed', { gymId: context.gymId, eventId: input.eventId,
          ...(type ? { type } : {}), ...(reason ? { reason } : {}), ...handlerFailureFields(error) });
      };
      let row: Awaited<ReturnType<typeof stored>>;
      try {
        row = await stored(context.gymId, input.eventId);
      } catch (error) {
        if (input.replay === true) {
          try {
            await scope(context.gymId, (tx) => tx.update(stripeEvents).set({ error: 'handler_failed', failedAt: clock.now() })
              .where(match(context.gymId, input.eventId)));
          } catch { /* Best effort: keep and rethrow the original read failure. */ }
        }
        logFailure(error);
        throw error;
      }
      if (!row || (row.processedAt && !input.replay)) return;
      try {
        const event = storedEventSchema.parse(row.payload);
        if (event.gymId !== context.gymId || event.id !== row.eventId || event.type !== row.type)
          throw new Error('Invalid stored webhook identity');
        const handler = handlers.get(event.type);
        const switched = handler ? await scope(context.gymId, tx => stripeSwitchSnapshot(tx, context.gymId)) : null;
        const payments = handler ? await paymentsFor(context.gymId) : null;
        // The live key can't read a test-mode object, so its handler would fail every retry: the event is finished unread.
        let skipped = payments?.keyMode === 'live' && await testMode(context.gymId, row, event);
        if (handler && payments && !skipped) {
          const handle = () => handler(event, { ...context, payments });
          try {
            if (event.livemode === true) await handle();
            else await withProviderWrites(payments, context.gymId, switched, handle);
          } catch (error) {
            if (!(error instanceof StripeTestModeSwitched)) throw error;
            skipped = true;
          }
        }
        await scope(context.gymId, async (tx) => {
          await tx.update(stripeEvents).set({ processedAt: clock.now(), error: null, failedAt: null }).where(match(context.gymId, input.eventId));
          if (skipped) await writeAudit(tx, { gymId: context.gymId, actorKind: 'system', action: testEventSkippedAction,
            targetType: 'stripe_event', targetId: row.id, before: null, after: { eventId: event.id, type: event.type }, occurredAt: clock.now() });
        });
      } catch (error) {
        try {
          await scope(context.gymId, (tx) => tx.update(stripeEvents).set({ error: 'handler_failed', failedAt: clock.now() })
            .where(match(context.gymId, input.eventId)));
        } catch { /* Best effort: keep and rethrow the handler's error. */ }
        logFailure(error, row.type);
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
        .where(and(eq(stripeEvents.gymId, gymId), isNull(stripeEvents.processedAt), isNotNull(stripeEvents.error)));
      const [recent] = await tx.select({ total: count() }).from(stripeEvents)
        .where(and(eq(stripeEvents.gymId, gymId), isNull(stripeEvents.processedAt), isNotNull(stripeEvents.error),
          // A row that failed before failure times were recorded counts by when it was received.
          or(gte(stripeEvents.failedAt, since), and(isNull(stripeEvents.failedAt), gte(stripeEvents.receivedAt, since)))));
      // A save or a new endpoint starts the wait again: earlier charges say nothing about whether webhooks arrive now.
      // occurredAt comes from the service clock that also dates charge attempts; createdAt is the database's own clock.
      const [saved] = await tx.select({ at: max(auditEvents.occurredAt) }).from(auditEvents)
        .where(and(eq(auditEvents.gymId, gymId), inArray(auditEvents.action, ['integrations.stripe_saved',
          'setup.stripe_configured', 'payments.webhook_endpoint_replaced', 'payments.webhook_endpoint_recreated'])));
      const [first] = await tx.select({ at: min(paymentAttempts.createdAt) }).from(paymentAttempts)
        .where(and(eq(paymentAttempts.gymId, gymId), isNotNull(paymentAttempts.paymentIntentId),
          saved?.at ? gte(paymentAttempts.createdAt, saved.at) : undefined));
      return {
        lastReceivedAt: times?.received?.toISOString() ?? null, lastProcessedAt: times?.processed?.toISOString() ?? null,
        pendingCount: pending?.total ?? 0, failedCount: failed?.total ?? 0, recentFailedCount: recent?.total ?? 0,
        firstChargeAttemptAt: first?.at?.toISOString() ?? null,
      };
    });
  } };
}
