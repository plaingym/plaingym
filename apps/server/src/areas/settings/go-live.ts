// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { forGym, gyms, members, households, classTemplates, memberships, plans, paymentMethods, paymentAttempts,
  refunds, waiverTemplates, auditEvents, revisionGuard, assertRevised, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import { localDate } from '@plaingym/shared/time';
import { locales } from '@plaingym/shared/locales';
import { goLiveChecklistResponseSchema, updateGoLiveRequestSchema, type GoLiveChecklistItem, type UpdateGoLiveRequest } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';
import type { WebhookHealthQuery } from '../../core/interfaces/webhook-health.js';
import { createWebhookHealthQuery } from '../billing/webhooks/inbox.js';
import { signedLinkWaiversComplete } from '../waivers/waivers.js';
import { rerunRestoreReconciliation } from '../billing/runner/runner.jobs.js';
import { readRestoreCheck } from './go-live.restore.js';

const t = createTranslator(locales.en ?? {});
type WireChecklist = ReturnType<typeof goLiveChecklistResponseSchema.parse>['data'];
type Checklist = WireChecklist & { pastDueMemberships: NonNullable<WireChecklist['pastDueMemberships']> };
type Status = GoLiveChecklistItem['status'];
const item = (id: GoLiveChecklistItem['id'], status: Status): GoLiveChecklistItem =>
  ({ id, status, message: t(`settings/go-live:check.${id}.${status}`) });
const ready = (value: unknown): Status => value ? 'ready' : 'needs_attention';
/** Credentials and opaque settings are read here, never returned or audited. */
const projection = {
  revision: gyms.revision, timezone: gyms.timezone, billingEnabled: gyms.billingEnabled, memberEmailsEnabled: gyms.memberEmailsEnabled,
  settings: gyms.settings, stripeConfigured: gyms.stripeConfig, backupPublicKey: gyms.backupPublicKey, backupDestination: gyms.backupDestination,
};
const switches = (row: { billingEnabled: boolean; memberEmailsEnabled: boolean }) =>
  ({ billingEnabled: row.billingEnabled, memberEmailsEnabled: row.memberEmailsEnabled });
const dates = (rows: readonly { id: string; revision: number; nextDueOn: string }[]) =>
  rows.map(({ id, revision, nextDueOn }) => ({ id, revision, nextDueOn })).sort((a, b) => a.id.localeCompare(b.id));

async function pastDue(tx: Transaction, today: string, lock = false) {
  const query = tx.select({ id: memberships.id, revision: memberships.revision, nextDueOn: memberships.nextDueOn,
    memberId: members.id, memberName: members.firstName, lastName: members.lastName, planName: plans.name })
    .from(memberships).innerJoin(members, eq(members.id, memberships.memberId)).innerJoin(plans, eq(plans.id, memberships.planId))
    .where(and(eq(memberships.status, 'active'), lt(memberships.nextDueOn, today)))
    .orderBy(asc(memberships.nextDueOn), asc(memberships.id));
  const rows = await (lock ? query.for('update', { of: memberships }) : query);
  return rows.map(({ memberName, lastName, ...row }) => ({ ...row, memberName: `${memberName} ${lastName}`.trim() }));
}

/**
 * `stripe` is whether the gym has a payments provider now. A restore check that ran without one read only the database,
 * so once Stripe is connected it no longer clears the restore: a check with Stripe must read what Stripe holds.
 */
async function reconciliation(tx: Transaction, stripe: boolean) {
  const [pending] = await tx.select({ id: paymentAttempts.id }).from(paymentAttempts).where(eq(paymentAttempts.status, 'pending')).limit(1);
  const [pendingRefund] = await tx.select({ id: refunds.id }).from(refunds).where(eq(refunds.status, 'pending')).limit(1);
  const { restore, request, checked, report } = await readRestoreCheck(tx);
  const snapshotAt = (request?.after as { snapshotAt?: string } | undefined)?.snapshotAt ?? null;
  const clear = report?.unresolved === 0 && (report.stripeConfigured !== false || !stripe);
  return { applicable: !!restore || !!pending || !!pendingRefund, restored: !!restore,
    detail: restore ? { restoreId: restore.id, snapshotAt, checkedAt: checked?.occurredAt.toISOString() ?? null,
      inspected: report?.inspected ?? null, unresolved: report?.unresolved ?? null, stripeConfigured: report?.stripeConfigured ?? null } : null,
    ready: !pending && !pendingRefund && (!restore || clear),
    // Nothing was left to reconcile: no pending work, and any restore's check found no payment objects at all.
    empty: !pending && !pendingRefund && (!restore || (clear && report.inspected === 0)) };
}

/**
 * A check that started this long ago without a result is taken to have died with its process, so a rerun may start
 * again. A live check reads every payment change since the snapshot from Stripe, which can take minutes.
 */
