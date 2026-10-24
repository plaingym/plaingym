// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, ilike, inArray, isNull, ne, or } from 'drizzle-orm';
import { forGym, members, memberRanks, memberships, households, householdUsers, memberTags, memberTagLinks, signedLinks, waiverSignatures,
  invoices, revisionGuard, assertRevised, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import type { MutationContext } from '../../core/interfaces/common.js';
import { clock as defaultClock } from '../../core/clock.js';
import { hashHouseholdPin, type HouseholdPinSecret } from './pin.js';

// Deliberate projections keep medical notes and credentials out of every normal roster.
const memberFields = { id: members.id, householdId: members.householdId, firstName: members.firstName,
  lastName: members.lastName, email: members.email, phone: members.phone, photoKey: members.photoKey,
  dateOfBirth: members.dateOfBirth, status: members.status, emergencyContacts: members.emergencyContacts,
  emailOptOut: members.emailOptOut, emailDeliverable: members.emailDeliverable,
  anonymizedAt: members.anonymizedAt, revision: members.revision, createdAt: members.createdAt };
const householdFields = { id: households.id, name: households.name, email: households.email,
  phone: households.phone, address: households.address, revision: households.revision, createdAt: households.createdAt };
const billingFields = { id: households.id, billingDay: households.billingDay,
  familyDiscountBasisPoints: households.familyDiscountBasisPoints, revision: households.revision };
const tagFields = { id: memberTags.id, name: memberTags.name, color: memberTags.color, revision: memberTags.revision, createdAt: memberTags.createdAt };
const linkFields = { id: memberTagLinks.id, memberId: memberTagLinks.memberId, tagId: memberTagLinks.tagId, createdAt: memberTagLinks.createdAt };
const member = (row: Record<string, unknown>) => c.memberSchema.parse({
  ...row, createdAt: (row.createdAt as Date).toISOString(), anonymizedAt: (row.anonymizedAt as Date | null)?.toISOString() ?? null,
});
const household = (row: Record<string, unknown>) => c.householdSchema.parse({ ...row, createdAt: (row.createdAt as Date).toISOString() });
const tag = (row: Record<string, unknown>) => c.memberTagSchema.parse({ ...row, createdAt: (row.createdAt as Date).toISOString() });
const link = (row: Record<string, unknown>) => c.memberTagLinkSchema.parse({ ...row, createdAt: (row.createdAt as Date).toISOString() });
function missing<T>(row: T | undefined): T { if (!row) throw new AppError('not_found', 'Resource not found'); return row; }
function editable(row: { anonymizedAt: Date | null }) {
  if (row.anonymizedAt) throw new AppError('conflict', 'Anonymized profiles cannot be edited');
}
function databaseCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return databaseCode(error.cause);
}
const search = (value: string) => '%' + value.replace(/[\\%_]/g, '\\$&') + '%';
/** `pinSecret` resolves the gym's random key (`areas/settings/gym-keys.ts`); without it, setting a PIN fails closed. */
export interface MembersOptions { scope?: typeof forGym; clock?: Clock; pinSecret?: HouseholdPinSecret }
export function createMembersService(options: MembersOptions = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const audit = (tx: Transaction, context: MutationContext, action: string, targetType: string, targetId: string) =>
    writeAudit(tx, { gymId: context.gymId, actorKind: context.actor.kind,
      ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
      action, targetType, targetId, occurredAt: clock.now() }); // No PII or PINs in the append-only log.
  const getMemberRow = async (tx: Transaction, id: string) => missing((await tx.select(memberFields).from(members).where(eq(members.id, id)))[0]);
  const getHouseholdRow = async (tx: Transaction, id: string) => missing((await tx.select(householdFields).from(households).where(eq(households.id, id)).for('update'))[0]);
  const service = {
    async listMembers(gymId: string, input: c.MemberListQuery) {
      const query = c.memberListQuerySchema.parse(input);
      return scope(gymId, async (tx) => {
        const tagged = query.tagId ? tx.select({ id: memberTagLinks.memberId }).from(memberTagLinks).where(eq(memberTagLinks.tagId, query.tagId)) : undefined;
        const where = and(query.householdId ? eq(members.householdId, query.householdId) : undefined,
          query.status ? eq(members.status, query.status) : undefined, tagged ? inArray(members.id, tagged) : undefined,
          query.search ? or(ilike(members.firstName, search(query.search)), ilike(members.lastName, search(query.search)), ilike(members.email, search(query.search))) : undefined);
        if (query.householdId) await getHouseholdRow(tx, query.householdId);
        if (query.tagId) missing((await tx.select({ id: memberTags.id }).from(memberTags).where(eq(memberTags.id, query.tagId)))[0]);
        const total = await tx.$count(members, where);
        const rows = await tx.select(memberFields).from(members).where(where).orderBy(asc(members.lastName), asc(members.firstName), asc(members.id)).limit(query.limit).offset(query.offset);
        return { data: rows.map(member), pagination: { limit: query.limit, offset: query.offset, total } };
      });
    },
    async getMember(gymId: string, id: string) { return scope(gymId, async (tx) => member(await getMemberRow(tx, id))); },
    async createMember(context: MutationContext, input: c.CreateMemberRequest) {
      const data = c.createMemberRequestSchema.parse(input);
      if (data.photoKey) throw new AppError('invalid_request', 'Use the photo upload endpoint');
      return scope(context.gymId, async (tx) => {
        await getHouseholdRow(tx, data.householdId);
        const row = missing((await tx.insert(members).values({ ...data, id: uuidv7(), gymId: context.gymId, createdAt: clock.now() }).returning(memberFields))[0]);
        await audit(tx, context, 'member.created', 'member', row.id); return member(row);
      });
    },
    async updateMember(context: MutationContext, id: string, input: c.UpdateMemberRequest) {
      const { revision, ...changes } = c.updateMemberRequestSchema.parse(input);
      if (changes.photoKey) throw new AppError('invalid_request', 'Use the photo upload endpoint');
      return scope(context.gymId, async (tx) => {
        editable(await getMemberRow(tx, id)); const guard = revisionGuard(members.revision, revision);
        const row = assertRevised(await tx.update(members).set({ ...changes, revision: guard.next }).where(and(eq(members.id, id), guard.matches, isNull(members.anonymizedAt))).returning(memberFields));
        await audit(tx, context, 'member.updated', 'member', id); return member(row);
      });
    },
    async getMedicalNotes(gymId: string, id: string) {
      return scope(gymId, async (tx) => c.memberMedicalNotesSchema.parse(missing((await tx.select({ id: members.id, medicalNotes: members.medicalNotes, revision: members.revision }).from(members).where(eq(members.id, id)))[0])));
    },
    async updateMedicalNotes(context: MutationContext, id: string, input: c.UpdateMemberMedicalNotesRequest) {
      const { revision, medicalNotes } = c.updateMemberMedicalNotesRequestSchema.parse(input);
      return scope(context.gymId, async (tx) => {
        editable(await getMemberRow(tx, id)); const guard = revisionGuard(members.revision, revision);
        const row = assertRevised(await tx.update(members).set({ medicalNotes, revision: guard.next }).where(and(eq(members.id, id), guard.matches, isNull(members.anonymizedAt)))
          .returning({ id: members.id, medicalNotes: members.medicalNotes, revision: members.revision }));
        await audit(tx, context, 'member.medical_notes.updated', 'member', id); return c.memberMedicalNotesSchema.parse(row);
      });
    },
    async anonymizeMember(context: MutationContext, id: string, input: c.AnonymizeMemberRequest) {
      return (await service.eraseMember(context, id, input)).member;
    },
    /** Anonymizes the member and returns the storage keys it released, for the caller to mark deleted after commit. */
    async eraseMember(context: MutationContext, id: string, input: c.AnonymizeMemberRequest) {
      const { revision } = c.anonymizeMemberRequestSchema.parse(input);
      return scope(context.gymId, async (tx) => {
        const before = await getMemberRow(tx, id);
        const home = await getHouseholdRow(tx, before.householdId);
        editable(before); const guard = revisionGuard(members.revision, revision), now = clock.now();
        const row = assertRevised(await tx.update(members).set({ firstName: 'Anonymized', lastName: 'Member', email: null, phone: null, dateOfBirth: null,
          photoKey: null, emergencyContacts: [], medicalNotes: null, emailOptOut: true, emailDeliverable: false, status: 'cancelled',
          checkinCodeHash: null, anonymizedAt: now, revision: guard.next })
          .where(and(eq(members.id, id), guard.matches, isNull(members.anonymizedAt))).returning(memberFields));
        await tx.delete(memberTagLinks).where(eq(memberTagLinks.memberId, id));
        // An erased member is never billed again: their memberships end with the erasure, in the same transaction.
        const open = await tx.select({ id: memberships.id, revision: memberships.revision }).from(memberships)
          .where(and(eq(memberships.memberId, id), ne(memberships.status, 'cancelled'))).for('update');
        for (const membership of open) {
          await tx.update(memberships).set({ status: 'cancelled', cancelledAt: now, resumesOn: null, revision: membership.revision + 1 })
            .where(eq(memberships.id, membership.id));
          await audit(tx, context, 'billing.membership.cancelled', 'membership', membership.id);
        }
        // Promotion history stays (ranks, dates, IDs); its free-text notes can name or describe the member.
        await tx.update(memberRanks).set({ notes: null }).where(eq(memberRanks.memberId, id));
        // Erasure on request removes signed waivers too: their snapshot, signature image and IP address.
        const waivers = await tx.delete(waiverSignatures).where(eq(waiverSignatures.memberId, id)).returning({ key: waiverSignatures.signatureImageKey });
        await tx.delete(householdUsers).where(eq(householdUsers.memberId, id));
        await tx.update(signedLinks).set({ revokedAt: now }).where(and(eq(signedLinks.memberId, id), isNull(signedLinks.revokedAt)));
        const remaining = await tx.select({ id: members.id }).from(members).where(and(eq(members.householdId, home.id), isNull(members.anonymizedAt))).limit(1);
        const last = remaining.length === 0;
        const homeGuard = revisionGuard(households.revision, home.revision);
        await tx.update(households).set({ pinHash: null, revision: homeGuard.next,
          ...(last ? { name: 'Anonymized household', email: null, phone: null, address: {} } : {}) }).where(eq(households.id, home.id));
        if (last) {
          await tx.delete(householdUsers).where(eq(householdUsers.householdId, home.id));
          await tx.update(signedLinks).set({ revokedAt: now }).where(and(eq(signedLinks.householdId, home.id), isNull(signedLinks.revokedAt)));
        }
        await audit(tx, context, 'member.anonymized', 'member', id);
        if (waivers.length) await audit(tx, context, 'member.waivers.deleted', 'member', id);
        await audit(tx, context, last ? 'household.anonymized' : 'household.pin.cleared', 'household', home.id);
        return { member: member(row), files: [...(before.photoKey ? [before.photoKey] : []), ...waivers.map((waiver) => waiver.key)] };
      });
    },
    async listHouseholds(gymId: string, input: c.HouseholdListQuery) {
      const query = c.householdListQuerySchema.parse(input);
      return scope(gymId, async (tx) => {
        const where = query.search ? or(ilike(households.name, search(query.search)), ilike(households.email, search(query.search))) : undefined;
        const total = await tx.$count(households, where);
        const rows = await tx.select(householdFields).from(households).where(where).orderBy(asc(households.name), asc(households.id)).limit(query.limit).offset(query.offset);
        return { data: rows.map(household), pagination: { limit: query.limit, offset: query.offset, total } };
      });
    },
    async getHousehold(gymId: string, id: string) { return scope(gymId, async (tx) => household(await getHouseholdRow(tx, id))); },
    async createHousehold(context: MutationContext, input: c.CreateHouseholdRequest) {
      const data = c.createHouseholdRequestSchema.parse(input);
      return scope(context.gymId, async (tx) => {
        const row = missing((await tx.insert(households).values({ ...data, id: uuidv7(), gymId: context.gymId, createdAt: clock.now() }).returning(householdFields))[0]);
        await audit(tx, context, 'household.created', 'household', row.id); return household(row);
      });
    },
    async updateHousehold(context: MutationContext, id: string, input: c.UpdateHouseholdRequest) {
      const { revision, ...changes } = c.updateHouseholdRequestSchema.parse(input);
      return scope(context.gymId, async (tx) => {
        await getHouseholdRow(tx, id); const guard = revisionGuard(households.revision, revision);
        const row = assertRevised(await tx.update(households).set({ ...changes, revision: guard.next }).where(and(eq(households.id, id), guard.matches)).returning(householdFields));
        await audit(tx, context, 'household.updated', 'household', id); return household(row);
      });
    },
    /** Only unused households can be deleted; accounting and member references always survive. */
    async deleteHousehold(context: MutationContext, id: string, revision: number) {
      c.revisionSchema.parse(revision);
      try {
        return await scope(context.gymId, async (tx) => {
          await getHouseholdRow(tx, id);
          for (const table of [members, invoices, householdUsers, signedLinks]) {
            if ((await tx.select({ id: table.id }).from(table).where(eq(table.householdId, id)).limit(1)).length)
              throw new AppError('conflict', 'Only unused households can be deleted');
          }
          const guard = revisionGuard(households.revision, revision);
          assertRevised(await tx.delete(households).where(and(eq(households.id, id), guard.matches)).returning({ id: households.id }));
          await audit(tx, context, 'household.deleted', 'household', id);
        });
      } catch (error) {
        if (databaseCode(error) === '23503') throw new AppError('conflict', 'Only unused households can be deleted');
        throw error;
      }
    },
    async getHouseholdBilling(gymId: string, id: string) {
      return scope(gymId, async (tx) => c.householdBillingSettingsSchema.parse(missing((await tx.select(billingFields).from(households).where(eq(households.id, id)))[0])));
    },
    async updateHouseholdBilling(context: MutationContext, id: string, input: c.UpdateHouseholdBillingSettingsRequest) {
      const { revision, ...changes } = c.updateHouseholdBillingSettingsRequestSchema.parse(input);
      return scope(context.gymId, async (tx) => {
        await getHouseholdRow(tx, id); const guard = revisionGuard(households.revision, revision);
        const row = assertRevised(await tx.update(households).set({ ...changes, revision: guard.next }).where(and(eq(households.id, id), guard.matches)).returning(billingFields));
        await audit(tx, context, 'household.billing.updated', 'household', id); return c.householdBillingSettingsSchema.parse(row);
      });
    },
    async setHouseholdPin(context: MutationContext, id: string, input: c.SetHouseholdPinRequest) {
      const { revision, pin } = c.setHouseholdPinRequestSchema.parse(input);
      // Resolve configuration before opening the transaction (the resolver may read the gym).
      await scope(context.gymId, (tx) => getHouseholdRow(tx, id));
      if (pin && !options.pinSecret) throw new AppError('unavailable', 'PIN secret resolver is not configured');
      const pinHash = pin ? hashHouseholdPin(await options.pinSecret!(context.gymId), context.gymId, id, pin) : null;
      return scope(context.gymId, async (tx) => {
        await getHouseholdRow(tx, id); const guard = revisionGuard(households.revision, revision);
        const row = assertRevised(await tx.update(households).set({ pinHash, revision: guard.next }).where(and(eq(households.id, id), guard.matches)).returning(householdFields));
        await audit(tx, context, 'household.pin.updated', 'household', id); return household(row);
      });
    },
    async listTags(gymId: string, input: c.Pagination) {
      const query = c.paginationSchema.parse(input);
      return scope(gymId, async (tx) => ({ data: (await tx.select(tagFields).from(memberTags).orderBy(asc(memberTags.name), asc(memberTags.id)).limit(query.limit).offset(query.offset)).map(tag),
        pagination: { ...query, total: await tx.$count(memberTags) } }));
    },
    async createTag(context: MutationContext, input: c.CreateMemberTagRequest) {
      const data = c.createMemberTagRequestSchema.parse(input);
      return scope(context.gymId, async (tx) => {
        // Let the unique key settle concurrent creates without disclosing database details.
        const row = (await tx.insert(memberTags).values({ ...data, id: uuidv7(), gymId: context.gymId, createdAt: clock.now() }).onConflictDoNothing().returning(tagFields))[0];
        if (!row) throw new AppError('conflict', 'Tag already exists');
        await audit(tx, context, 'member_tag.created', 'member_tag', row.id); return tag(row);
      });
    },
    async updateTag(context: MutationContext, id: string, input: c.UpdateMemberTagRequest) {
      const { revision, ...changes } = c.updateMemberTagRequestSchema.parse(input);
      try { return await scope(context.gymId, async (tx) => {
        missing((await tx.select({ id: memberTags.id }).from(memberTags).where(eq(memberTags.id, id)))[0]);
        const guard = revisionGuard(memberTags.revision, revision);
        const row = assertRevised(await tx.update(memberTags).set({ ...changes, revision: guard.next }).where(and(eq(memberTags.id, id), guard.matches)).returning(tagFields));
        await audit(tx, context, 'member_tag.updated', 'member_tag', id); return tag(row);
      }); } catch (error) {
        if (databaseCode(error) === '23505') throw new AppError('conflict', 'Tag already exists');
        throw error;
      }
    },
    async deleteTag(context: MutationContext, id: string, revision: number) {
      c.revisionSchema.parse(revision);
      return scope(context.gymId, async (tx) => {
        missing((await tx.select({ id: memberTags.id }).from(memberTags).where(eq(memberTags.id, id)).for('update'))[0]);
        await tx.delete(memberTagLinks).where(eq(memberTagLinks.tagId, id));
        const guard = revisionGuard(memberTags.revision, revision);
        assertRevised(await tx.delete(memberTags).where(and(eq(memberTags.id, id), guard.matches)).returning({ id: memberTags.id }));
        await audit(tx, context, 'member_tag.deleted', 'member_tag', id);
      });
    },
    async listMemberTags(gymId: string, id: string) {
      return scope(gymId, async (tx) => {
        await getMemberRow(tx, id);
        return (await tx.select(tagFields).from(memberTags).innerJoin(memberTagLinks, eq(memberTagLinks.tagId, memberTags.id))
          .where(eq(memberTagLinks.memberId, id)).orderBy(asc(memberTags.name), asc(memberTags.id))).map(tag);
      });
    },
    async addTag(context: MutationContext, id: string, input: c.AddMemberTagRequest) {
      const { tagId } = c.addMemberTagRequestSchema.parse(input);
      return scope(context.gymId, async (tx) => {
        // Serialize tag changes with anonymization so no association can be added afterwards.
        const row = missing((await tx.select({ anonymizedAt: members.anonymizedAt }).from(members).where(eq(members.id, id)).for('update'))[0]); editable(row);
        missing((await tx.select({ id: memberTags.id }).from(memberTags).where(eq(memberTags.id, tagId)).for('key share'))[0]);
        const added = (await tx.insert(memberTagLinks).values({ id: uuidv7(), gymId: context.gymId, memberId: id, tagId, createdAt: clock.now() }).onConflictDoNothing().returning(linkFields))[0];
        if (added) { await audit(tx, context, 'member.tag.added', 'member', id); return link(added); }
        return link(missing((await tx.select(linkFields).from(memberTagLinks).where(and(eq(memberTagLinks.memberId, id), eq(memberTagLinks.tagId, tagId))))[0]));
      });
    },
    async removeTag(context: MutationContext, id: string, tagId: string) {
      return scope(context.gymId, async (tx) => {
        await getMemberRow(tx, id);
        missing((await tx.select({ id: memberTags.id }).from(memberTags).where(eq(memberTags.id, tagId)))[0]);
        const removed = await tx.delete(memberTagLinks).where(and(eq(memberTagLinks.memberId, id), eq(memberTagLinks.tagId, tagId))).returning({ id: memberTagLinks.id });
        if (removed.length) await audit(tx, context, 'member.tag.removed', 'member', id);
      });
    },
    /** Internal photo compare-and-set: only the photo service may supply a generated storage key. */
    async attachPhoto(context: MutationContext, id: string, revision: number, photoKey: string) {
      if (!photoKey.startsWith(`${context.gymId}/members/${id}/`)) throw new AppError('invalid_request', 'Invalid photo key');
      return scope(context.gymId, async (tx) => {
        editable(await getMemberRow(tx, id)); const guard = revisionGuard(members.revision, c.revisionSchema.parse(revision));
        const row = assertRevised(await tx.update(members).set({ photoKey, revision: guard.next }).where(and(eq(members.id, id), guard.matches, isNull(members.anonymizedAt))).returning(memberFields));
        await audit(tx, context, 'member.photo.updated', 'member', id); return member(row);
      });
    },
    /** Invalidates any unfinished attachment before storage retires its immutable key. */
    async retireUnusedPhoto(context: MutationContext, id: string, key: string) {
      if (!key.startsWith(`${context.gymId}/members/${id}/`)) throw new AppError('invalid_request', 'Invalid photo key');
      return scope(context.gymId, async (tx) => {
        const [row] = await tx.select({ photoKey: members.photoKey, revision: members.revision }).from(members).where(eq(members.id, id)).for('update');
        if (row?.photoKey === key) return false;
        if (row) {
          const guard = revisionGuard(members.revision, row.revision);
          assertRevised(await tx.update(members).set({ revision: guard.next }).where(and(eq(members.id, id), guard.matches)).returning({ id: members.id }));
        }
        await audit(tx, context, 'member.photo.retired', 'member', id);
        return true;
      });
    },
  };
  return service;
}
export type MembersService = ReturnType<typeof createMembersService>;
