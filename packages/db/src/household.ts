// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, min, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn, type PgTable } from 'drizzle-orm/pg-core';
import type { Transaction } from './client.js';
import { writeAudit } from './audit.js';
import {
  attendances, classBookings, classSessions, classSessionPrograms, classSessionTags, householdUsers, households, invoiceLineItems, invoices,
  announcementOptOuts, classCreditEntries, memberRanks, members, memberships, paymentMethods, signedLinks, waiverSignatures, waiverTemplates,
} from './schema/index.js';

/** User identity or a verified link ID comes from request context. now is supplied by the request clock. */
export type HouseholdScope =
  | { kind: 'user'; gymId: string; householdId: string; userId: string }
  | { kind: 'signed_link'; gymId: string; linkId: string; now: Date };

type Resources = { kind: 'all' } | { kind: 'one'; id: string } | { kind: 'none' };
interface HouseholdGrant {
  gymId: string;
  householdId: string;
  members: Resources;
  invoices: Resources;
  cards: boolean;
  householdProfile: boolean;
  memberActivity: boolean;
  waiverTemplates: boolean;
  /** Emergency contacts: logged-in household users only, never signed links. */
  contacts: boolean;
  announcementMemberId: string | null;
}
const all = { kind: 'all' } as const;
const none = { kind: 'none' } as const;

const denialMessages = { household_access_denied: 'Household access denied', payer_access_required: 'Payer access required' } as const;
export type HouseholdDenialCode = keyof typeof denialMessages;
/** A refused household read. Callers map `code` to a status; the message is for logs and may change. */
export class HouseholdAccessError extends Error {
  constructor(readonly code: HouseholdDenialCode, message: string = denialMessages[code]) {
    super(message);
    this.name = 'HouseholdAccessError';
  }
}
/** One page of a household list: the rows it shows and the total of the whole list. */
export interface HouseholdPage { readonly limit: number; readonly offset: number }
/** The attendance filters the gym's and a household's reads share. */
export interface AttendanceRowFilter {
  memberId?: string | undefined; programId?: string | undefined; tagId?: string | undefined;
  /** Inclusive lower bound, exclusive upper bound. */
  since?: Date | undefined; until?: Date | undefined;
  kind?: string | undefined;
  /** Leaves out open-mat visits. */
  classesOnly?: boolean | undefined;
}
export type HouseholdAttendanceFilter = AttendanceRowFilter;
/**
 * One gym's attendance rows matching these filters. The gym's lists and totals and a household's reads both use it,
 * so their totals agree; each caller adds its own scope (a household adds its visible members).
 * Only session metadata is read for the program and tag filters, never other attendance rows.
 */
export function attendanceFilterPredicate(tx: Transaction, gymId: string, filter: AttendanceRowFilter) {
  return and(
    eq(attendances.gymId, gymId),
    filter.memberId ? eq(attendances.memberId, filter.memberId) : undefined,
    filter.kind ? eq(attendances.kind, filter.kind) : undefined,
    filter.classesOnly ? eq(attendances.kind, 'class') : undefined,
    filter.since ? gte(attendances.occurredAt, filter.since) : undefined,
    filter.until ? lt(attendances.occurredAt, filter.until) : undefined,
    filter.programId ? or(eq(attendances.programId, filter.programId), inArray(attendances.sessionId,
      tx.select({ id: classSessionPrograms.sessionId }).from(classSessionPrograms).where(and(
        eq(classSessionPrograms.gymId, gymId), eq(classSessionPrograms.programId, filter.programId),
      )))) : undefined,
    filter.tagId ? inArray(attendances.sessionId,
      tx.select({ id: classSessionTags.sessionId }).from(classSessionTags).where(and(
        eq(classSessionTags.gymId, gymId), eq(classSessionTags.tagId, filter.tagId),
      ))) : undefined,
  );
}

