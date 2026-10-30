// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { jsx } from 'hono/jsx';
import { z } from 'zod';
import { forGym, households, members } from '@plaingym/db';
import { createTranslator, type Clock, type Translator } from '@plaingym/shared';
import { idSchema } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import type { AccountService } from '../../infra/auth/accounts.js';
import { createEmailDeliveries, type Email } from '../../infra/email/index.js';
import type { JobContext, Jobs } from '../../infra/jobs/index.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import type { PublicPagesOptions } from './service.js';
import messages from '../../../../../locales/en/public/pages.json' with { type: 'json' };

export const staffNoticeJob = 'public.pages.staff_notice';
/** The queued payload carries identifiers only; the visitor's details are read when the notice is sent. */
const noticePayload = z.strictObject({ kind: z.enum(['trial', 'drop-in']), memberId: idSchema });
type Notice = z.infer<typeof noticePayload>;
interface Intake { name: string; contact: string; email: string; phone: string | null }

async function compose(t: Translator, gymName: string, kind: Notice['kind'], intake: Intake) {
  const subject = t('public/pages:staffSubject', { gym: gymName, kind: t('public/pages:' + kind) });
  const text = t('public/pages:staffBody', { name: intake.name, contact: intake.contact, email: intake.email, phone: intake.phone ?? '' });
  const html = await jsx('p', { style: 'white-space:pre-wrap' }, text).toString();
  return { subject, text, html };
}

export interface PublicStaffNoticesOptions {
  jobs: Jobs;
  accounts: Pick<AccountService, 'staffEmails'>;
  /** The gym's SMTP transport (or the demo outbox) and name; null when an ordinary install has no SMTP yet. */
  prepare(gymId: string): Promise<{ email: Email; gymName: string } | null>;
  scope?: typeof forGym;
  clock?: Clock;
  settings?: GymSettingsAccessor;
  t?: Translator;
}

/**
 * Trial and drop-in staff notices, queued after the intake commits. Recipients are always the gym's owners and
 * admins, never the visitor, which is what exempts the notice from the member-email switch.
 */
export function createPublicStaffNotices(options: PublicStaffNoticesOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const settings = options.settings ?? createGymSettingsAccessor({ scope });
  const deliveries = createEmailDeliveries({ scope, clock });
  const t = options.t ?? createTranslator({ 'public/pages': messages });
  const noticeKey = ({ kind, memberId }: Notice) => `public.${kind}.staff_notice:${memberId}`;
  /** The hook the public pages call after commit; extra intake fields are ignored so no visitor data is queued. */
  async function publish(gymId: string, intake: Notice) {
    const notice = noticePayload.parse({ kind: intake.kind, memberId: intake.memberId });
    const gym = await settings.get(gymId);
    await options.jobs.enqueue(staffNoticeJob, notice, { gymId, timezone: gym.timezone, idempotencyKey: noticeKey(notice), maxAttempts: 18 });
  }
  async function send(payload: unknown, context: JobContext) {
    const notice = noticePayload.parse(payload), gymId = context.gymId;
    const prepared = await options.prepare(gymId);
    if (!prepared) return;
    const [intake] = await scope(gymId, tx => tx.select({ firstName: members.firstName, lastName: members.lastName,
      contact: households.name, email: households.email, phone: households.phone }).from(members)
      .innerJoin(households, eq(households.id, members.householdId))
      .where(and(eq(members.id, notice.memberId), isNull(members.anonymizedAt))));
    // An erased intake has nothing left to report.
    if (!intake) return;
    const message = await compose(t, prepared.gymName, notice.kind, { name: intake.firstName + ' ' + intake.lastName,
      contact: intake.contact, email: intake.email ?? '', phone: intake.phone });
    // Deduplicated and keyed case-insensitively, but sent to each address as stored.
    const recipients = new Map((await options.accounts.staffEmails(gymId, ['owner', 'admin']))
      .map(email => [email.trim().toLowerCase(), email.trim()] as const));
    let failure: unknown;
    // One send-state key per recipient: a retry resends only to staff the message provably did not reach.
    for (const [address, to] of recipients) {
      const key = noticeKey(notice) + ':' + createHash('sha256').update(address).digest('hex');
      try { await deliveries.send(gymId, key, prepared.email, { to, ...message }); }
      catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }
  return { publish, send };
}
export type PublicStaffNotices = ReturnType<typeof createPublicStaffNotices>;

/**
 * Sends the notice during the request instead of queueing it. Kept for compositions that have not yet passed
 * `createPublicStaffNotices(...).publish` as the public pages' `notifyStaff`; its `prepare` must return staff
 * addresses only. Prefer the queued notices: they are keyed, retried and never delay the visitor.
 */
export function createPublicStaffNotifier(prepare: (gymId: string) => Promise<{ email: Email; recipients: readonly string[]; gymName: string } | null>,
  t: Translator = createTranslator({ 'public/pages': messages })): PublicPagesOptions['notifyStaff'] {
  return async (gymId, intake) => {
    const prepared = await prepare(gymId);
    if (!prepared) return;
    const { email, recipients, gymName } = prepared;
    const message = await compose(t, gymName, intake.kind, { name: intake.member.firstName + ' ' + intake.member.lastName,
      contact: intake.contact.name, email: intake.contact.email, phone: intake.contact.phone ?? null });
    for (const to of new Set(recipients)) await email.sendEmail({ to, ...message });
  };
}
