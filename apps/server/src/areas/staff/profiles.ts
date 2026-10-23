// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, ilike } from 'drizzle-orm';
import { forGym, staffProfiles, staffRoles, householdUsers, members, writeAudit, revisionGuard, assertRevised, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import type { CreateStaffProfileRequest, UpdateStaffProfileRequest, StaffProfileListQuery, GrantStaffRoleRequest, UpdateStaffRoleRequest, Pagination } from '@plaingym/shared/contracts';

export interface StaffActor { gymId: string; actorUserId: string; clock: Clock; }
/** Serialize management changes with role revocation, and recheck the caller in the write transaction. */
export async function assertStaffManager(tx: Transaction, actorUserId: string) {
  const roles = await tx.select().from(staffRoles).orderBy(staffRoles.id).for('update');
  if (!roles.some((row) => row.userId === actorUserId && ['owner', 'admin'].includes(row.role)))
    throw new AppError('forbidden', 'Staff management is not permitted');
  return roles;
}
export function staffRoleRecord(row: typeof staffRoles.$inferSelect) {
  return { id: row.id, userId: row.userId, role: row.role as 'owner' | 'admin' | 'coach' | 'front_desk', revision: row.revision, createdAt: row.createdAt.toISOString() };
}
function profileRecord(row: typeof staffProfiles.$inferSelect) {
  return { id: row.id, userId: row.userId, memberId: row.memberId, displayName: row.displayName,
    bio: row.bio, photoKey: row.photoKey, rank: row.rank, isPublic: row.isPublic, revision: row.revision, createdAt: row.createdAt.toISOString() };
}
export async function staffAudit(tx: Transaction, actor: StaffActor, action: string, targetType: string, targetId: string) {
  await writeAudit(tx, { gymId: actor.gymId, actorKind: 'user', actorUserId: actor.actorUserId, action, targetType, targetId, occurredAt: actor.clock.now() });
}
export function createStaffProfileService(scope = forGym) {
  async function links(tx: Transaction, input: CreateStaffProfileRequest | UpdateStaffProfileRequest) {
    if (input.userId) {
      const [role] = await tx.select({ id: staffRoles.id }).from(staffRoles).where(eq(staffRoles.userId, input.userId));
      if (!role) throw new AppError('not_found', 'Staff account not found');
    }
    if (input.memberId) {
      const [member] = await tx.select({ id: members.id }).from(members).where(eq(members.id, input.memberId));
      if (!member) throw new AppError('not_found', 'Member not found');
    }
  }
  async function saveProfile(actor: StaffActor, id: string, input: UpdateStaffProfileRequest, photo = false) {
    if (typeof input.photoKey === 'string' && !photo) throw new AppError('invalid_request', 'Use the profile photo upload endpoint');
    return scope(actor.gymId, async (tx) => {
      await assertStaffManager(tx, actor.actorUserId);
      const [existing] = await tx.select().from(staffProfiles).where(eq(staffProfiles.id, id)).for('update');
      if (!existing) throw new AppError('not_found', 'Staff profile not found');
      await links(tx, input);
      if (input.userId && (await tx.select({ id: staffProfiles.id }).from(staffProfiles).where(eq(staffProfiles.userId, input.userId))).some((row) => row.id !== id))
        throw new AppError('conflict', 'Account already has a staff profile');
      const guard = revisionGuard(staffProfiles.revision, input.revision);
      const row = assertRevised(await tx.update(staffProfiles).set({ ...input, revision: guard.next }).where(and(eq(staffProfiles.id, id), guard.matches)).returning());
      await staffAudit(tx, actor, photo ? 'staff.photo_uploaded' : 'staff.profile_updated', 'staff_profile', id);
      return { data: profileRecord(row) };
    });
  }
  return {
    async listProfiles(gymId: string, query: StaffProfileListQuery) {
      return scope(gymId, async (tx) => {
        const filter = and(query.userId ? eq(staffProfiles.userId, query.userId) : undefined,
          query.memberId ? eq(staffProfiles.memberId, query.memberId) : undefined,
          query.search ? ilike(staffProfiles.displayName, '%' + query.search.replace(/[\\%_]/g, '\\$&') + '%') : undefined);
        const total = await tx.$count(staffProfiles, filter);
        const rows = await tx.select().from(staffProfiles).where(filter).orderBy(staffProfiles.displayName, staffProfiles.id).limit(query.limit).offset(query.offset);
        return { data: rows.map(profileRecord), pagination: { limit: query.limit, offset: query.offset, total } };
      });
    },
    async getProfile(gymId: string, id: string) {
      return scope(gymId, async (tx) => {
        const [row] = await tx.select().from(staffProfiles).where(eq(staffProfiles.id, id));
        if (!row) throw new AppError('not_found', 'Staff profile not found');
        return { data: profileRecord(row) };
      });
    },
    async createProfile(actor: StaffActor, input: CreateStaffProfileRequest) {
      if (typeof input.photoKey === 'string') throw new AppError('invalid_request', 'Use the profile photo upload endpoint');
      return scope(actor.gymId, async (tx) => {
        await assertStaffManager(tx, actor.actorUserId); await links(tx, input);
        const [row] = await tx.insert(staffProfiles).values({ ...input, gymId: actor.gymId, createdAt: actor.clock.now() }).onConflictDoNothing().returning();
        if (!row) throw new AppError('conflict', 'Account already has a staff profile');
        await staffAudit(tx, actor, 'staff.profile_created', 'staff_profile', row.id);
        return { data: profileRecord(row) };
      });
    },
    async updateProfile(actor: StaffActor, id: string, input: UpdateStaffProfileRequest) {
      return saveProfile(actor, id, input);
    },
    /** Only the photo service attaches keys it has just written for this profile. */
    async attachPhoto(actor: StaffActor, id: string, revision: number, key: string) {
      if (!key.startsWith(`${actor.gymId}/staff/${id}/`) || !/^[a-f0-9-]+$/.test(key.slice(`${actor.gymId}/staff/${id}/`.length)))
        throw new AppError('invalid_request', 'Invalid profile photo key');
      return saveProfile(actor, id, { revision, photoKey: key }, true);
    },
    async listRoles(gymId: string, page: Pagination) {
      return scope(gymId, async (tx) => ({ data: (await tx.select().from(staffRoles).orderBy(staffRoles.createdAt, staffRoles.id).limit(page.limit).offset(page.offset)).map(staffRoleRecord),
        pagination: { ...page, total: await tx.$count(staffRoles) } }));
    },
    async grantRole(actor: StaffActor, input: GrantStaffRoleRequest) {
      return scope(actor.gymId, async (tx) => {
        await assertStaffManager(tx, actor.actorUserId);
        if (!['admin', 'coach', 'front_desk'].includes(input.role)) throw new AppError('forbidden', 'Owner assignment is not permitted');
        const linked = await tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.userId, input.userId));
        const profiles = await tx.select({ id: staffProfiles.id }).from(staffProfiles).where(eq(staffProfiles.userId, input.userId));
        const current = await tx.select().from(staffRoles).where(eq(staffRoles.userId, input.userId));
        if (!linked.length && !profiles.length && !current.length) throw new AppError('not_found', 'Gym account not found');
        const [row] = await tx.insert(staffRoles).values({ ...input, gymId: actor.gymId, createdAt: actor.clock.now() }).onConflictDoNothing().returning();
        if (!row) throw new AppError('conflict', 'Account already has a staff role');
        await staffAudit(tx, actor, 'staff.role_granted', 'staff_role', row.id);
        return { data: staffRoleRecord(row) };
      });
    },
    async changeRole(actor: StaffActor, id: string, input: UpdateStaffRoleRequest | { revision: number }, revoke = false) {
      return scope(actor.gymId, async (tx) => {
        const roles = await assertStaffManager(tx, actor.actorUserId), existing = roles.find((row) => row.id === id);
        if (!existing) throw new AppError('not_found', 'Staff role not found');
        if (existing.role === 'owner' || ('role' in input && !['admin', 'coach', 'front_desk'].includes(input.role))) throw new AppError('forbidden', 'Owner changes are not permitted');
        const guard = revisionGuard(staffRoles.revision, input.revision), where = and(eq(staffRoles.id, id), guard.matches);
        if (revoke) {
          assertRevised(await tx.delete(staffRoles).where(where).returning());
          await staffAudit(tx, actor, 'staff.role_revoked', 'staff_role', id);
          return null;
        }
        if (!('role' in input)) throw new AppError('invalid_request', 'Role required');
        const row = assertRevised(await tx.update(staffRoles).set({ role: input.role, revision: guard.next }).where(where).returning());
        await staffAudit(tx, actor, 'staff.role_changed', 'staff_role', id);
        return staffRoleRecord(row);
      });
    },
  };
}
