// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { forGym, gyms, members, households, classTemplates, memberships, plans, paymentMethods, paymentAttempts,
  refunds, waiverTemplates, revisionGuard, assertRevised, writeAudit, type Transaction } from '@plaingym/db';
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
import { restoreCheckLease, RestoreCheckBusyError, type RestoreCheckLease } from '../health/restore.billing-lease.js';
import { readRestoreCheck, readSavedStripeMode, restoreCheckCoversStripe } from './go-live.restore.js';

const t = createTranslator(locales.en ?? {});
type WireChecklist = ReturnType<typeof goLiveChecklistResponseSchema.parse>['data'];
type Checklist = WireChecklist & { pastDueMemberships: NonNullable<WireChecklist['pastDueMemberships']> };
type Status = GoLiveChecklistItem['status'];
const item = (id: GoLiveChecklistItem['id'], status: Status, message?: string): GoLiveChecklistItem =>
  ({ id, status, message: message ?? t(`settings/go-live:check.${id}.${status}`) });
const ready = (value: unknown): Status => value ? 'ready' : 'needs_attention';
/** Credentials and opaque settings are read here, never returned or audited. */
const projection = {
  revision: gyms.revision, timezone: gyms.timezone, billingEnabled: gyms.billingEnabled, memberEmailsEnabled: gyms.memberEmailsEnabled, memberSmsEnabled: gyms.memberSmsEnabled,
  settings: gyms.settings, stripeConfigured: gyms.stripeConfig, backupPublicKey: gyms.backupPublicKey, backupDestination: gyms.backupDestination,
};
const switches = (row: { billingEnabled: boolean; memberEmailsEnabled: boolean; memberSmsEnabled: boolean }) =>
  ({ billingEnabled: row.billingEnabled, memberEmailsEnabled: row.memberEmailsEnabled, memberSmsEnabled: row.memberSmsEnabled });
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
 * A restore check clears billing only for the Stripe mode it read. Both credential save paths record the mode
 * atomically in their audit, so this gate checks it under the same gym lock as enabling billing.
 */
async function reconciliation(tx: Transaction, stripe: boolean) {
  const [pending] = await tx.select({ id: paymentAttempts.id }).from(paymentAttempts).where(eq(paymentAttempts.status, 'pending')).limit(1);
  const [pendingRefund] = await tx.select({ id: refunds.id }).from(refunds).where(eq(refunds.status, 'pending')).limit(1);
  const { restore, request, checked, report } = await readRestoreCheck(tx);
  const snapshotAt = (request?.after as { snapshotAt?: string } | undefined)?.snapshotAt ?? null;
  const savedMode = await readSavedStripeMode(tx);
  const clear = report?.unresolved === 0 && restoreCheckCoversStripe(report, stripe, savedMode);
  return { applicable: !!restore || !!pending || !!pendingRefund, restored: !!restore,
    modeMessage: stripe && savedMode && report?.stripeMode && savedMode !== report.stripeMode ? t('settings/go-live:reconcileModeChanged', {
      checkedMode: t('settings/integrations:payments.mode_' + report.stripeMode), savedMode: t('settings/integrations:payments.mode_' + savedMode),
    }) : undefined,
    detail: restore ? { restoreId: restore.id, snapshotAt, checkedAt: checked?.occurredAt.toISOString() ?? null,
      inspected: report?.inspected ?? null, unresolved: report?.unresolved ?? null, stripeConfigured: report?.stripeConfigured ?? null,
      stripeMode: report?.stripeMode ?? null } : null,
    ready: !pending && !pendingRefund && (!restore || clear),
    // Nothing was left to reconcile: no pending work, and any restore's check found no payment objects at all.
    empty: !pending && !pendingRefund && (!restore || (clear && report.inspected === 0)) };
}

