// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, isNull, isNotNull, or } from 'drizzle-orm';
import { normalizePhone } from '@plaingym/shared/phone';
import { announcementOptOuts, households, memberRanks, members, programs, type Transaction } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import type { AnnouncementAudience } from '@plaingym/shared/contracts';
import { addressEquals } from './audience.sql.js';
import { cancellationBillingAddressEquals } from './cancellation.sql.js';

/** Read only this address's fallback candidates rather than reloading the whole cancellation roster for each address. */
export async function readCancellationFallbacks(tx: Transaction, memberIds: readonly string[], address: string) {
  if (!memberIds.length) return [];
  return tx.select({ id: members.id }).from(members).innerJoin(households, eq(households.id, members.householdId))
    .where(and(inArray(members.id, [...memberIds]), or(isNull(members.emailAddress), eq(members.emailAddress, '')),
      cancellationBillingAddressEquals(address))).orderBy(asc(members.id));
}

export type SkipReason = 'anonymized' | 'missing_email' | 'opt_out' | 'undeliverable' | 'ineligible';
/** Shared indexed address-group read; cancellation notices ignore announcement-only preferences. */
export function readAddressGroup(tx: Transaction, address?: string, memberId?: string) {
  return tx.select({ id: members.id, email: members.emailAddress, firstName: members.firstName, lastName: members.lastName,
    status: members.status, anonymizedAt: members.anonymizedAt, emailOptOut: members.emailOptOut,
    emailDeliverable: members.emailDeliverable, announcementOptOut: announcementOptOuts.id }).from(members)
    .leftJoin(announcementOptOuts, eq(announcementOptOuts.memberId, members.id))
    .where(memberId ? or(eq(members.id, memberId), address ? addressEquals(address) : undefined)
      : address === undefined ? undefined : addressEquals(address)).orderBy(asc(members.id));
}
/** Inspect every member at an address, including members outside the requested audience. */
export async function readAudience(tx: Transaction, audience: AnnouncementAudience, currentMemberId?: string) {
  // Confirmation validates program ownership. During delivery a deleted program simply makes its former members ineligible.
  if (!currentMemberId && audience.programIds.length) {
    const existing = await tx.select({ id: programs.id }).from(programs).where(inArray(programs.id, audience.programIds));
    if (existing.length !== new Set(audience.programIds).size) throw new AppError('not_found', 'Program not found');
  }
  // Addresses come from the stored column, so grouping and lookups share PostgreSQL's one normalization.
  const [current] = currentMemberId ? await tx.select({ email: members.emailAddress }).from(members).where(eq(members.id, currentMemberId)).for('update') : [];
  const address = current?.email || undefined;
  const rows = await readAddressGroup(tx, address, currentMemberId);
  const ranked = audience.programIds.length ? new Set(rows.length ? (await tx.select({ id: memberRanks.memberId }).from(memberRanks)
    .where(and(inArray(memberRanks.programId, audience.programIds), inArray(memberRanks.memberId, rows.map(row => row.id)))))
    .map(row => row.id) : []) : undefined;
  const blocked = new Map<string, 'opt_out' | 'undeliverable'>();
  for (const row of rows) if (row.email) {
    const address = row.email;
    if (row.emailOptOut || row.announcementOptOut) blocked.set(address, 'opt_out');
    else if (!row.emailDeliverable && !blocked.has(address)) blocked.set(address, 'undeliverable');
  }
  const candidates = rows.map(row => {
    const address = row.email ?? '';
    const reason: SkipReason | undefined = row.anonymizedAt ? 'anonymized' : !address ? 'missing_email'
      : blocked.get(address) ?? (!(audience.statuses as string[]).includes(row.status) || (ranked && !ranked.has(row.id)) ? 'ineligible' : undefined);
    return { memberId: row.id, address, reason };
  });
  const seen = new Set<string>();
  const recipients = candidates.filter(row => {
    if (row.reason || seen.has(row.address)) return false;
    seen.add(row.address);
    return true;
  });
  return { candidates, recipients };
}

/** Texts use announcements consent only; email preferences and household notice consent do not apply. */
export async function readSmsAudience(tx: Transaction, audience: AnnouncementAudience, country: string | null | undefined, memberIds?: string[]) {
  if (audience.programIds.length) {
    const existing = await tx.select({ id: programs.id }).from(programs).where(inArray(programs.id, audience.programIds));
    if (!memberIds && existing.length !== new Set(audience.programIds).size) throw new AppError('not_found', 'Program not found');
  }
  const rows = await tx.select({ id: members.id, phone: members.phone, phoneE164: members.phoneE164 }).from(members)
    .where(and(isNull(members.anonymizedAt), isNotNull(members.smsAnnouncementsConsentAt),
      inArray(members.status, audience.statuses), memberIds ? inArray(members.id, memberIds) : undefined))
    .orderBy(asc(members.id));
  const ranked = audience.programIds.length && rows.length ? new Set((await tx.select({ id: memberRanks.memberId }).from(memberRanks)
    .where(and(inArray(memberRanks.programId, audience.programIds), inArray(memberRanks.memberId, rows.map(row => row.id)))))
    .map(row => row.id)) : undefined;
  const groups = new Map<string, { phone: string; memberIds: string[] }>();
  for (const row of rows) {
    if (ranked && !ranked.has(row.id)) continue;
    const phone = normalizePhone(row.phone, country);
    if (!phone || phone !== row.phoneE164) continue;
    const group = groups.get(phone) ?? { phone, memberIds: [] };
    group.memberIds.push(row.id); groups.set(phone, group);
  }
  return [...groups.values()];
}