export const restoreCheckLifetimeMs = 15 * 60_000;
type Marker = { id: string; createdAt: Date; occurredAt: Date };
const later = (a: Marker, b: Marker) => a.createdAt > b.createdAt || (a.createdAt.getTime() === b.createdAt.getTime() && a.id > b.id);
/**
 * Whether a check for `restoreId` is still running: the latest one started without a result, or a rerun was asked for
 * and has neither started its check nor failed before it. Runs under the gym row's lock, which every rerun takes first,
 * so two reruns can't both find none running.
 */
async function restoreCheckRunning(tx: Transaction, restoreId: string, now: Date) {
  const latest = async (action: string, targetId: string): Promise<Marker | undefined> => (await tx
    .select({ id: auditEvents.id, createdAt: auditEvents.createdAt, occurredAt: auditEvents.occurredAt }).from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId)))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1))[0];
  const live = (marker: Marker) => now.getTime() - marker.occurredAt.getTime() < restoreCheckLifetimeMs;
  const started = await latest('billing.runner.restore_check_started', restoreId);
  if (started && live(started) && !await latest('billing.runner.restore_checked', started.id)) return true;
  const requested = await latest('settings.go_live.reconciliation_requested', restoreId);
  if (!requested || !live(requested) || (started && later(started, requested))) return false;
  const failed = await latest('settings.go_live.reconciliation_failed', restoreId);
  return !failed || !later(failed, requested);
}