export function createGoLiveService(options: {
  scope?: typeof forGym; clock?: Clock; smtpConfigured: (gymId: string) => Promise<boolean>; webhooks?: WebhookHealthQuery;
  /** The runtime's payments resolver; defaults to the gym's stored Stripe settings (demo sandboxes share an install account). */
  paymentsConfigured?: (gymId: string) => Promise<boolean>;
  /** The SMS resolver's configured check; demo composition supplies its outbox resolver. Absent means unavailable. */
  smsConfigured?: (gymId: string) => Promise<boolean>;
  restoreCheck?: typeof rerunRestoreReconciliation;
  restoreCheckLease?: RestoreCheckLease;
}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const webhooks = options.webhooks ?? createWebhookHealthQuery(scope);
  const smsConfigured = async (gymId: string) => {
    try { return Boolean(await options.smsConfigured?.(gymId)); }
    catch { return false; }
  };
  async function checklist(gymId: string): Promise<Checklist> {
    // These accessors open their own short transactions, so run outside our scope.
    const [smtp, webhook, payments, sms] = await Promise.all([options.smtpConfigured(gymId), webhooks.get(gymId),
      options.paymentsConfigured?.(gymId), smsConfigured(gymId)]);
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
        item('sms_ready', !sms && !gym.memberSmsEnabled ? 'not_applicable' : ready(sms)),
        item('backup_ready', ready(gym.backupPublicKey && gym.backupDestination)),
        item('webhook_ready', !stripe ? 'not_applicable'
          : ready(webhook.lastProcessedAt && !webhook.pendingCount && !webhook.failedCount)),
        item('reconciliation_complete', !stripe && recovery.empty ? 'not_applicable' : ready(recovery.ready), recovery.modeMessage
          ? t('settings/go-live:check.reconciliation_complete.needs_attention') + ' ' + recovery.modeMessage : undefined),
        item('past_due_dates', ready(!pastDueMemberships.length)),
      ] });
      return { ...result, pastDueMemberships };
    });
  }
  return {
    checklist,
    async rerunReconciliation(context: MutationContext, input: { revision: number; restoreId: string }): Promise<Checklist> {
      try {
        return await (options.restoreCheckLease ?? restoreCheckLease)(context.gymId, input.restoreId, async () => {
          const snapshotAt = await scope(context.gymId, async tx => {
            const [gym] = await tx.select(projection).from(gyms).where(eq(gyms.id, context.gymId)).for('update');
            if (!gym) throw new AppError('not_found', t('settings/go-live:notFound'));
            if (gym.revision !== input.revision) assertRevised([]);
            // Only the restore and its snapshot are read here; the check itself resolves the provider.
            const recovery = await reconciliation(tx, Boolean(gym.stripeConfigured));
            if (recovery.detail?.restoreId !== input.restoreId) throw new AppError('not_found', t('settings/go-live:notFound'));
            if (gym.billingEnabled || !recovery.detail.snapshotAt) throw new AppError('conflict', t('settings/go-live:reconcilePause'));
            await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
              ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
              action: 'settings.go_live.reconciliation_requested', targetType: 'restore', targetId: input.restoreId, occurredAt: clock.now() });
            return recovery.detail.snapshotAt;
          });
          try { await (options.restoreCheck ?? rerunRestoreReconciliation)(context.gymId, new Date(snapshotAt), input.restoreId); }
          catch {
            await scope(context.gymId, (tx) => writeAudit(tx, { gymId: context.gymId, actorKind: 'system',
              action: 'settings.go_live.reconciliation_failed', targetType: 'restore', targetId: input.restoreId, occurredAt: clock.now() }))
              .catch(() => undefined);
            throw new AppError('unavailable', t('settings/go-live:reconcileError'));
          }
          return checklist(context.gymId);
        });
      } catch (error) {
        if (error instanceof RestoreCheckBusyError)
          throw new AppError('conflict', t('settings/go-live:reconcileBusy'), { restoreId: ['check_running'] });
        throw error;
      }
    },
    async update(context: MutationContext, input: UpdateGoLiveRequest): Promise<Checklist> {
      const { revision, confirmedPastDueDates, ...changes } = updateGoLiveRequestSchema.parse(input);
      // Opens its own transaction, so resolve it first; only turning billing on reads it.
      const payments = changes.billingEnabled ? await options.paymentsConfigured?.(context.gymId) : undefined;
      const sms = changes.memberSmsEnabled ? await smsConfigured(context.gymId) : undefined;
      await scope(context.gymId, async (tx) => {
        const [before] = await tx.select(projection).from(gyms).where(eq(gyms.id, context.gymId)).for('update');
        if (!before) throw new AppError('not_found', t('settings/go-live:notFound'));
        const guard = revisionGuard(gyms.revision, revision);
        // Check revisions first, even if the stale request also needs a date confirmation.
        if (before.revision !== revision) assertRevised([]);
        if (changes.memberSmsEnabled && !sms)
          throw new AppError('conflict', t('settings/go-live:smsProviderRequired'), { memberSmsEnabled: ['no_provider'] });
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
