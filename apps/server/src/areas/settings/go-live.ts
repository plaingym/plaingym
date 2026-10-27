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

async function reconciliation(tx: Transaction) {
  const [pending] = await tx.select({ id: paymentAttempts.id }).from(paymentAttempts).where(eq(paymentAttempts.status, 'pending')).limit(1);
  const [pendingRefund] = await tx.select({ id: refunds.id }).from(refunds).where(eq(refunds.status, 'pending')).limit(1);
  const [restore] = await tx.select({ id: auditEvents.id }).from(auditEvents)
    .where(eq(auditEvents.action, 'restore.completed'))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1);
  const latest = async (action: string, targetId: string, afterId?: string) => (await tx.select().from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId), afterId
      ? gt(auditEvents.createdAt, tx.select({ at: auditEvents.createdAt }).from(auditEvents).where(eq(auditEvents.id, afterId))) : undefined))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1))[0];
  const request = restore ? await latest('billing.runner.restore_requested', restore.id) : undefined;
  const rerun = restore ? await latest('settings.go_live.reconciliation_requested', restore.id) : undefined;
  const started = restore ? await latest('billing.runner.restore_check_started', restore.id, rerun?.id) : undefined;
  const checked = started ? await latest('billing.runner.restore_checked', started.id) : undefined;
  const report = checked?.after as { inspected: number; unresolved: number } | undefined;
  const snapshotAt = (request?.after as { snapshotAt?: string } | undefined)?.snapshotAt ?? null;
  return { applicable: !!restore || !!pending || !!pendingRefund, restored: !!restore,
    detail: restore ? { restoreId: restore.id, snapshotAt, checkedAt: checked?.occurredAt.toISOString() ?? null,
      inspected: report?.inspected ?? null, unresolved: report?.unresolved ?? null } : null,
    ready: !pending && !pendingRefund && (!restore || report?.unresolved === 0) };
}

export function createGoLiveService(options: {
  scope?: typeof forGym; clock?: Clock; smtpConfigured: (gymId: string) => Promise<boolean>; webhooks?: WebhookHealthQuery;
  restoreCheck?: typeof rerunRestoreReconciliation;
}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const webhooks = options.webhooks ?? createWebhookHealthQuery(scope);
  async function checklist(gymId: string): Promise<Checklist> {
    // These accessors open their own short transactions, so run outside our scope.
    const [smtp, webhook] = await Promise.all([options.smtpConfigured(gymId), webhooks.get(gymId)]);
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
      const recovery = await reconciliation(tx);
      const today = localDate(clock.now(), gym.timezone), thisMonth = today.slice(0, 7);
      const pastDueMemberships = await pastDue(tx, today);
      const setup = (gym.settings as { setup?: { completed?: boolean } }).setup;
      const result = goLiveChecklistResponseSchema.shape.data.parse({ revision: gym.revision, ...switches(gym), pastDueMemberships,
        restoreReconciliation: recovery.detail, items: [
        item('gym_details', ready(!setup || setup.completed)),
        item('members_imported', ready(member)),
        item('schedule_ready', ready(template)),
        item('stripe_ready', ready(gym.stripeConfigured)),
        item('cards_collected', !gym.stripeConfigured || !billable.length ? 'not_applicable'
          : ready(billable.every(home => home.customerId && cards.some(card => card.householdId === home.householdId
            && (!card.expiryYear || !card.expiryMonth || `${card.expiryYear}-${String(card.expiryMonth).padStart(2, '0')}` >= thisMonth))))),
        item('waivers_signed', !people.length || !currentWaivers.some(w => !w.retiredAt) ? 'not_applicable'
          : ready(await signedLinkWaiversComplete(tx, people.map(p => p.id)))),
        item('smtp_ready', ready(smtp)),
        item('backup_ready', ready(gym.backupPublicKey && gym.backupDestination)),
        item('webhook_ready', !gym.stripeConfigured ? 'not_applicable'
          : ready(webhook.lastProcessedAt && !webhook.pendingCount && !webhook.failedCount)),
        item('reconciliation_complete', !gym.stripeConfigured && !recovery.applicable ? 'not_applicable' : ready(recovery.ready)),
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
        const recovery = await reconciliation(tx);
        if (recovery.detail?.restoreId !== input.restoreId) throw new AppError('not_found', t('settings/go-live:notFound'));
        if (gym.billingEnabled || !recovery.detail.snapshotAt) throw new AppError('conflict', t('settings/go-live:reconcilePause'));
        await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
          action: 'settings.go_live.reconciliation_requested', targetType: 'restore', targetId: input.restoreId, occurredAt: clock.now() });
        return recovery.detail.snapshotAt;
      });
      try { await (options.restoreCheck ?? rerunRestoreReconciliation)(context.gymId, new Date(snapshotAt), input.restoreId); }
      catch { throw new AppError('unavailable', t('settings/go-live:reconcileError')); }
      return checklist(context.gymId);
    },
    async update(context: MutationContext, input: UpdateGoLiveRequest): Promise<Checklist> {
      const { revision, confirmedPastDueDates, ...changes } = updateGoLiveRequestSchema.parse(input);
      await scope(context.gymId, async (tx) => {
        const [before] = await tx.select(projection).from(gyms).where(eq(gyms.id, context.gymId)).for('update');
        if (!before) throw new AppError('not_found', t('settings/go-live:notFound'));
        const guard = revisionGuard(gyms.revision, revision);
        // Check revisions first, even if the stale request also needs a date confirmation.
        if (before.revision !== revision) assertRevised([]);
        let confirmed: ReturnType<typeof dates> | undefined;
        if (!before.billingEnabled && changes.billingEnabled) {
          const recovery = await reconciliation(tx);
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