function requireAccess(allowed: boolean, code: HouseholdDenialCode = 'household_access_denied'): asserts allowed {
  if (!allowed) throw new HouseholdAccessError(code);
}
async function countRows(tx: Transaction, table: PgTable, where: SQL | undefined) {
  const [total] = await tx.select({ value: count() }).from(table).where(where);
  return total!.value;
}
function resourcePredicate(column: AnyPgColumn, resources: Resources) {
  switch (resources.kind) {
    case 'all': return undefined;
    case 'one': return eq(column, resources.id);
    case 'none': return sql`false`;
  }
}
async function resolveGrant(tx: Transaction, scope: HouseholdScope): Promise<HouseholdGrant> {
  if (scope.kind === 'user') {
    const [link] = await tx.select().from(householdUsers).where(and(
      eq(householdUsers.gymId, scope.gymId), eq(householdUsers.householdId, scope.householdId),
      eq(householdUsers.userId, scope.userId),
    ));
    requireAccess(!!link);
    const payer = link.scope === 'payer';
    requireAccess(payer || (link.scope === 'member' && link.memberId !== null));
    return {
      gymId: scope.gymId, householdId: link.householdId,
      members: payer ? all : { kind: 'one', id: link.memberId! },
      invoices: payer ? all : none, cards: payer, householdProfile: payer,
      memberActivity: true, waiverTemplates: true, contacts: true, announcementMemberId: null,
    };
  }

  const [link] = await tx.select().from(signedLinks).where(and(
    eq(signedLinks.gymId, scope.gymId), eq(signedLinks.id, scope.linkId),
  ));
  requireAccess(!!link && link.revokedAt === null && link.usedAt === null && link.expiresAt > scope.now);
  const grant: HouseholdGrant = {
    gymId: link.gymId, householdId: link.householdId,
    members: none, invoices: none, cards: false, householdProfile: false,
    memberActivity: false, waiverTemplates: false, contacts: false, announcementMemberId: null,
  };
  switch (link.purpose) {
    case 'unsubscribe':
      requireAccess(link.memberId !== null);
      return { ...grant, announcementMemberId: link.memberId };
    case 'pay_invoice':
      requireAccess(link.invoiceId !== null);
      return { ...grant, invoices: { kind: 'one', id: link.invoiceId } };
    case 'update_card':
      return { ...grant, cards: true };
    case 'sign_waiver':
      requireAccess(link.memberId !== null);
      return { ...grant, members: { kind: 'one', id: link.memberId }, waiverTemplates: true };
    case 'onboarding':
      return { ...grant, members: all, cards: true, waiverTemplates: true };
    default:
      throw new HouseholdAccessError('household_access_denied');
  }
}