export function createGoLiveService(options: {
  scope?: typeof forGym; clock?: Clock; smtpConfigured: (gymId: string) => Promise<boolean>; webhooks?: WebhookHealthQuery;
  /** The runtime's payments resolver; defaults to the gym's stored Stripe settings (demo sandboxes share an install account). */
  paymentsConfigured?: (gymId: string) => Promise<boolean>;
  restoreCheck?: typeof rerunRestoreReconciliation;
}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const webhooks = options.webhooks ?? createWebhookHealthQuery(scope);
  async function checklist(gymId: string): Promise<Checklist> {
    // These accessors open their own short transactions, so run outside our scope.
    const [smtp, webhook, payments] = await Promise.all([options.smtpConfigured(gymId), webhooks.get(gymId),
      options.paymentsConfigured?.(gymId)]);
    return scope(gymId, async (tx) => {
      const [gym] = await tx.select(projection).from(gyms).where(eq(gyms.id, gymId));
      if (!gym) throw new AppError('not_found', t('settings/go-live:notFound'));
      const people = await tx.select({ id: members.id }).from(members).where(and(eq(members.status, 'active'), isNull(members.anonymizedAt)));
      const [member] = await tx.select({ id: members.id }).from(members).where(isNull(members.anonymizedAt)).limit(1);
      const [template] = await tx.select({ id: classTemplates.id }).from(classTemplates).limit(1);
      const billable = await tx.selectDistinct({ householdId: memberships.householdId, customerId: households.stripeCustomerId }).from(memberships)
        .innerJoin(households, eq(households.id, memberships.householdId))
        .where(and(inArray(memberships.status, ['active', 'trial', 'pending']), gt(memberships.amountCents, 0)));
      const cards = await tx.select({ householdId: paymentMethods.householdId, expiryYear: paymentMethods.expiryYear, expiryMonth: paymentMethods.expiryMonth }).from(paymentMethods)
        .where(and(eq(paymentMethods.isDefault, true), isNull(paymentMethods.revokedAt)));
      const currentWaivers = await tx.selectDistinctOn([waiverTemplates.name]).from(waiverTemplates)
        .orderBy(waiverTemplates.name, desc(waiverTemplates.version));
      const stripe = payments ?? Boolean(gym.stripeConfigured);
      const recovery = await reconciliation(tx, stripe);
      const today = localDate(clock.now(), gym.timezone), thisMonth = today.slice(0, 7);
      const pastDueMemberships = await pastDue(tx, today);
      const setup = (gym.settings as { setup?: { completed?: boolean } }).setup;
      const result = goLiveChecklistResponseSchema.shape.data.parse({ revision: gym.revision, ...switches(gym), pastDueMemberships,
        restoreReconciliation: recovery.detail, items: [
        item('gym_details', ready(!setup || setup.completed)),
        item('members_imported', ready(member)),
        item('schedule_ready', ready(template)),
        item('stripe_ready', ready(stripe)),
        item('cards_collected', !stripe || !billable.length ? 'not_applicable'
          : ready(billable.every(home => home.customerId && cards.some(card => card.householdId === home.householdId
            && (!card.expiryYear || !card.expiryMonth || `${card.expiryYear}-${String(card.expiryMonth).padStart(2, '0')}` >= thisMonth))))),
        item('waivers_signed', !people.length || !currentWaivers.some(w => !w.retiredAt) ? 'not_applicable'
          : ready(await signedLinkWaiversComplete(tx, people.map(p => p.id)))),
        item('smtp_ready', ready(smtp)),
        item('backup_ready', ready(gym.backupPublicKey && gym.backupDestination)),
        item('webhook_ready', !stripe ? 'not_applicable'
          : ready(webhook.lastProcessedAt && !webhook.pendingCount && !webhook.failedCount)),
        item('reconciliation_complete', !stripe && recovery.empty ? 'not_applicable' : ready(recovery.ready)),
        item('past_due_dates', ready(!pastDueMemberships.length)),
      ] });
      return { ...result, pastDueMemberships };
    });
  }
  return {
    checklist,
    async rerunReconciliation(context: MutationContext, input: { revision: number; restoreId: string }): Promise<Checklist> {
      const snapshotAt = await scope(context.gymId, async tx => {
        const [gym] = await tx.select(projection).from(gyms).where(eq(gyms.id, context.gymId)).for('update');
        if (!gym) throw new AppError('not_found', t('settings/go-live:notFound'));
        if (gym.revision !== input.revision) assertRevised([]);
        // Only the restore and its snapshot are read here; the check itself resolves the provider.
        const recovery = await reconciliation(tx, Boolean(gym.stripeConfigured));
        if (recovery.detail?.restoreId !== input.restoreId) throw new AppError('not_found', t('settings/go-live:notFound'));
        if (gym.billingEnabled || !recovery.detail.snapshotAt) throw new AppError('conflict', t('settings/go-live:reconcilePause'));
        // Two checks of one restore at once would apply the same payment changes side by side, and the one that started
        // first could finish last; a rerun waits for the running check's result instead.
        if (await restoreCheckRunning(tx, input.restoreId, clock.now()))
          throw new AppError('conflict', t('settings/go-live:reconcileBusy'), { restoreId: ['check_running'] });
        await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
          action: 'settings.go_live.reconciliation_requested', targetType: 'restore', targetId: input.restoreId, occurredAt: clock.now() });
        return recovery.detail.snapshotAt;
      });
      try { await (options.restoreCheck ?? rerunRestoreReconciliation)(context.gymId, new Date(snapshotAt), input.restoreId); }
      catch {
        // A check that failed before it started records nothing of its own, so the next rerun mustn't wait for it.
        await scope(context.gymId, (tx) => writeAudit(tx, { gymId: context.gymId, actorKind: 'system',
          action: 'settings.go_live.reconciliation_failed', targetType: 'restore', targetId: input.restoreId, occurredAt: clock.now() }))
          .catch(() => undefined);
        throw new AppError('unavailable', t('settings/go-live:reconcileError'));
      }
      return checklist(context.gymId);
    },
    async update(context: MutationContext, input: UpdateGoLiveRequest): Promise<Checklist> {
      const { revision, confirmedPastDueDates, ...changes } = updateGoLiveRequestSchema.parse(input);
      // Opens its own transaction, so resolve it first; only turning billing on reads it.
      const payments = changes.billingEnabled ? await options.paymentsConfigured?.(context.gymId) : undefined;
      await scope(context.gymId, async (tx) => {
        const [before] = await tx.select(projection).from(gyms).where(eq(gyms.id, context.gymId)).for('update');
        if (!before) throw new AppError('not_found', t('settings/go-live:notFound'));
        const guard = revisionGuard(gyms.revision, revision);
        // Check revisions first, even if the stale request also needs a date confirmation.
        if (before.revision !== revision) assertRevised([]);
        let confirmed: ReturnType<typeof dates> | undefined;
        if (!before.billingEnabled && changes.billingEnabled) {
          // `payments` was read before the lock: settings stored since then also count, so a Stripe save that commits
          // between the two can't clear a check that ran without Stripe.
          const recovery = await reconciliation(tx, Boolean(payments) || Boolean(before.stripeConfigured));
          if (recovery.restored && !recovery.ready)
            throw new AppError('conflict', t('settings/go-live:check.reconciliation_complete.needs_attention'));
          const overdue = await pastDue(tx, localDate(clock.now(), before.timezone), true);
          if (overdue.length) {
            confirmed = dates(overdue);
            if (!confirmedPastDueDates || JSON.stringify(dates(confirmedPastDueDates)) !== JSON.stringify(confirmed))
              throw new AppError('conflict', t('settings/go-live:confirmChanged'));
          }
        }
        const after = assertRevised(await tx.update(gyms).set({ ...changes, revision: guard.next, updatedAt: clock.now() })
          .where(and(eq(gyms.id, context.gymId), guard.matches)).returning(projection));
        await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
          action: 'settings.go_live.updated', targetType: 'gym', targetId: context.gymId,
          before: switches(before), after: switches(after), occurredAt: clock.now() });
        if (confirmed) await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
          action: 'settings.go_live.past_due_dates_confirmed', targetType: 'gym', targetId: context.gymId,
          after: { memberships: confirmed }, occurredAt: clock.now() });
      });
      return checklist(context.gymId);
    },
  };
}
export type GoLiveService = ReturnType<typeof createGoLiveService>;

let configured: GoLiveService | undefined;
export function configureGoLive(options: Parameters<typeof createGoLiveService>[0]) { configured = createGoLiveService(options); }
export function goLiveService(): GoLiveService {
  if (!configured) throw new AppError('unavailable', t('settings/go-live:unavailable'));
  return configured;
}
