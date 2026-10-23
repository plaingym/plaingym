// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import { forGym, gyms, members, classTemplates, revisionGuard, assertRevised, writeAudit } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { goLiveChecklistResponseSchema, updateGoLiveRequestSchema, type GoLiveChecklistItem, type UpdateGoLiveRequest } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { MutationContext } from '../../core/interfaces/common.js';

const t = createTranslator(locales.en ?? {});
type Checklist = ReturnType<typeof goLiveChecklistResponseSchema.parse>['data'];
type Status = GoLiveChecklistItem['status'];
const item = (id: GoLiveChecklistItem['id'], status: Status): GoLiveChecklistItem =>
  ({ id, status, message: t(`settings/go-live:check.${id}.${status}`) });
/** Only the switches and a readiness snapshot; credentials and opaque settings stay in the service. */
const projection = {
  revision: gyms.revision, billingEnabled: gyms.billingEnabled, memberEmailsEnabled: gyms.memberEmailsEnabled,
  settings: gyms.settings, stripeConfigured: gyms.stripeConfig, backupPublicKey: gyms.backupPublicKey, backupDestination: gyms.backupDestination,
};
const switches = (row: { billingEnabled: boolean; memberEmailsEnabled: boolean }) =>
  ({ billingEnabled: row.billingEnabled, memberEmailsEnabled: row.memberEmailsEnabled });

/**
 * The go-live switches and readiness checklist. This shell stores the switches; the checks that
 * every outbound member email and charge path honor them are separate. Billing readiness items
 * that need payment records report `not_applicable` until those records exist.
 */
export function createGoLiveService(options: { scope?: typeof forGym; clock?: Clock; smtpConfigured: (gymId: string) => Promise<boolean> }) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  async function checklist(gymId: string): Promise<Checklist> {
    // The SMTP resolver opens its own short transaction, so it runs before ours.
    const smtp = await options.smtpConfigured(gymId);
    return scope(gymId, async (tx) => {
      const [gym] = await tx.select(projection).from(gyms).where(eq(gyms.id, gymId));
      if (!gym) throw new AppError('not_found', t('settings/go-live:notFound'));
      const [member] = await tx.select({ id: members.id }).from(members).where(and(eq(members.gymId, gymId), isNull(members.anonymizedAt))).limit(1);
      const [template] = await tx.select({ id: classTemplates.id }).from(classTemplates).where(eq(classTemplates.gymId, gymId)).limit(1);
      const setup = (gym.settings as { setup?: { completed?: boolean } }).setup;
      const ready = (value: unknown): Status => value ? 'ready' : 'needs_attention';
      return goLiveChecklistResponseSchema.shape.data.parse({ revision: gym.revision, ...switches(gym), items: [
        item('gym_details', ready(!setup || setup.completed)),
        item('members_imported', ready(member)),
        item('schedule_ready', ready(template)),
        item('stripe_ready', ready(gym.stripeConfigured)),
        item('cards_collected', 'not_applicable'),
        item('waivers_signed', 'not_applicable'),
        item('smtp_ready', ready(smtp)),
        item('backup_ready', ready(gym.backupPublicKey && gym.backupDestination)),
        item('webhook_ready', 'not_applicable'),
        item('reconciliation_complete', 'not_applicable'),
      ] });
    });
  }
  return {
    checklist,
    async update(context: MutationContext, input: UpdateGoLiveRequest): Promise<Checklist> {
      const { revision, ...changes } = updateGoLiveRequestSchema.parse(input);
      await scope(context.gymId, async (tx) => {
        const [before] = await tx.select(projection).from(gyms).where(eq(gyms.id, context.gymId)).for('update');
        if (!before) throw new AppError('not_found', t('settings/go-live:notFound'));
        const guard = revisionGuard(gyms.revision, revision);
        const after = assertRevised(await tx.update(gyms).set({ ...changes, revision: guard.next, updatedAt: clock.now() })
          .where(and(eq(gyms.id, context.gymId), guard.matches)).returning(projection));
        await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
          ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
          action: 'settings.go_live.updated', targetType: 'gym', targetId: context.gymId,
          before: switches(before), after: switches(after), occurredAt: clock.now() });
      });
      return checklist(context.gymId);
    },
  };
}
export type GoLiveService = ReturnType<typeof createGoLiveService>;

let configured: GoLiveService | undefined;
/** The runtime passes its per-gym SMTP check (demo installs count as configured). */
export function configureGoLive(options: Parameters<typeof createGoLiveService>[0]) { configured = createGoLiveService(options); }
export function goLiveService(): GoLiveService {
  if (!configured) throw new AppError('unavailable', t('settings/go-live:unavailable'));
  return configured;
}