export async function householdQueries(tx: Transaction, scope: HouseholdScope) {
  const grant = await resolveGrant(tx, scope);
  const memberPredicate = and(
    eq(members.gymId, grant.gymId), eq(members.householdId, grant.householdId),
    resourcePredicate(members.id, grant.members),
  );
  const invoicePredicate = and(
    eq(invoices.gymId, grant.gymId), eq(invoices.householdId, grant.householdId),
    resourcePredicate(invoices.id, grant.invoices),
  );
  const memberIds = tx.select({ id: members.id }).from(members).where(memberPredicate);
  // One projection for list and detail; medical notes and the check-in hash stay staff-only.
  const memberFields = {
    id: members.id, firstName: members.firstName, lastName: members.lastName,
    dateOfBirth: members.dateOfBirth, status: members.status, photoKey: members.photoKey,
    email: members.email, phone: members.phone, checkinCodeVersion: members.checkinCodeVersion,
    revision: members.revision, createdAt: members.createdAt,
    ...(grant.contacts ? { emergencyContacts: members.emergencyContacts } : {}),
  };
  const waiverFields = {
    id: waiverSignatures.id, memberId: waiverSignatures.memberId, templateId: waiverSignatures.templateId,
    snapshot: waiverSignatures.snapshot, snapshotHash: waiverSignatures.snapshotHash,
    signatureImageKey: waiverSignatures.signatureImageKey, signatureImageHash: waiverSignatures.signatureImageHash,
    signedAt: waiverSignatures.signedAt,
  };
  const bookingPredicate = (...rest: (SQL | undefined)[]) => and(eq(classBookings.gymId, grant.gymId), inArray(classBookings.memberId, memberIds), ...rest);
  const attendancePredicate = (filter: AttendanceRowFilter) => and(
    attendanceFilterPredicate(tx, grant.gymId, filter), inArray(attendances.memberId, memberIds),
  );
  const membershipPredicate = (memberId: string) => and(eq(memberships.gymId, grant.gymId),
    inArray(memberships.memberId, memberIds), eq(memberships.memberId, memberId));
  const signaturePredicate = (requested: readonly string[], templateIds?: readonly string[]) => and(eq(waiverSignatures.gymId, grant.gymId),
    inArray(waiverSignatures.memberId, memberIds), inArray(waiverSignatures.memberId, [...requested]),
    templateIds ? inArray(waiverSignatures.templateId, [...templateIds]) : undefined);
  async function announcementMember(lock: boolean, now: () => Date) {
    requireAccess(scope.kind === 'signed_link' && grant.announcementMemberId !== null);
    // Lock the member before the link, as member erasure does (it revokes the member's links last), so the two can't deadlock.
    const memberQuery = tx.select({ id: members.id, firstName: members.firstName, lastName: members.lastName })
      .from(members).where(and(eq(members.gymId, grant.gymId), eq(members.id, grant.announcementMemberId!),
        eq(members.householdId, grant.householdId), isNull(members.anonymizedAt)));
    const [member] = await (lock ? memberQuery.for('update') : memberQuery);
    const linkQuery = tx.select().from(signedLinks).where(and(
      eq(signedLinks.gymId, scope.gymId), eq(signedLinks.id, scope.linkId),
    ));
    const [link] = await (lock ? linkQuery.for('update') : linkQuery);
    requireAccess(!!link && link.purpose === 'unsubscribe' && link.householdId === grant.householdId
      && link.memberId === grant.announcementMemberId);
    // Read the clock after both locks: revocation, moves and expiry cannot authorize a waiting writer.
    const at = now();
    requireAccess(!!member && link.revokedAt === null && link.usedAt === null && link.expiresAt > at);
    return { member, at, linkId: link.id };
  }
  const optOutPredicate = () => and(eq(announcementOptOuts.gymId, grant.gymId),
    eq(announcementOptOuts.memberId, grant.announcementMemberId!));
  // No raw transaction, arbitrary predicate or unscoped relation loader escapes this API.
  // History is read only through bounded pages and lookups, never whole collections.
  return {
    announcementPreference: async () => {
      requireAccess(scope.kind === 'signed_link');
      const { member } = await announcementMember(false, () => scope.now);
      const [row] = await tx.select({ id: announcementOptOuts.id }).from(announcementOptOuts).where(optOutPredicate());
      return { member: { firstName: member.firstName, lastName: member.lastName }, optedOut: !!row };
    },
    setAnnouncementOptOut: async (optedOut: boolean, now: () => Date) => {
      const { member, at, linkId } = await announcementMember(true, now);
      const changed = optedOut
        ? await tx.insert(announcementOptOuts).values({ gymId: grant.gymId, memberId: member.id, createdAt: at })
          .onConflictDoNothing({ target: [announcementOptOuts.gymId, announcementOptOuts.memberId] }).returning({ id: announcementOptOuts.id })
        : await tx.delete(announcementOptOuts).where(optOutPredicate()).returning({ id: announcementOptOuts.id });
      if (changed.length) await writeAudit(tx, { gymId: grant.gymId, actorKind: 'system',
        action: optedOut ? 'announcement.unsubscribed' : 'announcement.resubscribed', targetType: 'member', targetId: member.id,
        before: { optedOut: !optedOut }, after: { optedOut, linkId }, occurredAt: at });
      return { member: { firstName: member.firstName, lastName: member.lastName }, optedOut };
    },
    members: async () => {
      requireAccess(grant.members.kind !== 'none');
      return tx.select(memberFields).from(members).where(memberPredicate);
    },
    member: async (id: string) => {
      requireAccess(grant.members.kind !== 'none');
      return tx.select(memberFields).from(members).where(and(memberPredicate, eq(members.id, id)));
    },
    household: async () => {
      requireAccess(grant.householdProfile, 'payer_access_required');
      return tx.select({
        id: households.id, name: households.name, email: households.email, phone: households.phone,
        address: households.address, billingDay: households.billingDay, revision: households.revision,
      }).from(households).where(and(eq(households.gymId, grant.gymId), eq(households.id, grant.householdId)));
    },
    /** One member's bookings, newest first. */
    bookingPage: async (filter: { memberId: string; sessionId?: string | undefined; status?: string | undefined }, page: HouseholdPage) => {
      requireAccess(grant.memberActivity);
      const where = bookingPredicate(eq(classBookings.memberId, filter.memberId),
        filter.sessionId ? eq(classBookings.sessionId, filter.sessionId) : undefined,
        filter.status ? eq(classBookings.status, filter.status) : undefined);
      const rows = await tx.select().from(classBookings).where(where)
        .orderBy(desc(classBookings.createdAt), desc(classBookings.id)).limit(page.limit).offset(page.offset);
      return { rows, total: await countRows(tx, classBookings, where) };
    },
    /** Whether this member holds this booking; an ID outside the grant finds nothing. */
    booking: async (id: string, memberId: string) => {
      requireAccess(grant.memberActivity);
      return tx.select({ id: classBookings.id }).from(classBookings)
        .where(bookingPredicate(eq(classBookings.id, id), eq(classBookings.memberId, memberId)));
    },
    /** The active places these members hold in these sessions, earliest first. */
    sessionBookings: async (sessionIds: readonly string[], requested: readonly string[]) => {
      requireAccess(grant.memberActivity);
      if (!sessionIds.length || !requested.length) return [];
      return tx.select().from(classBookings).where(bookingPredicate(inArray(classBookings.sessionId, [...sessionIds]),
        inArray(classBookings.memberId, [...requested]), ne(classBookings.status, 'cancelled')))
        .orderBy(asc(classBookings.createdAt), asc(classBookings.id));
    },
    /** Newest first, then ID ascending, like the gym's attendance list. */
    attendancePage: async (filter: HouseholdAttendanceFilter, page: HouseholdPage) => {
      requireAccess(grant.memberActivity);
      const where = attendancePredicate(filter);
      const rows = await tx.select({ id: attendances.id, memberId: attendances.memberId, sessionId: attendances.sessionId,
        programId: attendances.programId, sessionName: classSessions.name, occurredAt: attendances.occurredAt, source: attendances.source, kind: attendances.kind })
        .from(attendances).leftJoin(classSessions, and(eq(classSessions.gymId, grant.gymId), eq(classSessions.id, attendances.sessionId)))
        .where(where).orderBy(desc(attendances.occurredAt), asc(attendances.id)).limit(page.limit).offset(page.offset);
      return { rows, total: await countRows(tx, attendances, where) };
    },
    attendanceCount: async (filter: HouseholdAttendanceFilter) => {
      requireAccess(grant.memberActivity);
      return countRows(tx, attendances, attendancePredicate(filter));
    },
    /**
     * The programs one member has any attendance in, through the attendance's program or its session's programs,
     * as the program filter counts them. At most one row per program of the gym.
     */
    attendedPrograms: async (memberId: string) => {
      requireAccess(grant.memberActivity);
      const own = and(eq(attendances.gymId, grant.gymId), inArray(attendances.memberId, memberIds), eq(attendances.memberId, memberId));
      const direct = await tx.selectDistinct({ programId: attendances.programId }).from(attendances)
        .where(and(own, isNotNull(attendances.programId)));
      const linked = await tx.selectDistinct({ programId: classSessionPrograms.programId }).from(attendances)
        .innerJoin(classSessionPrograms, and(eq(classSessionPrograms.gymId, grant.gymId), eq(classSessionPrograms.sessionId, attendances.sessionId)))
        .where(own);
      return [...new Set([...direct, ...linked].map(row => row.programId!))];
    },
    /** One member's promotions. Promotion notes and the promoting coach are never selected. */
    rankHistory: async (memberId: string) => {
      requireAccess(grant.memberActivity);
      return tx.select({ id: memberRanks.id, memberId: memberRanks.memberId, programId: memberRanks.programId, rankId: memberRanks.rankId,
        rankSystemId: memberRanks.rankSystemId, subRank: memberRanks.subRank, promotedAt: memberRanks.promotedAt, createdAt: memberRanks.createdAt })
        .from(memberRanks).where(and(eq(memberRanks.gymId, grant.gymId), inArray(memberRanks.memberId, memberIds), eq(memberRanks.memberId, memberId)));
    },
    /** Only logged-in users' visible members; no ledger, sale or invoice fields leave this read. */
    classCredits: async (now: Date) => {
      requireAccess(scope.kind === 'user' && grant.memberActivity);
      const movements = alias(classCreditEntries, 'credit_movements');
      const remaining = sql<number>`${classCreditEntries.credits} + coalesce(sum(${movements.credits}), 0)`.mapWith(Number);
      // One statement sees each lot and all of its movements in the same snapshot, even during a draw or expiry.
      const lots = tx.select({
        memberId: members.id, firstName: members.firstName, lastName: members.lastName,
        expiresAt: classCreditEntries.expiresAt, remaining: remaining.as('remaining'),
      }).from(classCreditEntries).innerJoin(members, and(eq(members.id, classCreditEntries.memberId), eq(members.gymId, classCreditEntries.gymId)))
        .leftJoin(movements, and(eq(movements.gymId, grant.gymId), eq(movements.memberId, members.id), eq(movements.lotId, classCreditEntries.id)))
        .where(and(memberPredicate, eq(classCreditEntries.gymId, grant.gymId), isNull(classCreditEntries.lotId),
          or(isNull(classCreditEntries.expiresAt), gt(classCreditEntries.expiresAt, now))))
        .groupBy(members.id, members.firstName, members.lastName, classCreditEntries.id, classCreditEntries.credits, classCreditEntries.expiresAt)
        .having(gt(remaining, 0)).as('usable_credit_lots');
      return tx.select({ memberId: lots.memberId, firstName: lots.firstName, lastName: lots.lastName,
        balance: sql<number>`sum(${lots.remaining})`.mapWith(Number), soonestExpiry: min(lots.expiresAt),
      }).from(lots).groupBy(lots.memberId, lots.firstName, lots.lastName).orderBy(lots.lastName, lots.firstName, lots.memberId);
    },
    /** One member's memberships, latest start first. Amounts and billing state are not selected. */
    membershipPage: async (memberId: string, page: HouseholdPage) => {
      requireAccess(grant.memberActivity);
      const where = membershipPredicate(memberId);
      const rows = await tx.select({ id: memberships.id, memberId: memberships.memberId, planId: memberships.planId, status: memberships.status,
        interval: memberships.interval, startsOn: memberships.startsOn, nextDueOn: memberships.nextDueOn, trialEndsOn: memberships.trialEndsOn,
        commitmentEndsOn: memberships.commitmentEndsOn, revision: memberships.revision })
        .from(memberships).where(where).orderBy(desc(memberships.startsOn), desc(memberships.id)).limit(page.limit).offset(page.offset);
      return { rows, total: await countRows(tx, memberships, where) };
    },
    /** These members' signatures, newest first; given template IDs, only signatures of those templates. */
    signaturePage: async (requested: readonly string[], page: HouseholdPage, templateIds?: readonly string[]) => {
      requireAccess(grant.members.kind !== 'none');
      if (!requested.length || templateIds?.length === 0) return { rows: [], total: 0 };
      const where = signaturePredicate(requested, templateIds);
      const rows = await tx.select(waiverFields).from(waiverSignatures).where(where)
        .orderBy(desc(waiverSignatures.signedAt), desc(waiverSignatures.id)).limit(page.limit).offset(page.offset);
      return { rows, total: await countRows(tx, waiverSignatures, where) };
    },
    /** Whether one of these members signed this signature; an ID outside the grant finds nothing. */
    signature: async (id: string, requested: readonly string[]) => {
      requireAccess(grant.members.kind !== 'none');
      if (!requested.length) return [];
      return tx.select({ id: waiverSignatures.id }).from(waiverSignatures).where(and(signaturePredicate(requested), eq(waiverSignatures.id, id)));
    },
    /** Which of these members signed which of these templates; snapshots are not read. */
    signedTemplates: async (requested: readonly string[], templateIds: readonly string[]) => {
      requireAccess(grant.members.kind !== 'none');
      if (!requested.length || !templateIds.length) return [];
      return tx.selectDistinct({ memberId: waiverSignatures.memberId, templateId: waiverSignatures.templateId }).from(waiverSignatures)
        .where(and(signaturePredicate(requested), inArray(waiverSignatures.templateId, [...templateIds])));
    },
    waiverTemplates: async () => {
      requireAccess(grant.waiverTemplates);
      // Pick each family's latest version first, then drop retired families, so retiring never resurfaces an older version.
      const latest = tx.selectDistinctOn([waiverTemplates.name]).from(waiverTemplates)
        .where(eq(waiverTemplates.gymId, grant.gymId)).orderBy(waiverTemplates.name, desc(waiverTemplates.version)).as('latest');
      return tx.select().from(latest).where(isNull(latest.retiredAt));
    },
    /** Issued invoices, latest due date first; drafts are never listed. */
    invoicePage: async (filter: { status?: string | undefined }, page: HouseholdPage) => {
      requireAccess(grant.invoices.kind !== 'none', 'payer_access_required');
      const where = and(invoicePredicate, ne(invoices.status, 'draft'), filter.status ? eq(invoices.status, filter.status) : undefined);
      const rows = await tx.select({ id: invoices.id, number: invoices.number, kind: invoices.kind, status: invoices.status, dueOn: invoices.dueOn,
        amountCents: invoices.amountCents, currency: invoices.currency, paidAt: invoices.paidAt })
        .from(invoices).where(where).orderBy(desc(invoices.dueOn), desc(invoices.number), desc(invoices.id)).limit(page.limit).offset(page.offset);
      return { rows, total: await countRows(tx, invoices, where) };
    },
    invoice: async (id: string) => {
      requireAccess(grant.invoices.kind !== 'none', 'payer_access_required');
      return tx.select().from(invoices).where(and(invoicePredicate, eq(invoices.id, id)));
    },
    invoiceLines: async (invoiceId: string) => {
      requireAccess(grant.invoices.kind !== 'none', 'payer_access_required');
      return tx.select().from(invoiceLineItems).where(and(
        eq(invoiceLineItems.gymId, grant.gymId), eq(invoiceLineItems.householdId, grant.householdId),
        resourcePredicate(invoiceLineItems.invoiceId, grant.invoices), eq(invoiceLineItems.invoiceId, invoiceId),
      ));
    },
    paymentMethods: async () => {
      requireAccess(grant.cards, 'payer_access_required');
      return tx.select({
        id: paymentMethods.id, brand: paymentMethods.brand, last4: paymentMethods.last4,
        expiryMonth: paymentMethods.expiryMonth, expiryYear: paymentMethods.expiryYear, isDefault: paymentMethods.isDefault,
      }).from(paymentMethods).where(and(eq(paymentMethods.gymId, grant.gymId), eq(paymentMethods.householdId, grant.householdId),
        isNull(paymentMethods.revokedAt)));
    },
  };
}
