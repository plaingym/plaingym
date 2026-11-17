// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { databaseCode, members, writeAudit, type forGym, type Transaction } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { normalizePhone } from '@plaingym/shared/phone';
import type { MutationContext } from '../../core/interfaces/common.js';
import { logError } from '../../core/log.js';

export type SmsSource = 'staff' | 'portal' | 'join';
export type SmsColumns = { phoneE164: string | null; smsNoticesConsentAt: Date | null; smsNoticesConsentSource: string | null;
  smsAnnouncementsConsentAt?: Date | null; smsAnnouncementsConsentSource?: string | null };
export const clearedMemberSms = { smsNoticesConsentAt: null, smsNoticesConsentSource: null,
  smsAnnouncementsConsentAt: null, smsAnnouncementsConsentSource: null };
export const clearedHouseholdSms = { smsNoticesConsentAt: null, smsNoticesConsentSource: null };

/** Only national numbers need the gym's default region, including legacy records without phone_e164. */
export const phoneNeedsCountry = (phone: string | null | undefined) => Boolean(phone?.trim() && !phone.trim().startsWith('+'));

/** Consent belongs to the stored normalized number. A raw edit always refreshes it; invalid numbers clear consent. */
export function smsPhoneChange(before: { phone: string | null; phoneE164: string | null }, phone: string | null | undefined, country?: string | null) {
  const changedPhone = phone !== undefined && phone !== before.phone;
  const phoneE164 = normalizePhone(phone, country);
  return { changedPhone, phoneE164, changedNumber: changedPhone && (phoneE164 === null || phoneE164 !== before.phoneE164) };
}

export function withoutSmsColumns(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'phoneE164' && !key.startsWith('sms')));
}

/** Reads validate even old, not-yet-normalized phone records with the gym's country. */
export function smsState(row: SmsColumns, phone: string | null, country?: string | null) {
  const phoneE164 = normalizePhone(phone, country);
  const consent = (at: Date | null | undefined, source: string | null | undefined) =>
    at && source && phoneE164 === row.phoneE164 ? { at: at.toISOString(), source } : null;
  return { phoneValid: phoneE164 !== null, phoneE164, notices: consent(row.smsNoticesConsentAt, row.smsNoticesConsentSource),
    ...('smsAnnouncementsConsentAt' in row ? { announcements: consent(row.smsAnnouncementsConsentAt, row.smsAnnouncementsConsentSource) } : {}) };
}

/** A consent audit holds the choice, time and source, never either form of the phone. */
export async function auditSmsConsent(tx: Transaction, context: MutationContext, targetType: 'member' | 'household', targetId: string,
  kind: 'notices' | 'announcements', before: { at: Date | null; source: string | null }, after: { at: Date | null; source: string | null },
  source: SmsSource, now: Date) {
  await writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
    ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
    action: targetType + '.sms_consent_changed', targetType, targetId, occurredAt: now,
    before: { kind, at: before.at?.toISOString() ?? null, source: before.source },
    after: { kind, at: after.at?.toISOString() ?? null, source: after.source, changeSource: source } });
}
export async function auditSmsCleared(tx: Transaction, context: MutationContext, type: 'member' | 'household', id: string,
  row: SmsColumns, source: SmsSource, now: Date) {
  if (row.smsNoticesConsentAt) await auditSmsConsent(tx, context, type, id, 'notices', { at: row.smsNoticesConsentAt, source: row.smsNoticesConsentSource }, { at: null, source: null }, source, now);
  if (row.smsAnnouncementsConsentAt) await auditSmsConsent(tx, context, type, id, 'announcements',
    { at: row.smsAnnouncementsConsentAt ?? null, source: row.smsAnnouncementsConsentSource ?? null }, { at: null, source: null }, source, now);
}

/** A member visible before waiting for a lock may have been deleted by the time the lock is granted. */
export async function lockMemberForWrite(tx: Transaction, id: string, strength: 'share' | 'update') {
  if (!(await tx.select({ id: members.id }).from(members).where(eq(members.id, id)))[0])
    throw new AppError('not_found', 'Member not found');
  const [member] = await tx.select().from(members).where(eq(members.id, id)).for(strength);
  if (!member) throw new AppError('conflict', 'The member changed while waiting to save');
  return member;
}

/** Reference races are retryable conflicts in member-writing services; constraint identifiers remain in the log. */
export function memberWriteScope(scope: typeof forGym): typeof forGym {
  return (gymId, run) => scope(gymId, run).catch((error: unknown) => {
    const code = databaseCode(error);
    if (code === '23503' || code === '40P01') {
      logError(code === '23503' ? 'members.write.foreign_key' : 'members.write.deadlock', { gymId }, error);
      throw new AppError('conflict', 'The referenced record changed while saving');
    }
    throw error;
  });
}
