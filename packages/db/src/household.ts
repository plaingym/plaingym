// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Transaction } from './client.js';
import {
  attendances, classBookings, householdUsers, households, invoiceLineItems, invoices,
  memberRanks, members, memberships, paymentMethods, signedLinks, waiverSignatures, waiverTemplates,
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
}
const all = { kind: 'all' } as const;
const none = { kind: 'none' } as const;

function requireAccess(allowed: boolean, message = 'Household access denied'): asserts allowed {
  if (!allowed) throw new Error(message);
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
      memberActivity: true, waiverTemplates: true, contacts: true,
    };
  }

  const [link] = await tx.select().from(signedLinks).where(and(
    eq(signedLinks.gymId, scope.gymId), eq(signedLinks.id, scope.linkId),
  ));
  requireAccess(!!link && link.revokedAt === null && link.usedAt === null && link.expiresAt > scope.now);
  const grant: HouseholdGrant = {
    gymId: link.gymId, householdId: link.householdId,
    members: none, invoices: none, cards: false, householdProfile: false,
    memberActivity: false, waiverTemplates: false, contacts: false,
  };
  switch (link.purpose) {
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
      throw new Error('Household access denied');
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
    revision: members.revision,
    ...(grant.contacts ? { emergencyContacts: members.emergencyContacts } : {}),
  };
  // No raw transaction, arbitrary predicate or unscoped relation loader escapes this API.
  return {
    members: async () => {
      requireAccess(grant.members.kind !== 'none');
      return tx.select(memberFields).from(members).where(memberPredicate);
    },
    member: async (id: string) => {
      requireAccess(grant.members.kind !== 'none');
      return tx.select(memberFields).from(members).where(and(memberPredicate, eq(members.id, id)));
    },
    household: async () => {
      requireAccess(grant.householdProfile, 'Payer access required');
      return tx.select({
        id: households.id, name: households.name, email: households.email, phone: households.phone,
        address: households.address, billingDay: households.billingDay, revision: households.revision,
      }).from(households).where(and(eq(households.gymId, grant.gymId), eq(households.id, grant.householdId)));
    },
    bookings: async () => {
      requireAccess(grant.memberActivity);
      return tx.select().from(classBookings).where(and(eq(classBookings.gymId, grant.gymId), inArray(classBookings.memberId, memberIds)));
    },
    attendance: async () => {
      requireAccess(grant.memberActivity);
      return tx.select().from(attendances).where(and(eq(attendances.gymId, grant.gymId), inArray(attendances.memberId, memberIds)));
    },
    ranks: async () => {
      requireAccess(grant.memberActivity);
      return tx.select().from(memberRanks).where(and(eq(memberRanks.gymId, grant.gymId), inArray(memberRanks.memberId, memberIds)));
    },
    memberships: async () => {
      requireAccess(grant.memberActivity);
      return tx.select().from(memberships).where(and(eq(memberships.gymId, grant.gymId), inArray(memberships.memberId, memberIds)));
    },
    waivers: async () => {
      requireAccess(grant.members.kind !== 'none');
      return tx.select({
        id: waiverSignatures.id, memberId: waiverSignatures.memberId, templateId: waiverSignatures.templateId,
        snapshot: waiverSignatures.snapshot, snapshotHash: waiverSignatures.snapshotHash,
        signatureImageKey: waiverSignatures.signatureImageKey, signatureImageHash: waiverSignatures.signatureImageHash,
        signedAt: waiverSignatures.signedAt,
      }).from(waiverSignatures).where(and(eq(waiverSignatures.gymId, grant.gymId), inArray(waiverSignatures.memberId, memberIds)));
    },
    waiverTemplates: async () => {
      requireAccess(grant.waiverTemplates);
      // Pick each family's latest version first, then drop retired families, so retiring never resurfaces an older version.
      const latest = tx.selectDistinctOn([waiverTemplates.name]).from(waiverTemplates)
        .where(eq(waiverTemplates.gymId, grant.gymId)).orderBy(waiverTemplates.name, desc(waiverTemplates.version)).as('latest');
      return tx.select().from(latest).where(isNull(latest.retiredAt));
    },
    invoices: async () => {
      requireAccess(grant.invoices.kind !== 'none', 'Payer access required');
      return tx.select().from(invoices).where(invoicePredicate);
    },
    invoice: async (id: string) => {
      requireAccess(grant.invoices.kind !== 'none', 'Payer access required');
      return tx.select().from(invoices).where(and(invoicePredicate, eq(invoices.id, id)));
    },
    invoiceLines: async (invoiceId: string) => {
      requireAccess(grant.invoices.kind !== 'none', 'Payer access required');
      return tx.select().from(invoiceLineItems).where(and(
        eq(invoiceLineItems.gymId, grant.gymId), eq(invoiceLineItems.householdId, grant.householdId),
        resourcePredicate(invoiceLineItems.invoiceId, grant.invoices), eq(invoiceLineItems.invoiceId, invoiceId),
      ));
    },
    paymentMethods: async () => {
      requireAccess(grant.cards, 'Payer access required');
      return tx.select({
        id: paymentMethods.id, brand: paymentMethods.brand, last4: paymentMethods.last4,
        expiryMonth: paymentMethods.expiryMonth, expiryYear: paymentMethods.expiryYear, isDefault: paymentMethods.isDefault,
      }).from(paymentMethods).where(and(eq(paymentMethods.gymId, grant.gymId), eq(paymentMethods.householdId, grant.householdId),
        isNull(paymentMethods.revokedAt)));
    },
  };
}
