// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, ilike } from 'drizzle-orm';
import { forGym, staffProfiles, staffRoles, householdUsers, writeAudit, revisionGuard, assertRevised, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import type { CreateStaffProfileRequest, UpdateStaffProfileRequest, StaffProfileListQuery, GrantStaffRoleRequest, UpdateStaffRoleRequest, Pagination } from '@plaingym/shared/contracts';
import { lockMemberForWrite, memberWriteScope } from '../members/member-write.js';
import { removeUnprovenPassword } from '../../infra/auth/accounts.js';

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
/** Without these a role grant keeps the login's password, as for the photo service and the demo seed. */
export type StaffProfileServiceOptions = { readonly removesLeftoverPassword?: undefined } | {
  /** Whether a role granted now removes the login's password (the gym signs in by login link). */
  readonly removesLeftoverPassword: (gymId: string) => Promise<boolean>;
  /** The gym scope on the authentication connection, the only one that sees passwords; such a grant runs in it. */
  readonly credentialScope: typeof forGym;
};
export function createStaffProfileService(baseScope = forGym, options: StaffProfileServiceOptions = {}) {
  const scope = memberWriteScope(baseScope);
  const credentialScope = options.removesLeftoverPassword ? memberWriteScope(options.credentialScope) : scope;
  async function links(
    tx: Transaction, input: Pick<CreateStaffProfileRequest, 'userId' | 'memberId'>, options?: { allowErased?: boolean },
  ) {
    if (input.userId) {
      const [role] = await tx.select({ id: staffRoles.id }).from(staffRoles).where(eq(staffRoles.userId, input.userId));
      if (!role) throw new AppError('not_found', 'Staff account not found');
    }
    if (input.memberId) {
      const member = await lockMemberForWrite(tx, input.memberId, 'share');
      if (member.anonymizedAt) {
        if (options?.allowErased) return { erasedMemberId: input.memberId };
        throw new AppError('not_found', 'Member not found');
      }
    }
  }
  // Only attachPhoto passes a new key; requests may at most clear one, which is rechecked here for direct callers.
  async function saveProfile(actor: StaffActor, id: string, input: Omit<UpdateStaffProfileRequest, 'photoKey'> & { photoKey?: string | null | undefined }, photo = false) {
    if (typeof input.photoKey === 'string' && !photo) throw new AppError('invalid_request', 'Use the profile photo upload endpoint');
    return scope(actor.gymId, async (tx) => {
      await assertStaffManager(tx, actor.actorUserId);
      // Member deletion and erasure lock the member before unlinking profiles.
      // Keep missing-profile and stale-revision errors ahead of link validation errors.
      const link = await links(tx, input, { allowErased: true }).catch((error: unknown) => {
        if (error instanceof AppError) return error;
        throw error;
      });
      const [existing] = await tx.select().from(staffProfiles).where(eq(staffProfiles.id, id)).for('update');
      if (!existing) throw new AppError('not_found', 'Staff profile not found');
      if (existing.revision !== input.revision) throw new AppError('conflict', 'The record changed; reload before saving');
      if (link instanceof AppError) throw link;
      if (link && link.erasedMemberId !== existing.memberId) throw new AppError('not_found', 'Member not found');
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
      if ((input as { photoKey?: unknown }).photoKey !== undefined) throw new AppError('invalid_request', 'Use the profile photo upload endpoint');
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
      // Read before the transaction: the gym's mode may need its SMTP settings.
      const removePassword = await options.removesLeftoverPassword?.(actor.gymId) ?? false;
      // The role, its audit and the password removal commit together, in the scope that can see the password.
      return (removePassword ? credentialScope : scope)(actor.gymId, async (tx) => {
        await assertStaffManager(tx, actor.actorUserId);
        if (!['admin', 'coach', 'front_desk'].includes(input.role)) throw new AppError('forbidden', 'Owner assignment is not permitted');
        const linked = await tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.userId, input.userId));
        const profiles = await tx.select({ id: staffProfiles.id }).from(staffProfiles).where(eq(staffProfiles.userId, input.userId));
        const current = await tx.select().from(staffRoles).where(eq(staffRoles.userId, input.userId));
        if (!linked.length && !profiles.length && !current.length) throw new AppError('not_found', 'Gym account not found');
        const [row] = await tx.insert(staffRoles).values({ ...input, gymId: actor.gymId, createdAt: actor.clock.now() }).onConflictDoNothing().returning();
        if (!row) throw new AppError('conflict', 'Account already has a staff role');
        await staffAudit(tx, actor, 'staff.role_granted', 'staff_role', row.id);
        // Outside password mode a password nobody proved must never sign in as staff. In password mode the grant
        // trusts the account's password, as the owner picked the account.
        if (removePassword) await removeUnprovenPassword(tx, { gymId: actor.gymId, userId: row.userId, actorUserId: actor.actorUserId, clock: actor.clock });
        return { data: staffRoleRecord(row) };
      });
    },
    async changeRole(actor: StaffActor, id: string, input: UpdateStaffRoleRequest | { revision: number }, revoke = false) {
      return scope(actor.gymId, async (tx) => {
        const roles = await assertStaffManager(tx, actor.actorUserId), existing = roles.find((row) => row.id === id);
        if (!existing) throw new AppError('not_found', 'Staff role not found');
        if (existing.role === 'owner' || ('role' in input && !['admin', 'coach', 'front_desk'].includes(input.role))) throw new AppError('forbidden', 'Owner changes are not permitted');
        if (existing.role === 'admin' && !roles.some(row => row.userId === actor.actorUserId && row.role === 'owner'))
          throw new AppError('forbidden', 'Only an owner may change or revoke an admin role');
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
