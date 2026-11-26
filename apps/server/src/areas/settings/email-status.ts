// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, gt, inArray, or } from 'drizzle-orm';
import { auditEvents, forGym, gyms, writeAudit, type Transaction } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { smtpTestFailureSchema, type SmtpTestFailure } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import { logWarn } from '../../core/log.js';
import { emailServiceFailure } from '../../infra/email/failure.js';
import type { SmtpConfig } from '../../infra/email/index.js';

/** The gym's email state, recorded only when it changes: a send failed through the service's fault, or one worked again. */
export const emailStatusActions = ['email.delivery_failed', 'email.delivery_recovered'] as const;
/** Changes to the gym's email settings that make an earlier failure stale. Setup step 5 is the email step. */
const settingsActions = ['integrations.email_saved', 'integrations.email_removed'] as const;
const setupStepAction = 'setup.step_completed', emailSetupStep = 5;

const savedAtEmailStep = (after: unknown) => {
  const step = after as { step?: unknown; test?: unknown } | null;
  return step?.step === emailSetupStep && step.test !== 'not_sent';
};
/** Whose settings a send used: the gym's own, saved in Settings, or the install's `SMTP_*` environment. */
type SmtpSettings = { port: number; security: 'starttls' | 'tls' | 'plain'; source: 'gym' | 'install' };
/**
 * When this process started. The install's `SMTP_*` settings change only with a restart, which writes no audit row,
 * so a failure through them recorded without a settings fingerprint before this process started no longer stands.
 */
export const processStartedAt = new Date();
type Report = NonNullable<SmtpConfig['report']>;
type Row = { id: string; action: string; after: unknown; occurredAt: Date };
export type SettingsMark = { occurredAt: Date; id: string } | null;
/** A standing send failure and whose settings it went through. */
export type EmailSendFailure = { failure: SmtpTestFailure; at: string; source: 'gym' | 'install' };
/**
 * `installSince`: when the install's settings were last read (default: this process's start), for a failure without a
 * fingerprint. `installSettings`: the install's settings fingerprint now (`installSmtpFingerprint`), null without any.
 */
export type InstallSettingsOptions = { installSince?: Date; installSettings?: string | null };

/** The newest email-settings audit row for the gym, or null when none exists. */
export async function readSettingsMark(tx: Transaction, gymId: string): Promise<SettingsMark> {
  const [row] = await tx.select({ occurredAt: auditEvents.occurredAt, id: auditEvents.id })
    .from(auditEvents).where(and(eq(auditEvents.gymId, gymId), inArray(auditEvents.action, [...settingsActions, setupStepAction])))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
  return row ?? null;
}

async function settingsChangedAfter(tx: Transaction, gymId: string, mark: SettingsMark): Promise<boolean> {
  const newer = mark
    ? or(gt(auditEvents.occurredAt, mark.occurredAt), and(eq(auditEvents.occurredAt, mark.occurredAt), gt(auditEvents.id, mark.id)))
    : undefined;
  const later = await tx.select({ action: auditEvents.action, after: auditEvents.after }).from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), inArray(auditEvents.action, [...settingsActions, setupStepAction]), newer));
  // Skipping setup's email step (`test: 'not_sent'`) saves no settings, so it leaves the failure standing.
  return later.some((row) => row.action !== setupStepAction || savedAtEmailStep(row.after));
}

async function newestStatus(tx: Transaction, gymId: string): Promise<Row | undefined> {
  const [row] = await tx.select({ id: auditEvents.id, action: auditEvents.action, after: auditEvents.after, occurredAt: auditEvents.occurredAt })
    .from(auditEvents).where(and(eq(auditEvents.gymId, gymId), inArray(auditEvents.action, [...emailStatusActions])))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
  return row;
}

/**
 * The gym's last send failure, while it stands: the newest `email.delivery_failed` row, unless a send worked since
 * (`email.delivery_recovered`) or the email settings changed since (saved or removed in Settings, or saved at setup's email step).
 * A failure through the install's settings (`source: 'install'`) that carries their fingerprint (`settings`) stands while
 * it equals `installSettings`, when that is given, and lapses once they differ, whenever this process started. One
 * without a fingerprint, or read without `installSettings`, lapses when it is older than `installSince` (default: this
 * process's start). A row without a source is read as one through the gym's.
 */
export async function readEmailSendFailure(tx: Transaction, gymId: string, options: InstallSettingsOptions = {}): Promise<EmailSendFailure | null> {
  const newest = await newestStatus(tx, gymId);
  if (newest?.action !== 'email.delivery_failed') return null;
  const after = newest.after as { failure?: unknown; source?: unknown; settings?: unknown } | null;
  const failure = smtpTestFailureSchema.safeParse(after?.failure);
  if (!failure.success) return null;
  const source = after?.source === 'install' ? 'install' : 'gym';
  if (source === 'install') {
    const fingerprinted = typeof after?.settings === 'string' && options.installSettings !== undefined;
    if (fingerprinted ? after.settings !== options.installSettings : newest.occurredAt < (options.installSince ?? processStartedAt)) return null;
  }
  if (await settingsChangedAfter(tx, gymId, { occurredAt: newest.occurredAt, id: newest.id })) return null;
  return { failure: failure.data, at: newest.occurredAt.toISOString(), source };
}

/**
 * Builds the `SmtpConfig.report` for one gym's sends. A failure is recorded only when it is the sending service's
 * (`emailServiceFailure`), and only when it isn't already the failure shown; a working send is recorded only after a
 * recorded failure. Each record is one short transaction of its own, after the send. The row holds the failure class
 * and whose settings it went through, never a recipient, reply or credential; one through the install's settings also
 * holds their fingerprint (`installSettings`, an HMAC), so it stands across restarts until they change. A failed record
 * is logged and never reaches the send.
 */
export function createEmailStatusRecorder(options: { scope?: typeof forGym; clock?: Clock } & InstallSettingsOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock, installSince = options.installSince ?? processStartedAt;
  const installSettings = options.installSettings;
  const readOptions: InstallSettingsOptions = { installSince, ...(installSettings !== undefined ? { installSettings } : {}) };
  return (gymId: string, settings: SmtpSettings, mark?: SettingsMark): Report => async (outcome) => {
    const failure = outcome.ok ? null : emailServiceFailure(outcome.error, settings);
    if (!outcome.ok && failure === null) return;
    try {
      await scope(gymId, async (tx) => {
        // A settings save locks the gym row while it writes its audit row. Sharing that lock first means a save in
        // progress commits before the check, so it can't land between the check and the write.
        const stale = async () => {
          if (mark === undefined) return false;
          await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, gymId)).for('share');
          return settingsChangedAfter(tx, gymId, mark);
        };
        if (failure !== null) {
          // The failure shown already says this, through the same settings: nothing new to record.
          const shown = await readEmailSendFailure(tx, gymId, readOptions);
          if ((shown?.failure === failure && shown.source === settings.source) || await stale()) return;
          const fingerprint = settings.source === 'install' && typeof installSettings === 'string' ? { settings: installSettings } : {};
          await writeAudit(tx, { gymId, actorKind: 'system', action: 'email.delivery_failed', targetType: 'gym', targetId: gymId,
            after: { failure, source: settings.source, ...fingerprint }, occurredAt: clock.now() });
        } else if ((await newestStatus(tx, gymId))?.action === 'email.delivery_failed' && !await stale()) {
          await writeAudit(tx, { gymId, actorKind: 'system', action: 'email.delivery_recovered', targetType: 'gym', targetId: gymId,
            after: null, occurredAt: clock.now() });
        }
      });
    } catch (error) {
      logWarn('email.status_record_failed', { error: error instanceof Error ? error.name : typeof error });
    }
  };
}
